// Read-only access to a repo's CodeGraph index (.codegraph/codegraph.db) plus the
// source-text helpers the other core modules share. Everything is loaded into
// memory once: a few thousand nodes and tens of thousands of edges.

import { freshIndex } from "./indexer.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// Edge kinds that mean "this code uses that symbol".
export const USE_KINDS = new Set(["calls", "references", "instantiates"]);
// Node kinds that can be a callee or a shared feature symbol.
export const SYMBOL_KINDS = new Set(["function", "method", "class", "constant", "variable", "component"]);

export const isTestFile = (f) => /(^|\/)(e2e|__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(f);

export function openGraph(repo) {
  repo = path.resolve(repo);
  const dbPath = path.join(repo, ".codegraph", "codegraph.db");
  if (!fs.existsSync(dbPath)) throw new Error(`No code index at ${dbPath}. Run \`veridic init\` in the repo first.`);
  freshIndex(repo); // line numbers must come from the code as it is now
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const nodes = new Map();
  const nodesByFile = new Map();
  for (const n of db.prepare(`select id, kind, name, file_path file, start_line start, end_line end from nodes where kind not in ('import')`).all()) {
    nodes.set(n.id, n);
    if (!nodesByFile.has(n.file)) nodesByFile.set(n.file, []);
    nodesByFile.get(n.file).push(n);
  }

  // Use-edges grouped by source file, so a line range can collect the edges of
  // every node inside it (route nodes, nested functions, the file node itself).
  const usesByFile = new Map();
  const usersByTarget = new Map(); // target id -> [use]
  const inFiles = new Map(); // target id -> Set(source files)
  for (const e of db.prepare(`select source, target, kind, line from edges where kind in ('calls','references','instantiates')`).all()) {
    const s = nodes.get(e.source);
    const t = nodes.get(e.target);
    if (!s || !t) continue;
    const rec = { source: s, target: t, kind: e.kind, line: e.line };
    if (!usesByFile.has(s.file)) usesByFile.set(s.file, []);
    usesByFile.get(s.file).push(rec);
    if (!usersByTarget.has(t.id)) usersByTarget.set(t.id, []);
    usersByTarget.get(t.id).push(rec);
    if (s.file !== t.file) {
      if (!inFiles.has(t.id)) inFiles.set(t.id, new Set());
      inFiles.get(t.id).add(s.file);
    }
  }

  const files = db.prepare(`select path from files`).all().map((r) => r.path);
  const text = cache((rel) => {
    try {
      return fs.readFileSync(path.join(repo, rel), "utf8");
    } catch {
      return null;
    }
  });
  const lines = cache((rel) => text(rel)?.split("\n") ?? []);

  /** Targets of every use-edge whose site lies in file:[start,end]. */
  const usesInRange = (file, start, end) => {
    const out = [];
    for (const u of usesByFile.get(file) ?? []) {
      const s = u.source;
      const site = u.line ?? (s.kind === "file" ? null : s.start);
      const inside = site != null ? site >= start && site <= end : false;
      // Edges without a line belong to their source node; count them when the
      // source node is nested in the range.
      const nested = u.line == null && s.kind !== "file" && s.start >= start && s.end <= end;
      if (inside || nested) out.push(u);
    }
    return out;
  };

  /** Number of distinct other files that use a node. */
  const inDegree = (id) => inFiles.get(id)?.size ?? 0;

  /** Innermost named symbol node enclosing a line, if any. */
  const enclosing = (file, line) => {
    let best = null;
    for (const n of nodesByFile.get(file) ?? []) {
      if (n.kind === "file" || !SYMBOL_KINDS.has(n.kind)) continue;
      if (n.start <= line && n.end >= line && (!best || n.end - n.start < best.end - best.start)) best = n;
    }
    return best;
  };

  /** Innermost symbol that uses a node, per use site: [{ node, file, line }]. */
  const usersOf = (id) =>
    (usersByTarget.get(id) ?? []).map((u) => {
      const line = u.line ?? u.source.start;
      const node = u.source.kind === "file" || u.source.kind === "route" ? enclosing(u.source.file, line) : u.source;
      return { node, file: u.source.file, line };
    });

  return { repo, db, dbPath, nodes, nodesByFile, files, text, lines, usesInRange, usersOf, inDegree, enclosing, close: () => db.close() };
}

export function cache(fn) {
  const m = new Map();
  return (k) => {
    if (!m.has(k)) m.set(k, fn(k));
    return m.get(k);
  };
}

// ---------------------------------------------------------------------------
// Source scanning. Small and forgiving: it skips strings, template literals and
// comments, which is all paren matching and literal extraction need.

/**
 * Walks `src` from `from`, calling visit(i, ch) for every code character and
 * onString(start, end, quote) for each string literal. Returns nothing.
 */
export function scan(src, from, visit, onString = () => {}) {
  const tplDepth = []; // brace depth at which each open `${` returns to a template
  let brace = 0;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return;
      continue;
    }
    if (c === "/" && n === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) return;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) if (src[i] === "\\") i++;
      onString(start, i, c);
      continue;
    }
    if (c === "`" || (c === "}" && tplDepth.length && tplDepth.at(-1) === brace)) {
      // A chunk that resumes after `${...}` belongs to an interpolated template
      // and is never reported as a literal.
      const resumed = c === "}";
      if (resumed) tplDepth.pop();
      const start = i;
      for (i++; i < src.length && src[i] !== "`"; i++) {
        if (src[i] === "\\") i++;
        else if (src[i] === "$" && src[i + 1] === "{") {
          tplDepth.push(brace);
          i++;
          break;
        }
      }
      if (src[i] === "`" && !resumed) onString(start, i, "`");
      continue;
    }
    if (c === "{") brace++;
    if (c === "}") brace--;
    if (visit(i, c) === false) return;
  }
}

