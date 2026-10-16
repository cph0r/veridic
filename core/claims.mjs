// Claim check: do the literal facts a requirement states (identifiers, quoted
// messages, numbers) appear in the lines it cites? A fact found elsewhere in the
// cited file, but not in the cited lines, is the clearest sign of a citation
// pointing at the wrong lines. Deterministic; no model involved.

import fs from "node:fs";
import path from "node:path";
import { parseSpec, makeResolver } from "./citations.mjs";
import { enclosingSymbol } from "./anchors.mjs";

/**
 * Literal facts in one line of spec prose (citations and labels removed).
 * @returns {{ fact, kind: "code"|"string"|"number" }[]}
 */
export function extractFacts(text) {
  let t = text.replace(/\[evidence:[^\]]*\]/g, " ").replace(/\*\*[A-Z]+-?\d+[a-z]?\*\*:?/g, " ").replace(/^\s*\|\s*[A-Z]+-?\d+[a-z]?\s*\|/, " ");
  const out = new Map();
  const add = (fact, kind) => {
    if (!out.has(fact)) out.set(fact, { fact, kind });
  };
  // Whole tokens only: `POST /a/b` gives "/a/b"; a formula like `a = b × c` gives nothing,
  // since its words are paraphrase rather than literals.
  for (const m of t.matchAll(/`([^`]+)`/g))
    for (const v of m[1].trim().split(/\s+/))
      if (/^[\w$./:@-]+$/.test(v) && v.length >= 3 && !/^[A-Z]+$/.test(v)) add(v, /^\d+$/.test(v) ? "number" : "code");
  t = t.replace(/`[^`]*`/g, " ");
  for (const m of t.matchAll(/["“]([^"”\n]{4,})["”]/g)) {
    const v = m[1].split(/…|\.\.\./)[0].trim();
    if (v.length >= 4) add(v, "string");
  }
  t = t.replace(/["“][^"”\n]*["”]/g, " ");
  // Numbers of two or more digits (single digits are too common to mean anything).
  // A number with a unit ("10-second", "20 minutes") is usually written in other
  // units in code (10_000 ms, 1200 s), so it also matches its conversions.
  for (const m of t.matchAll(/(?<![\w.\-/])(\d{2,}(?:[,_]\d{3})*)(?![\w%])(?:[\s-]*([a-z]+))?/gi)) {
    const n = Number(m[1].replace(/[,_]/g, ""));
    const unit = (m[2] ?? "").toLowerCase();
    const scale = UNITS.find(([re]) => re.test(unit))?.[1];
    if (scale === null) continue; // a size or count in other terms ("24-hex-character"): can't be checked literally
    const alts = scale ? [...new Set([n, ...scale.map((k) => n * k)])].map(String) : [String(n)];
    add(String(n), "number");
    out.get(String(n)).alts = alts;
  }
  for (const f of out.values()) if (STOP.has(f.fact.toLowerCase())) out.delete(f.fact);
  return [...out.values()];
}

// Unit -> multipliers to try (to seconds, ms, ...); null = not checkable as a literal.
const UNITS = [
  [/^(ms|millis|milliseconds?)$/, []],
  [/^(s|secs?|seconds?)$/, [1000]],
  [/^(m|mins?|minutes?)$/, [60, 60000]],
  [/^(h|hrs?|hours?)$/, [60, 3600, 3600000]],
  [/^(d|days?)$/, [24, 86400, 86400000]],
  [/^(hex|chars?|characters?|digits?|bytes?|bits?)$/, null],
];
// Tokens too generic to tell anything about where a citation points.
const STOP = new Set(["true", "false", "null", "undefined", "get", "post", "put", "patch", "delete", "this", "that", "with", "from", "json", "string", "number", "object", "array", "error", "data", "body", "params", "query", "items", "item"]);

/**
 * For a plain lowercase word (a status value like `failed`), only a quoted
 * literal or an identifier counts, not the same word inside a message string.
 */
export function asCode(line, f) {
  if (f.kind !== "code" || !/^[a-z][a-z_]*$/.test(f.fact)) return true;
  const w = f.fact;
  return new RegExp(`(["'\`])${w}\\1|\\b${w}\\s*[:=(]|[.]${w}\\b`).test(line);
}

/** A comment or a log call: matches in it say nothing about behavior. */
export const isComment = (line) => /^\s*(\/\/|\*|\/\*|#)/.test(line) || /\b(log|logger|console)\.\w+\(/.test(line);

/** Code as a fact would be looked up in it: numeric separators and optional chaining removed. */
export const normalizeCode = (s) => s.replace(/(\d)_(?=\d)/g, "$1").replace(/\?\./g, ".");

/** Does a line of code contain this fact? Numbers match whole numbers only. */
export function lineHas(line, f) {
  if (line == null) return false;
  const code = normalizeCode(line);
  if (f.kind === "number") return (f.alts ?? [f.fact]).some((n) => new RegExp(`(?<![\\w.])${n}(?![\\w])`).test(code));
  return code.includes(f.fact);
}

/**
 * Recall of the check itself: shift every requirement's citations by `offset`
 * lines (planted mistakes) and count how many of the requirements that were
 * fully supported are now flagged.
 */
export function plantedOffsetRecall(repo, spec, offset, opts = {}) {
  const before = checkClaims(repo, spec, opts);
  const supported = new Set(before.lines.filter((l) => l.facts.every((f) => f.status === "cited")).map((l) => l.spec_line));
  const shifted = spec
    .split("\n")
    .map((line, i) =>
      supported.has(i + 1)
        ? line.replace(/\[evidence:([^\]]*)\]/g, (_, body) => `[evidence:${body.replace(/:(\d+)(?:-(\d+))?/g, (m, a, b) => `:${Number(a) + offset}${b ? `-${Number(b) + offset}` : ""}`)}]`)
        : line,
    )
    .join("\n");
  const after = checkClaims(repo, shifted, opts);
  const flagged = after.lines.filter((l) => supported.has(l.spec_line) && l.facts.some((f) => f.status !== "cited"));
  return { offset, planted: supported.size, detected: flagged.length, recall: supported.size ? Math.round((flagged.length / supported.size) * 1000) / 1000 : null };
}

/**
 * @returns {{ summary, lines: [{ fr, spec_line, facts: [{ fact, kind, status, at? }] }] }}
 *   status: "cited" (in the cited lines) | "elsewhere_in_file" (in a cited file, outside the
 *   cited lines: the citation is probably off) | "not_in_cited_files"
 */
export function checkClaims(repo, spec, opts = {}) {
  const parsed = parseSpec(spec);
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: [...(opts.bases ?? []), ...parsed.bases], files: opts.files });
  const read = opts.read ?? ((f) => fs.readFileSync(path.join(repo, f), "utf8"));
  const cache = new Map();
  const src = (f) => {
    if (!cache.has(f)) cache.set(f, read(f).split("\n"));
    return cache.get(f);
  };
  const specLines = spec.split("\n");

  // Group citations by the spec line that makes the claim.
  const byLine = new Map();
  for (const c of parsed.citations) {
    if (c.bad) continue;
    const file = resolve(c.file).file;
    if (!file) continue;
    if (!byLine.has(c.spec_line)) byLine.set(c.spec_line, { fr: c.fr, spec_line: c.spec_line, ranges: [] });
    byLine.get(c.spec_line).ranges.push({ file, start: c.start, end: c.end });
  }

  // Requirements by default; narrative lines (risks, edge cases) mention things in passing.
  const isRequirement = (fr) => /^(FR|SC|NFR|AC)-?\d+/.test(fr);
  const lines = [];
  for (const entry of byLine.values()) {
    if (!opts.all && !isRequirement(entry.fr)) continue;
    const facts = extractFacts(specLines[entry.spec_line - 1]).map((f) => {
      const inCited = entry.ranges.some((r) => src(r.file).slice(r.start - 1, r.end).some((l) => lineHas(l, f)));
      if (inCited) return { ...f, status: "cited" };
      // The subject of the claim: the route or function the cited lines sit inside
      // ("payment-confirm MUST …" citing lines in that handler).
      const subject = opts.symbols && entry.ranges.some((r) => {
        const enc = enclosingSymbol(opts.symbols, r.file, r.start, r.end).symbol;
        return enc && src(r.file).slice(enc.start - 1, enc.start + 2).some((l) => lineHas(l, f));
      });
      if (subject) return { ...f, status: "cited" };
      for (const file of new Set(entry.ranges.map((r) => r.file))) {
        const i = src(file).findIndex((l) => !isComment(l) && lineHas(l, f) && asCode(l, f));
        if (i >= 0) return { ...f, status: "elsewhere_in_file", at: `${file}:${i + 1}` };
      }
      return { ...f, status: "not_in_cited_files" };
    });
    if (facts.length) lines.push({ fr: entry.fr, spec_line: entry.spec_line, ranges: entry.ranges, facts });
  }

  const all = lines.flatMap((l) => l.facts);
  const count = (s) => all.filter((f) => f.status === s).length;
  return {
    summary: {
      claims: lines.length,
      claims_fully_supported: lines.filter((l) => l.facts.every((f) => f.status === "cited")).length,
      claims_with_misplaced_facts: lines.filter((l) => l.facts.some((f) => f.status === "elsewhere_in_file")).length,
      facts: all.length,
      facts_cited: count("cited"),
      facts_elsewhere_in_file: count("elsewhere_in_file"),
      facts_not_in_cited_files: count("not_in_cited_files"),
      support_rate: all.length ? Math.round((count("cited") / all.length) * 1000) / 1000 : null,
    },
    lines,
  };
}
