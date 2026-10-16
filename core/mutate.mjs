// Spec mutation score: if the code behind a requirement's facts changes, does the
// guard (`stale`) flag that requirement? Mutants are single-line edits to the
// lines that implement a fact: its occurrences inside the symbols the requirement
// cites, plus declarations in files the cited files import (a constant defined
// in cleanup.ts and used in crud.ts). Mutants inside cited lines are a sanity
// check (always caught); the informative ones are outside, where a miss means
// that behavior could change without anyone being told.
//
// A single-line in-place edit is flagged exactly when a citation of that
// requirement covers the line, so the score is computed directly; a random
// sample is replayed through the real guard on a throwaway clone to prove it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSpec, makeResolver } from "./citations.mjs";
import { checkClaims, lineHas } from "./claims.mjs";
import { enclosingSymbol } from "./anchors.mjs";
import { staleness } from "./staleness.mjs";

// A top-level config constant: `(export) const NAME(: T) = <value>` at column 0.
const CONST_DECL = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(.+)$/;
// Its value must be a pure literal: a numeric expression (10_000, 15 * 60 * 1000) or one string.
const PURE_VALUE = (v) => {
  const x = v.replace(/;?\s*(\/\/.*)?$/, "").replace(/\s+as\s+const$/, "").trim();
  return /^[-\d_.\s*+/()]+$/.test(x) && /\d/.test(x) || /^(["'`])[^"'`$]*\1$/.test(x);
};
const LITERAL = /(?<![\w.])\d[\d_]*(?:\.\d+)?(?![\w])|(["'`])(?:(?!\1).)+\1/;

/** Change the first literal on a line: a number gets +1, a string gets a suffix. */
export function mutateLiteral(line) {
  const eq = line.indexOf("=");
  const head = line.slice(0, eq + 1);
  const value = line.slice(eq + 1);
  const m = value.match(LITERAL);
  if (!m) return null;
  const lit = m[0];
  const next = /^\d/.test(lit) ? String(Number(lit.replace(/_/g, "")) + 1) : `${lit.slice(0, -1)}Mut${lit.slice(-1)}`;
  return head + value.slice(0, m.index) + next + value.slice(m.index + lit.length);
}

/** Relative imports of a file, resolved to repo files. */
function importsOf(repo, file, files) {
  const src = fs.readFileSync(path.join(repo, file), "utf8");
  const out = new Set();
  for (const m of src.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}/index.ts`]) if (files.has(c)) out.add(c);
  }
  return out;
}

/** The single-line edit that breaks a fact on this line, or null. */
export function mutateLine(line, f) {
  if (f.kind === "number") {
    // Match the number as written, digit separators included (10_000).
    const re = new RegExp(`(?<![\\w.])${f.fact.split("").join("_?")}(?![\\w])`);
    return re.test(line) ? line.replace(re, String(Number(f.fact) + 1)) : null;
  }
  const at = line.indexOf(f.fact);
  if (at < 0) {
    // Optional chaining in the code, plain dots in the spec.
    const alt = f.fact.replace(/\./g, "?.");
    return line.includes(alt) ? line.replace(alt, `${alt}Mut`) : null;
  }
  return line.slice(0, at + f.fact.length) + "Mut" + line.slice(at + f.fact.length);
}

/**
 * @param opts { symbols (anchors.openSymbols), validate: sample size (0 = skip), seed }
 */
export function mutationScore(repo, spec, opts = {}) {
  const parsed = parseSpec(spec);
  const files = new Set(execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean));
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: [...(opts.bases ?? []), ...parsed.bases], files: [...files] });
  const cache = new Map();
  const src = (f) => {
    if (!cache.has(f)) cache.set(f, fs.readFileSync(path.join(repo, f), "utf8").split("\n"));
    return cache.get(f);
  };

  // Every citation range of each requirement: what the guard watches for it.
  const watched = new Map();
  for (const c of parsed.citations) {
    const file = !c.bad && resolve(c.file).file;
    if (!file) continue;
    if (!watched.has(c.fr)) watched.set(c.fr, []);
    watched.get(c.fr).push({ file, start: c.start, end: c.end });
  }
  const covers = (fr, file, line) => (watched.get(fr) ?? []).some((r) => r.file === file && r.start <= line && r.end >= line);

  // 1. Sanity mutants: each fact on a line the requirement cites. Always caught;
  //    they prove the guard itself works.
  const claims = checkClaims(repo, spec, opts);
  const mutants = [];
  for (const claim of claims.lines) {
    for (const f of claim.facts) {
      if (f.status !== "cited") continue;
      const r = (watched.get(claim.fr) ?? []).find((x) => src(x.file).slice(x.start - 1, x.end).some((l) => lineHas(l, f)));
      if (!r) continue;
      const n = src(r.file).slice(r.start - 1, r.end).findIndex((l) => lineHas(l, f)) + r.start;
      const mutated = mutateLine(src(r.file)[n - 1], f);
      if (mutated) mutants.push({ type: "sanity", fr: claim.fr, fact: f.fact, file: r.file, line: n, caught: covers(claim.fr, r.file, n), original: src(r.file)[n - 1].trim().slice(0, 120), mutated });
    }
  }

  // 2. Dependency mutants: constants the cited lines use, defined with a literal
  //    value somewhere the requirement doesn't cite (same file or an imported one).
  //    Changing that value changes the behavior; a miss means the guard wouldn't notice.
  const decls = new Map(); // file -> Map(name -> line)
  const declsIn = (file) => {
    if (!decls.has(file)) {
      const m = new Map();
      src(file).forEach((l, i) => {
        const d = l.match(CONST_DECL);
        if (d && PURE_VALUE(d[2])) m.set(d[1], i + 1);
      });
      decls.set(file, m);
    }
    return decls.get(file);
  };
  for (const [fr, ranges] of watched) {
    const seen = new Set();
    for (const r of ranges) {
      const used = new Set(src(r.file).slice(r.start - 1, r.end).join("\n").match(/\b[A-Za-z_$][\w$]*\b/g) ?? []);
      for (const file of [r.file, ...importsOf(repo, r.file, files)]) {
        for (const [name, line] of declsIn(file)) {
          if (!used.has(name) || seen.has(`${file}:${line}`)) continue;
          seen.add(`${file}:${line}`);
          const original = src(file)[line - 1];
          const mutated = mutateLiteral(original);
          if (!mutated) continue;
          mutants.push({ type: "dependency", fr, fact: name, file, line, caught: covers(fr, file, line), original: original.trim().slice(0, 120), mutated });
        }
      }
    }
  }

  const validation = opts.validate ? validate(repo, spec, mutants, opts.validate, opts.seed ?? 1, opts.bases) : null;
  const deps = mutants.filter((m) => m.type === "dependency");
  const sanity = mutants.filter((m) => m.type === "sanity");
  const missed = deps.filter((m) => !m.caught);
  const byFr = new Map();
  for (const m of missed) {
    if (!byFr.has(m.fr)) byFr.set(m.fr, []);
    byFr.get(m.fr).push({ constant: m.fact, at: `${m.file}:${m.line}`, code: m.original });
  }
  const rate = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);
  return {
    summary: {
      requirements: watched.size,
      dependency_mutants: deps.length,
      dependency_caught: deps.length - missed.length,
      score: rate(deps.length - missed.length, deps.length),
      requirements_with_uncited_constants: byFr.size,
      sanity_mutants: sanity.length,
      sanity_caught: sanity.filter((m) => m.caught).length,
      ...(validation ? { validation: validation.summary } : {}),
    },
    missed: [...byFr.entries()].map(([fr, constants]) => ({ fr, constants })),
    ...(validation ? { validation_disagreements: validation.disagreements } : {}),
  };
}

/** Replay a random sample through the real guard on a throwaway clone. */
function validate(repo, spec, mutants, n, seed, bases = []) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pool = [...mutants];
  const sample = [];
  // Half dependency mutants (the interesting ones), the rest sanity mutants.
  const outside = pool.filter((m) => m.type === "dependency");
  const inside = pool.filter((m) => m.type === "sanity");
  const take = (arr, k) => {
    const a = [...arr];
    for (let i = 0; i < k && a.length; i++) sample.push(a.splice(Math.floor(rand() * a.length), 1)[0]);
  };
  take(outside, Math.ceil(n / 2));
  take(inside, n - sample.length);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-mutate-"));
  try {
    execFileSync("git", ["clone", "-q", "--shared", repo, tmp], { stdio: "ignore" });
    const disagreements = [];
    let agree = 0;
    for (const m of sample) {
      const p = path.join(tmp, m.file);
      const original = fs.readFileSync(p, "utf8");
      const lines = original.split("\n");
      lines[m.line - 1] = m.mutated;
      fs.writeFileSync(p, lines.join("\n"));
      const flagged = staleness(tmp, spec, { range: "HEAD", bases }).summary.stale_requirements.includes(m.fr);
      fs.writeFileSync(p, original);
      if (flagged === m.caught) agree++;
      else disagreements.push({ fr: m.fr, at: `${m.file}:${m.line}`, predicted: m.caught, guard: flagged });
    }
    return { summary: { sampled: sample.length, agree, agreement: sample.length ? Math.round((agree / sample.length) * 1000) / 1000 : null }, disagreements };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