/** Index of the `)` matching the `(` at `open`, or -1. */
export function matchParen(src, open) {
  let depth = 0;
  let end = -1;
  scan(src, open, (i, c) => {
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) {
      end = i;
      return false;
    }
  });
  return end;
}

export const lineAt = (src, idx) => {
  let n = 1;
  for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
};
/** Offset of the first character of a 1-based line; src.length past the end. */
export const offsetOfLine = (src, line) => {
  let idx = 0;
  for (let n = 1; n < line; n++) {
    const nl = src.indexOf("\n", idx);
    if (nl < 0) return src.length;
    idx = nl + 1;
  }
  return idx;
};

/** Extent [startLine, endLine] of the call whose name starts on `line`, e.g. `router.post(`. */
export function callExtent(src, line, callRe = /\b[\w$.]+\s*\(/g) {
  const from = offsetOfLine(src, line);
  callRe.lastIndex = from;
  const m = callRe.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matchParen(src, open);
  return close < 0 ? null : [lineAt(src, m.index), lineAt(src, close)];
}

/** String literals in src[from..to) as { value, start, end } (quote offsets), comments excluded. */
export function literalSpans(src, from = 0, to = src.length) {
  const out = [];
  scan(
    src.slice(0, to),
    from,
    () => {},
    (s, e, q) => {
      if (q !== "`" || !src.slice(s, e).includes("${")) out.push({ value: src.slice(s + 1, e), start: s, end: e });
    },
  );
  return out;
}

/** String literal values (without quotes) in src[from..to), comments excluded. */
export const stringLiterals = (src, from, to) => literalSpans(src, from, to).map((l) => l.value);

/** Source with comments and strings blanked to spaces (same offsets, newlines kept). */
export function codeOnly(src) {
  const out = src.split("");
  let last = 0;
  scan(src, 0, (i) => {
    for (let k = last; k < i; k++) if (out[k] !== "\n") out[k] = " ";
    last = i + 1;
  });
  for (let k = last; k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  return out.join("");
}
