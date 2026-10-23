// Symbol anchors for citations: `[evidence: path:120-140#createOrder@26]` means
// "lines 120-140, inside the symbol createOrder, which started at line 26 when
// this was written". After a code change, CodeGraph's index says where
// createOrder starts now; the range moves by the same amount. A text check on
// the symbol's line catches an index that is older than the working tree.

import { freshIndex } from "./indexer.mjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const ANCHOR_KINDS = ["function", "method", "class", "constant", "variable", "component", "route"];

/** Anchor-able symbols per file, from the CodeGraph index. Routes get an extent up to the next route. */
export function openSymbols(repo) {
  const dbPath = path.join(repo, ".codegraph", "codegraph.db");
  if (!fs.existsSync(dbPath)) return null;
  freshIndex(repo);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare(`select name, kind, file_path file, start_line start, end_line end from nodes where kind in (${ANCHOR_KINDS.map(() => "?").join(",")})`)
    .all(...ANCHOR_KINDS);
  db.close();
  const byFile = new Map();
  for (const r of rows) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push({ ...r });
  }
  for (const [file, syms] of byFile) {
    const routes = syms.filter((s) => s.kind === "route").sort((a, b) => a.start - b.start);
    let length = Infinity;
    try {
      length = fs.readFileSync(path.join(repo, file), "utf8").split("\n").length;
    } catch {}
    routes.forEach((r, i) => (r.end = Math.max(r.end, (routes[i + 1]?.start ?? length + 1) - 1)));
  }
  return { byFile, inFile: (f) => byFile.get(f) ?? [] };
}

/** The smallest symbol whose extent contains [start, end], if its name is unique in the file. */
export function enclosingSymbol(symbols, file, start, end) {
  const syms = symbols.inFile(file);
  const inside = syms.filter((s) => s.start <= start && s.end >= end).sort((a, b) => a.end - a.start - (b.end - b.start));
  const best = inside[0];
  if (!best) return { problem: "no enclosing symbol" };
  if (syms.filter((s) => s.name === best.name).length > 1) return { problem: `symbol name ${best.name} is not unique in ${file}` };
  if (/[@\],;#]/.test(best.name)) return { problem: `symbol name ${best.name} has characters an anchor can't hold` };
  return { symbol: best };
}

// A declaration can wrap: `router.post(` on the symbol's line, its path on the next.
const MENTION_WINDOW = 3;

/**
 * Does the symbol's line (or the next couple, for a wrapped call) declare or
 * register it? Guards against a stale index.
 * @param src  the file's lines; `line` is 1-based
 */
export function lineMentions(src, line, name) {
  const text = src.slice(line - 1, line - 1 + MENTION_WINDOW).join("\n");
  if (!text) return false;
  const token = name.includes(" ") ? name.split(" ").at(-1) : name; // "POST /orders" -> "/orders"
  return text.includes(token);
}

/**
 * Where an anchored citation sits now.
 * @returns {{ file, start, end, anchor_line, shift } | { problem }}
 */
export function locateAnchor(symbols, repo, file, c) {
  const candidates = symbols.inFile(file).filter((s) => s.name === c.anchor.name);
  if (!candidates.length) return { problem: `symbol ${c.anchor.name} not found in ${file} (renamed or removed?)` };
  const sym = candidates.sort((a, b) => Math.abs(a.start - c.anchor.line) - Math.abs(b.start - c.anchor.line))[0];
  let src;
  try {
    src = fs.readFileSync(path.join(repo, file), "utf8").split("\n");
  } catch {
    return { problem: `cannot read ${file}` };
  }
  if (!lineMentions(src, sym.start, c.anchor.name)) return { problem: `index out of date for ${file}: line ${sym.start} doesn't mention ${c.anchor.name} (run codegraph sync)` };
  const shift = sym.start - c.anchor.line;
  return { file, start: c.start + shift, end: c.end + shift, anchor_line: sym.start, shift };
}

/** Rebuild a citation string, keeping the spec's own file reference (alias or path) unless the file moved. */
export function formatCite(ref, start, end, anchor, hash) {
  return `${ref}:${start}${end !== start ? `-${end}` : ""}${anchor ? `#${anchor.name}@${anchor.line}` : ""}${hash ? `~${hash}` : ""}`;
}

/**
 * Apply { spec_line, cite, replacement } edits to a spec. Each cite is replaced
 * once on its own line; with `anywhere`, a cite whose line has since moved (the
 * spec was edited) is replaced on the first line that still holds it.
 */
export function applyEdits(spec, edits, { anywhere = false } = {}) {
  const lines = spec.split("\n");
  let applied = 0;
  for (const e of edits) {
    let i = e.spec_line - 1;
    if (anywhere && !lines[i]?.includes(e.cite)) i = lines.findIndex((l) => l.includes(e.cite));
    const at = lines[i]?.indexOf(e.cite);
    if (at == null || at < 0) continue;
    lines[i] = lines[i].slice(0, at) + e.replacement + lines[i].slice(at + e.cite.length);
    applied++;
  }
  return { spec: lines.join("\n"), applied };
}
