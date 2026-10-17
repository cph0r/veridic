// The repo's structure: how cleanly its modules are separated, and how much of its
// code is copied. Each problem comes with the places to fix, so it can become a next
// step for an agent, not just a score.
//
// Modularity: a table more than one module writes (a change to its rules has to be
// made in two places), modules that depend on each other in a loop, and a module most
// of the app depends on. Duplication: blocks of six or more meaningful lines that
// appear, unchanged apart from whitespace, in more than one place.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Modularity problems, from the modules (with their data) the report already found. */
export function modularity(modules) {
  const problems = [];
  const name = new Map(modules.map((m) => [m.id, m.name]));
  const own = new Map(modules.flatMap((m) => [...m.files, ...m.code].map((f) => [f, m.id])));
  for (const m of modules)
    for (const t of m.data?.owns ?? []) {
      // Only a write in the other module's own code counts: one that goes through the owner's
      // code or a shared helper is already the right shape.
      const at = Object.fromEntries(Object.entries(t.foreignWrites ?? {}).map(([o, locs]) => [o, locs.filter((l) => own.get(l.split(":")[0]) === o)]).filter(([, locs]) => locs.length));
      const others = Object.keys(at);
      if (others.length) problems.push({ kind: "shared-writes", table: t.table, owner: m.id, others, at, modules: [m.id, ...others] });
    }
  // Loops: A uses B and B uses A (directly). Longer loops are rarer and harder to act on.
  const uses = new Map(modules.map((m) => [m.id, new Map(m.uses.map((u) => [u.module, u.via]))]));
  for (const [a, out] of uses)
    for (const [b, via] of out)
      if (a < b && uses.get(b)?.has(a)) problems.push({ kind: "cycle", modules: [a, b], via: { [a]: via, [b]: uses.get(b).get(a) } });
  // A hub: more than half the other modules call into it. Not wrong in itself, but every change there is app-wide.
  for (const m of modules)
    if (modules.length >= 6 && m.usedBy.length > (modules.length - 1) / 2) problems.push({ kind: "hub", modules: [m.id], usedBy: m.usedBy.map((u) => u.module) });
  const touched = new Set(problems.filter((p) => p.kind !== "hub").flatMap((p) => p.modules));
  return {
    pct: modules.length ? Math.round(((modules.length - touched.size) / modules.length) * 100) : 100,
    clean: modules.length - touched.size,
    modules: modules.length,
    problems: problems.map((p) => ({ ...p, names: p.modules.map((id) => name.get(id) ?? id) })),
  };
}

const SRC = /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rb|java|kt|php|cs)$/;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|\.nuxt|\.codegraph|\.veridic|migrations?|drizzle|__generated__|generated|gen|fixtures?|mocks?|__mocks__|e2e|tests?|__tests__|static|examples?|samples?|demos?|codefixes)\//i;
const TEST = /\.(test|spec|stories|d)\.[cm]?[jt]sx?$|\.min\.js$|\.gen\.|\.generated\./;
const TRIVIAL = /^(?:[{}()[\];,]+|import\b.*|export\s*\{[^}]*\}\s*(?:from\b.*)?;?|\}?\s*else\s*\{?|return;?|break;?|\/\/.*|\/?\*.*|#.*|<\/?\w*>|\)\s*;?\s*\}?|["'`]use \w+["'`];?)$/;
const WINDOW = 6;

function listFiles(repo) {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Copied code: blocks of WINDOW+ meaningful lines that appear in more than one place.
 * Returns { pct, duplicated, total, blocks: [{ lines, a: {file,start,end}, b: {file,start,end}, more }] }.
 */
export function duplication(repo, { maxFiles = 6000 } = {}) {
  const files = listFiles(repo).filter((f) => SRC.test(f) && !SKIP.test(f) && !TEST.test(f)).slice(0, maxFiles);
  // Each file as its meaningful lines (trimmed, inner whitespace collapsed), with their real line numbers.
  const docs = [];
  let total = 0;
  for (const file of files) {
    let text;
    try {
      const st = fs.statSync(path.join(repo, file));
      if (st.size > 400_000) continue;
      text = fs.readFileSync(path.join(repo, file), "utf8");
    } catch {
      continue;
    }
    if (/@generated|auto-generated|do not edit/i.test(text.slice(0, 600))) continue;
    const lines = [], at = [];
    text.split("\n").forEach((l, i) => {
      const s = l.trim().replace(/\s+/g, " ");
      if (s.length < 4 || TRIVIAL.test(s)) return;
      lines.push(s);
      at.push(i + 1);
    });
    total += lines.length;
    docs.push({ file, lines, at });
  }
  // Index every window of WINDOW meaningful lines.
  const seen = new Map();
  docs.forEach((d, di) => {
    for (let i = 0; i + WINDOW <= d.lines.length; i++) {
      const key = d.lines.slice(i, i + WINDOW).join("\n");
      if (key.length < 120) continue; // six short lines (closing tags, `});`) aren't worth calling a copy
      const list = seen.get(key);
      if (list) list.push([di, i]);
      else seen.set(key, [[di, i]]);
    }
  });
  // Mark copied lines, and grow each pair of matching windows into the longest block.
  const dup = docs.map((d) => new Uint8Array(d.lines.length));
  const pairs = new Map();
  for (const list of seen.values()) {
    if (list.length < 2 || list.length > 30) continue; // 30+ copies is boilerplate, not something to merge
    for (const [di, i] of list) for (let k = 0; k < WINDOW; k++) dup[di][i + k] = 1;
    const [[da, ia], [db, ib]] = list;
    if (da === db && Math.abs(ia - ib) < WINDOW) continue;
    const key = da + ":" + db + ":" + (ia - ib);
    const p = pairs.get(key);
    if (!p) pairs.set(key, { da, db, ia, ib, end: ia + WINDOW, copies: list.length });
    else if (ia <= p.end) p.end = Math.max(p.end, ia + WINDOW);
    else if (ia - p.ia > (p.best ?? 0)) pairs.set(key + ":" + ia, { da, db, ia, ib, end: ia + WINDOW, copies: list.length });
  }
  const duplicated = dup.reduce((n, a) => n + a.reduce((x, y) => x + y, 0), 0);
  const blocks = [...pairs.values()].map((p) => {
    const n = p.end - p.ia, A = docs[p.da], B = docs[p.db];
    return { lines: n, copies: p.copies, a: { file: A.file, start: A.at[p.ia], end: A.at[p.end - 1] }, b: { file: B.file, start: B.at[p.ib], end: B.at[p.ib + n - 1] } };
  }).sort((x, y) => y.lines - x.lines);
  // One block per pair of places: windows of a long block can match at several offsets.
  const kept = [];
  for (const b of blocks) if (!kept.some((k) => k.a.file === b.a.file && k.b.file === b.b.file && b.a.start <= k.a.end && b.a.end >= k.a.start)) kept.push(b);
  return { pct: total ? Math.round((duplicated / total) * 1000) / 10 : 0, duplicated, total, files: docs.length, blocks: kept.slice(0, 60) };
}
