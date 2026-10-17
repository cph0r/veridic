// Parse and resolve `[evidence: path:line(-line)]` citations in a spec. Each
// result carries the cited text so the agent can re-read the claim against the
// code. Ported from recover/check-citations.mjs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lineMentions } from "./anchors.mjs";

// A requirement's label: **FR-001**, a table row | FR-001 |, a list item - FR-001:, or a heading ### FR-1: Title.
const LABEL = /\*\*((?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?)\*\*|^\s*\|\s*((?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?)\s*\||^\s*(?:-|\d+\.)\s*((?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?)\s*[:.]|^#{1,6}\s+((?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?)\s*[:.\-–—]/;
const MAX_TEXT_LINES = 40;

/**
 * Parse a spec into citations.
 * @returns {{ aliases: Record<string,string>, bases: string[], citations: { fr, spec_line, cite, file, start, end, bad? }[], seams: { fr, file }[] }}
 */
export function parseSpec(spec) {
  // Legend: `crud` = `routes/public/orders/crud.ts`; "Paths are relative to `artifacts/api-server/src/`".
  const aliases = Object.fromEntries([...spec.matchAll(/`([\w.-]+)`\s*=\s*`([^`]+)`/g)].map((m) => [m[1], m[2]]));
  const bases = [...spec.matchAll(/relative to\s+`([^`]+)`/gi)].map((m) => m[1].replace(/\/$/, ""));
  const citations = [];
  const seams = []; // `[seam: path, path]`: files a requirement may touch, before it cites any code
  let section = null; // last FR label seen, for citations in continuation lines
  let heading = null;
  spec.split("\n").forEach((line, i) => {
    const l = line.match(LABEL);
    const label = l ? (l[1] ?? l[2] ?? l[3] ?? l[4]) : null;
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (label) section = label;
    else if (h) {
      section = null;
      heading = h[1].trim();
    }
    for (const sm of line.matchAll(/\[seam:\s*([^\]]+)\]/g))
      for (const raw of sm[1].split(/[,;]\s*/)) if (raw.trim()) seams.push({ fr: label ?? section, file: raw.trim().replace(/^`|`$/g, "").replace(/:\d+(?:-\d+)?$/, "") });
    for (const ev of line.matchAll(/\[evidence:\s*([^\]]+)\]/g)) {
      for (const raw of ev[1].split(/[,;]\s*/)) {
        const cite = raw.trim();
        if (!cite) continue;
        // path:start(-end), optionally anchored to a symbol: path:start-end#name@line
        const m = cite.match(/^`?([^`\s:]+):(\d+)(?:\s*[-–]\s*(\d+))?(?:#([^@`\]]+)@(\d+))?`?$/);
        const fr = label ?? section ?? `${heading ?? "spec"} (line ${i + 1})`;
        if (!m) citations.push({ fr, spec_line: i + 1, cite, bad: "unparseable" });
        else
          citations.push({
            fr,
            spec_line: i + 1,
            cite,
            file: m[1],
            start: Number(m[2]),
            end: Number(m[3] ?? m[2]),
            ...(m[4] ? { anchor: { name: m[4].trim(), line: Number(m[5]) } } : {}),
          });
      }
    }
  });
  return { aliases, bases, citations, seams };
}

/** Repo files from git (falls back to a directory walk), without node_modules. */
export function repoFiles(repo) {
  try {
    // Tracked plus untracked-but-not-ignored, so a file not yet `git add`-ed can be cited.
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 })
      .split("\n")
      .filter((f) => f && !f.includes("node_modules/"));
  } catch {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(repo, d), { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const p = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk("");
    return out;
  }
}

/** Resolve a cited path: alias, then base-relative, then repo-relative, then a unique suffix match. */
export function makeResolver(repo, { aliases = {}, bases = [], files } = {}) {
  files ??= repoFiles(repo);
  const set = new Set(files);
  return (ref) => {
    const rel = (aliases[ref] ?? ref).replace(/^\.\//, "");
    for (const b of bases) if (set.has(path.posix.join(b, rel))) return { file: path.posix.join(b, rel) };
    if (set.has(rel)) return { file: rel };
    const hits = files.filter((f) => f.endsWith(`/${rel}`));
    if (hits.length === 1) return { file: hits[0] };
    return hits.length ? { ambiguous: hits.slice(0, 5) } : {};
  };
}

/**
 * Check every citation. `read(file)` returns the file's text (defaults to the
 * working tree), so callers can resolve against a git revision instead.
 */
export function checkCitations(repo, spec, opts = {}) {
  const parsed = parseSpec(spec);
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: [...(opts.bases ?? []), ...parsed.bases], files: opts.files });
  const read = opts.read ?? ((f) => fs.readFileSync(path.join(repo, f), "utf8"));
  const cache = new Map();
  const results = parsed.citations.map((c) => {
    const base = { fr: c.fr, spec_line: c.spec_line, cite: c.cite };
    if (c.bad) return { ...base, resolves: false, problem: c.bad };
    const r = resolve(c.file);
    if (!r.file) return { ...base, resolves: false, problem: r.ambiguous ? "ambiguous file" : "file not found", ...(r.ambiguous ? { candidates: r.ambiguous } : {}) };
    if (!cache.has(r.file)) cache.set(r.file, read(r.file).split("\n"));
    const src = cache.get(r.file);
    const n = src.at(-1) === "" ? src.length - 1 : src.length;
    if (c.start < 1 || c.end > n || c.start > c.end) return { ...base, file: r.file, resolves: false, problem: `lines ${c.start}-${c.end} outside ${r.file} (${n} lines)` };
    const lines = src.slice(c.start - 1, c.end);
    const warnings = rangeWarnings(lines);
    if (c.anchor && !lineMentions(src, c.anchor.line, c.anchor.name)) warnings.push(`anchor line ${c.anchor.line} doesn't mention ${c.anchor.name}`);
    return {
      ...base,
      file: r.file,
      range: [c.start, c.end],
      ...(c.anchor ? { anchor: c.anchor } : {}),
      resolves: true,
      first_line: lines[0].trim(),
      text: lines.slice(0, MAX_TEXT_LINES).join("\n") + (lines.length > MAX_TEXT_LINES ? `\n… (${lines.length - MAX_TEXT_LINES} more lines)` : ""),
      ...(warnings.length ? { warnings } : {}),
    };
  });
  const resolving = results.filter((r) => r.resolves).length;
  const warned = results.filter((r) => r.warnings).length;
  return {
    summary: { citations: results.length, resolving, unresolved: results.length - resolving, with_warnings: warned, requirements: new Set(results.map((r) => r.fr)).size },
    aliases: parsed.aliases,
    citations: results,
  };
}

/** Signs that a range is off by a few lines. */
export function rangeWarnings(lines) {
  const out = [];
  const first = lines[0].trim();
  if (!first) out.push("starts on a blank line");
  else if (/^[}\])]+[;,)]*$/.test(first) || /^\}\s*(?:else\b|catch\b|finally\b|\);?)?\s*$/.test(first)) out.push("starts on a closing brace");
  else if (/^import\s/.test(first) && lines.length === 1) out.push("cites an import line");
  if (lines.length > 150) out.push(`range is ${lines.length} lines; cite the specific lines`);
  return out;
}
