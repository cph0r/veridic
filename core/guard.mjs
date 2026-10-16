// One pass of "keep the specs in step with the code", shared by the git
// pre-commit hook and the Claude Code Stop hook: refresh the index, rewrite
// citations that only moved, and report requirements that need a human or agent.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { syncSpec } from "./staleness.mjs";
import { openSymbols } from "./anchors.mjs";

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Specs to guard: PLUMB_SPECS (comma-separated, repo-relative) or every tracked `spec.md`. */
export function findSpecs(repo, env = process.env) {
  const list = env.PLUMB_SPECS ?? env.SPECGUARD_SPECS; // SPECGUARD_SPECS: the old name
  if (list) return list.split(",").map((s) => s.trim()).filter(Boolean);
  return sh("git", ["ls-files", "--", "*spec.md"], repo).split("\n").filter(Boolean);
}

/** Bring CodeGraph's index up to date with the working tree, if CodeGraph is installed and indexed here. */
export function syncIndex(repo) {
  if (!fs.existsSync(path.join(repo, ".codegraph"))) return "no index";
  try {
    sh("codegraph", ["sync", repo], repo);
    return "synced";
  } catch {
    return "sync failed (anchors checked against the existing index)";
  }
}

/**
 * @param repo  repo root
 * @param opts  { range = "HEAD" (vs working tree), stage = false (git add fixed specs), sync = true }
 * @returns {{ index, specs: [{ spec, fixed, stale, conflicts }], problems: number }}
 */
export function guard(repo, opts = {}) {
  const range = opts.range ?? "HEAD";
  const found = findSpecs(repo, opts.env);
  // No specs here: nothing to do, and no index sync on every commit or agent turn.
  if (!found.length) return { index: "skipped (no specs)", specs: [], problems: 0 };
  const index = opts.sync === false ? "not synced" : syncIndex(repo);
  const symbols = openSymbols(repo);
  const specs = [];
  for (const rel of found) {
    const file = path.resolve(repo, rel);
    if (!fs.existsSync(file)) continue;
    // Compared with the committed spec, so running this on every commit or agent turn never double-applies a fix.
    const { spec, applied, open, conflicts } = syncSpec(repo, file, { range, symbols });
    if (applied) {
      fs.writeFileSync(file, spec);
      if (opts.stage) sh("git", ["add", "--", rel], repo);
    }
    specs.push({ spec: rel, fixed: applied, stale: open, conflicts });
  }
  return { index, specs, problems: specs.reduce((n, s) => n + s.stale.length + s.conflicts.length, 0) };
}

/** Human- and agent-readable summary of what still needs attention. */
export function describe(report) {
  const lines = [];
  for (const s of report.specs) {
    if (s.fixed) lines.push(`${s.spec}: updated ${s.fixed} citation(s) whose code only moved.`);
    for (const x of s.stale) lines.push(`${s.spec}: ${x.fr} cites ${x.cite}: ${x.need ?? `cited code was ${x.change}`}.`);
    for (const x of s.conflicts) lines.push(`${s.spec}: ${x.fr} cites ${x.cite}: ${x.problem}.`);
  }
  return lines.join("\n");
}
