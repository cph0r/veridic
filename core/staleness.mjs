// Requirements a change affects: map `git diff --unified=0` hunks (old-side line
// ranges, renames and deletions) onto a spec's citation ranges. Citations are read
// as of the range's base, which is where the spec was last verified.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSpec, makeResolver } from "./citations.mjs";
import { locateAnchor, formatCite, applyEdits } from "./anchors.mjs";

const git = (repo, args) => {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`git ${args.join(" ")}: ${String(e.stderr ?? e.message).trim()}`);
  }
};
const hasRev = (repo, r) => {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/** Default range: the remote main branch if there is one, else the local one. */
export function defaultRange(repo) {
  const target = ["origin/main", "origin/master", "main", "master"].find((r) => hasRev(repo, r));
  if (!target) throw new Error("no origin/main, origin/master, main or master; pass --range");
  return `${target}...HEAD`;
}

/**
 * "A...B" -> base = merge-base(A, B), head = B; "A..B" -> A, B; "A" -> A vs the
 * working tree (head = null).
 */
export function resolveRange(repo, range) {
  const three = range.split("...");
  if (three.length === 2) return { base: git(repo, ["merge-base", three[0] || "HEAD", three[1] || "HEAD"]).trim(), head: rev(repo, three[1] || "HEAD") };
  const two = range.split("..");
  if (two.length === 2) return { base: rev(repo, two[0] || "HEAD"), head: rev(repo, two[1] || "HEAD") };
  return { base: rev(repo, range), head: null };
}
const rev = (repo, r) => git(repo, ["rev-parse", "--verify", `${r}^{commit}`]).trim();

/** Parse `git diff --unified=0 -M` output into per-file changes keyed by old path. */
export function parseDiff(text) {
  const files = new Map();
  let cur = null;
  for (const line of text.split("\n")) {
    const d = line.match(/^diff --git a\/(.*) b\/(.*)$/);
    if (d) {
      cur = { old: d[1], new: d[2], status: "modified", hunks: [] };
      files.set(cur.old, cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("rename from ")) {
      files.delete(cur.old);
      cur.old = line.slice(12);
      cur.status = "renamed";
      files.set(cur.old, cur);
    } else if (line.startsWith("rename to ")) cur.new = line.slice(10);
    else {
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (h) cur.hunks.push({ a: Number(h[1]), b: h[2] == null ? 1 : Number(h[2]), c: Number(h[3]), d: h[4] == null ? 1 : Number(h[4]), header: h[0] });
    }
  }
  return files;
}

/** Does a hunk touch old-side lines [start, end]? A pure insertion (b = 0) goes after line a. */
export const touches = (h, start, end) => (h.b === 0 ? h.a >= start && h.a < end : h.a <= end && h.a + h.b - 1 >= start);

/** New-side position of old line n, given hunks that do not touch it. */
export const shiftLine = (hunks, n) => n + hunks.filter((h) => (h.b === 0 ? h.a < n : h.a + h.b - 1 < n)).reduce((s, h) => s + h.d - h.b, 0);

/**
 * @param repo  repo path
 * @param spec  spec markdown
 * @param opts  { range (default origin/main...HEAD, falling back to main), bases: [] }
 */
export function staleness(repo, spec, opts = {}) {
  const range = opts.range ?? defaultRange(repo);
  const { base, head } = resolveRange(repo, range);
  const diffText = git(repo, ["diff", "--unified=0", "-M", "--no-color", "--no-ext-diff", base, ...(head ? [head] : [])]);
  const changes = parseDiff(diffText);

  const files = git(repo, ["ls-tree", "-r", "--name-only", base]).split("\n").filter(Boolean);
  const parsed = parseSpec(spec);
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: [...(opts.bases ?? []), ...parsed.bases], files });
  const lengths = new Map();
  const lengthAt = (f) => {
    if (!lengths.has(f)) lengths.set(f, git(repo, ["show", `${base}:${f}`]).replace(/\n$/, "").split("\n").length);
    return lengths.get(f);
  };

  const cited = new Map(); // file -> [[start, end]]
  const stale = [];
  const shifted = [];
  const unresolved = [];
  const fixes = []; // safe rewrites: the cited lines moved but did not change
  const conflicts = []; // anchor and diff disagree, or the anchor can't be found
  const symbols = opts.symbols ?? null; // from anchors.openSymbols(repo): the index as of now
  let untouched = 0;

  // Where the citation is now, by diff and (if anchored and indexed) by symbol.
  // A rewrite is proposed only when every available method agrees.
  const propose = (c, at, file, ch) => {
    const newFile = ch?.new ?? file;
    const byDiff = ch ? { start: shiftLine(ch.hunks, c.start), end: shiftLine(ch.hunks, c.end) } : { start: c.start, end: c.end };
    let anchor = c.anchor;
    let method = "diff";
    if (c.anchor && symbols) {
      const loc = locateAnchor(symbols, repo, newFile, c);
      if (loc.problem) return conflicts.push({ ...at, problem: loc.problem });
      if (loc.start !== byDiff.start || loc.end !== byDiff.end)
        return conflicts.push({ ...at, problem: `anchor says ${newFile}:${loc.start}-${loc.end}, diff says ${newFile}:${byDiff.start}-${byDiff.end}` });
      anchor = { name: c.anchor.name, line: loc.anchor_line };
      method = "anchor+diff";
    } else if (c.anchor && ch) anchor = { name: c.anchor.name, line: shiftLine(ch.hunks, c.anchor.line) };
    const replacement = formatCite(newFile === file ? c.file : newFile, byDiff.start, byDiff.end, anchor);
    if (replacement !== c.cite.replace(/^`|`$/g, "")) fixes.push({ ...at, replacement, method });
  };

  for (const c of parsed.citations) {
    const at = { fr: c.fr, spec_line: c.spec_line, cite: c.cite };
    const file = !c.bad && resolve(c.file).file;
    if (!file || c.start < 1 || c.end > lengthAt(file)) {
      unresolved.push({ ...at, problem: c.bad ?? (file ? `outside ${file} at base` : "file not found at base") });
      continue;
    }
    if (!cited.has(file)) cited.set(file, []);
    cited.get(file).push([c.start, c.end]);
    const ch = changes.get(file);
    if (!ch) {
      untouched++;
      // No diff for this file, but an anchor can still notice the index moved
      // (e.g. the diff range ends before the working tree).
      if (c.anchor && symbols) propose(c, at, file, null);
      continue;
    }
    if (ch.status === "deleted") {
      stale.push({ ...at, file, change: "deleted", hunk: null });
      continue;
    }
    const hit = ch.hunks.filter((h) => touches(h, c.start, c.end));
    const renamed = ch.status === "renamed" ? { renamed_to: ch.new } : {};
    if (hit.length) {
      stale.push({ ...at, file, change: "edited", ...renamed, hunk: hit.map((h) => h.header).join(" "), now: nowAt(ch, c) });
      continue;
    }
    if (ch.status === "renamed") {
      // Renamed with the cited lines intact: report it, and the path can be rewritten safely.
      shifted.push({ ...at, file, now: nowAt(ch, c), renamed_to: ch.new });
      propose(c, at, file, ch);
      continue;
    }
    const now = nowAt(ch, c);
    if (now !== `${file}:${c.start}-${c.end}`) {
      shifted.push({ ...at, file, now });
      propose(c, at, file, ch);
    } else {
      untouched++;
      if (c.anchor && symbols) propose(c, at, file, ch);
    }
  }

  // Changed lines in cited files that no citation covers: behavior the spec may
  // not describe yet (or lines it never needed to cite).
  const uncovered_hunks = [];
  for (const [file, ranges] of cited) {
    const ch = changes.get(file);
    if (!ch || ch.status === "deleted") continue;
    const loose = ch.hunks.filter((h) => !ranges.some(([a, b]) => touches(h, a, b)));
    if (loose.length) uncovered_hunks.push({ file, ...(ch.new !== file ? { now: ch.new } : {}), hunks: loose.map((h) => h.header) });
  }

  return {
    range,
    base,
    head: head ?? "working tree",
    summary: {
      citations: parsed.citations.length,
      stale: stale.length,
      stale_requirements: [...new Set(stale.map((s) => s.fr))],
      shifted: shifted.length,
      untouched,
      unresolved: unresolved.length,
      fixable: fixes.length,
      conflicts: conflicts.length,
      anchored: parsed.citations.filter((c) => c.anchor).length,
      files_changed: changes.size,
      cited_files_with_uncovered_changes: uncovered_hunks.length,
    },
    stale,
    shifted,
    fixes,
    conflicts,
    unresolved,
    uncovered_hunks,
  };
}

