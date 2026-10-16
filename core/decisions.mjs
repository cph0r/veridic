// Decisions: why the code is the way it is. `whyOf` finds the commits that wrote
// a range of lines (git blame) with their messages, so a decision can cite the
// commit that made the call. `checkDecisions` verifies a spec's decisions against
// git: every cited commit exists and touched the files the decision cites, and
// decisions already committed are never edited, only superseded (append-only).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (repo, args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
const tryGit = (repo, args) => {
  try {
    return git(repo, args);
  } catch {
    return null;
  }
};
const COMMIT = /^commit:([0-9a-f]{7,40})$/;
const UNCOMMITTED = /^0{40}$/;

/**
 * The commits that wrote lines start..end of a file, most lines first.
 * @returns {{ file, range, uncommitted_lines, commits: { sha, short, lines, date, author, subject, body, evidence }[] }}
 */
export function whyOf(repo, file, start, end) {
  const out = tryGit(repo, ["blame", "--line-porcelain", "-w", "-M", "-C", "-C", "-L", `${start},${end}`, "--", file]);
  if (out == null) return { file, range: [start, end], error: "git blame failed (file not tracked, or lines out of range)" };
  const by = new Map();
  let uncommitted = 0;
  let cur = null;
  for (const line of out.split("\n")) {
    const head = line.match(/^([0-9a-f]{40}) \d+ \d+/);
    if (head) {
      cur = head[1];
      if (UNCOMMITTED.test(cur)) {
        uncommitted++;
        cur = null;
        continue;
      }
      if (!by.has(cur)) by.set(cur, { sha: cur, lines: 0 });
      by.get(cur).lines++;
    } else if (cur && line.startsWith("author ")) by.get(cur).author ??= line.slice(7);
    else if (cur && line.startsWith("author-time ")) by.get(cur).date ??= new Date(Number(line.slice(12)) * 1000).toISOString().slice(0, 10);
  }
  const commits = [...by.values()]
    .sort((a, b) => b.lines - a.lines || (b.date ?? "").localeCompare(a.date ?? ""))
    .map((c) => {
      const msg = (tryGit(repo, ["log", "-1", "--format=%B", c.sha]) ?? "").trim();
      const [subject, ...rest] = msg.split("\n");
      const body = rest.join("\n").replace(/^\s*Co-Authored-By:.*$/gim, "").trim();
      return { sha: c.sha, short: c.sha.slice(0, 7), lines: c.lines, date: c.date, author: c.author, subject, ...(body ? { body: body.slice(0, 600) } : {}), evidence: `commit:${c.sha.slice(0, 7)}` };
    });
  return { file, range: [start, end], uncommitted_lines: uncommitted, commits };
}

/** Repo-relative path of a cited file, matched by suffix against the commit's file list. */
const touches = (changed, cited) => changed.some((f) => f === cited || f.endsWith(`/${cited}`) || cited.endsWith(`/${f}`));

/**
 * Problems with a spec's decisions, each { at, problem }.
 * @param committed the spec.json as last committed (or null), for the append-only rule
 */
export function checkDecisions(repo, spec, committed = null) {
  const problems = [];
  const bad = (at, problem) => problems.push({ at, problem });
  for (const d of spec.decisions ?? []) {
    const files = (d.evidence ?? []).filter((e) => !COMMIT.test(e)).map((e) => e.split(":")[0]);
    for (const e of d.evidence ?? []) {
      const m = e.match(COMMIT);
      if (!m) continue;
      const full = tryGit(repo, ["rev-parse", "--verify", "--quiet", `${m[1]}^{commit}`])?.trim();
      if (!full) {
        bad(d.id, `commit ${m[1]} not found in this repository`);
        continue;
      }
      if (!files.length) continue;
      const changed = (tryGit(repo, ["show", "--name-only", "--format=", full]) ?? "").split("\n").filter(Boolean);
      if (!files.some((f) => touches(changed, f))) bad(d.id, `commit ${m[1]} didn't change ${files.join(" or ")}, so it can't be the evidence for this decision`);
    }
  }
  // Append-only: a decision once committed keeps its words and evidence.
  const now = new Map((spec.decisions ?? []).map((d) => [d.id, d]));
  const same = (a, b) => a.decision === b.decision && a.because === b.because && JSON.stringify(a.evidence ?? []) === JSON.stringify(b.evidence ?? []);
  for (const old of committed?.decisions ?? []) {
    const cur = now.get(old.id);
    if (!cur) bad(old.id, "was removed. Decisions are append-only: keep it, and add a new decision with \"supersedes\" to replace it");
    else if (!same(old, cur)) bad(old.id, "was edited. Decisions are append-only: restore it, and add a new decision with \"supersedes\" to change it");
  }
  return problems;
}

/** The spec.json as of HEAD, or null when it isn't committed. */
export function committedSpec(repo, specPath) {
  const top = tryGit(repo, ["rev-parse", "--show-toplevel"])?.trim();
  if (!top) return null;
  const rel = path.relative(fs.realpathSync(top), fs.realpathSync(path.resolve(specPath)));
  if (rel.startsWith("..")) return null;
  const text = tryGit(repo, ["show", `HEAD:${rel}`]);
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