/**
 * CI check for a pull request: did the PR update the spec where its code
 * changes require it? Reads the spec as of the range's base (what the code
 * looked like when the spec was last right), finds what the diff affects, and
 * checks the head version of the spec: a moved citation must be rewritten, and
 * a stale requirement's line must have changed.
 * The same comparison against HEAD and the working tree is what keeps local
 * fixing idempotent: a fix already in the working spec is never applied twice.
 * @param specPath  repo-relative path of the spec
 * @param opts      { range, bases, symbols }
 * @returns {{ range, new_spec?, unaddressed, pending_fixes, addressed, result }}
 *   unaddressed: requirements whose code changed and whose line the spec hasn't touched
 *   pending_fixes: moved citations the spec hasn't rewritten yet (safe to apply)
 */
export function prCheck(repo, specPath, opts = {}) {
  const range = opts.range ?? defaultRange(repo);
  const { base, head } = resolveRange(repo, range);
  let specBase;
  try {
    specBase = git(repo, ["show", `${base}:${specPath}`]);
  } catch {
    return { range, new_spec: true, unaddressed: [], pending_fixes: [], addressed: 0 }; // new spec: nothing to keep in step yet
  }
  const specHead = head ? git(repo, ["show", `${head}:${specPath}`]) : fs.readFileSync(path.join(repo, specPath), "utf8");
  const result = staleness(repo, specBase, { ...opts, range, symbols: opts.symbols ?? null });
  const baseLines = specBase.split("\n");
  const frLine = (text, fr) => text.split("\n").find((l) => l.includes(`**${fr}**`) || new RegExp(`^\\s*\\|\\s*${fr}\\s*\\|`).test(l));
  const changed = (fr, spec_line) => {
    const before = frLine(specBase, fr) ?? baseLines[spec_line - 1];
    const after = frLine(specHead, fr);
    return after == null || after !== before; // removed or rewritten
  };
  // How often a citation string appears, so "it's gone" means rewritten, not just one of two copies.
  const count = (text, s) => text.split(s).length - 1;
  const unaddressed = [];
  const pending_fixes = [];
  let addressed = 0;
  for (const f of result.fixes) {
    if (specHead.includes(f.replacement) || count(specHead, f.cite) < count(specBase, f.cite)) addressed++;
    else pending_fixes.push({ ...f, need: `citation moved; update it to ${f.replacement}` });
  }
  for (const s of result.stale) {
    if (changed(s.fr, s.spec_line)) addressed++;
    else unaddressed.push({ fr: s.fr, cite: s.cite, need: `cited code was ${s.change}${s.hunk ? ` (${s.hunk})` : ""}; re-verify and update the requirement` });
  }
  return { range, unaddressed, pending_fixes, addressed, result };
}

/**
 * Bring one spec file in step with the working tree. A spec tracked in the repo
 * is compared as committed at HEAD (idempotent: safe to run on every commit or
 * agent turn). A spec outside the repo is taken to describe the range's base.
 * @returns {{ mode, spec, applied, open: [...], conflicts: [...], result }}
 */
export function syncSpec(repo, specFile, opts = {}) {
  const abs = path.resolve(specFile);
  const rel = path.relative(repo, abs);
  const current = fs.readFileSync(abs, "utf8");
  let tracked = false;
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    try {
      git(repo, ["ls-files", "--error-unmatch", "--", rel]);
      tracked = true;
    } catch {}
  }
  if (!tracked) {
    const { result, spec, applied } = fixSpec(repo, current, opts);
    return { mode: "outside repo (citations taken as of the range base)", spec, applied, open: result.stale, conflicts: result.conflicts, result };
  }
  const r = prCheck(repo, rel, { ...opts, range: opts.range ?? "HEAD" });
  if (r.new_spec) return { mode: "new spec (not yet committed)", spec: current, applied: 0, open: [], conflicts: [], result: null };
  const { spec, applied } = applyEdits(current, r.pending_fixes, { anywhere: true });
  return { mode: "tracked (compared with the committed spec)", spec, applied, open: r.unaddressed, conflicts: r.result.conflicts, result: r.result };
}

/**
 * Rewrite the citations that only moved (by diff, confirmed by anchor when the
 * index has one), and leave everything that needs judgement flagged.
 * @returns {{ result, spec, applied }}
 */
export function fixSpec(repo, spec, opts = {}) {
  const result = staleness(repo, spec, opts);
  const { spec: out, applied } = applyEdits(spec, result.fixes);
  return { result, spec: out, applied };
}

const nowAt = (ch, c) => `${ch.new}:${shiftLine(ch.hunks, c.start)}-${shiftLine(ch.hunks, c.end)}`;
