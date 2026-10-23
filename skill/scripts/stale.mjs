#!/usr/bin/env node
// Requirements a change affects. Maps the diff of a git range onto the spec's
// citations (read at the range's base) and lists the FRs to re-verify.
// --fix rewrites citations whose lines only moved; anchored citations must be
// confirmed by the CodeGraph index (run `codegraph sync` first).
// --strict also fails when moved citations were not fixed.
// --pr (CI): checks the PR updated the spec wherever its diff requires it.

import fs from "node:fs";
import path from "node:path";
import { staleness, syncSpec, prCheck, stampSpec } from "../../core/staleness.mjs";
import { openSymbols } from "../../core/anchors.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "stale.mjs --repo <path> --spec <spec.md> [--range origin/main...HEAD | A..B | <rev> (vs working tree)] [--base <dir>] [--fix] [--stamp] [--strict] [--no-index] [--pr]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "range", "base"], bools: ["fix", "stamp", "strict", "no-index", "pr"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  if (a.pr) {
    // CI: the spec as of the range's base vs the PR's version of it.
    const rel = path.relative(a.repo, path.resolve(specPath));
    const r = prCheck(a.repo, rel, { range: a.range, bases: a.base ? [a.base] : [] });
    emit(
      { repo: a.repo, spec: rel, range: r.range, ...(r.new_spec ? { new_spec: true } : {}), addressed: r.addressed, unaddressed: r.unaddressed, pending_fixes: r.pending_fixes, conflicts: r.result?.conflicts ?? [] },
      r.unaddressed.length + r.pending_fixes.length,
    );
  }
  if (a.stamp) {
    // Record what each citation points at (a hash of its lines, from the working tree), so it's
    // judged by its text from now on. Only citations that resolve; run `veridic check` first.
    const s = stampSpec(a.repo, fs.readFileSync(specPath, "utf8"), { bases: a.base ? [a.base] : [] });
    if (s.stamped) fs.writeFileSync(specPath, s.spec);
    emit({ repo: a.repo, spec: specPath, stamped: s.stamped, skipped: s.skipped }, s.skipped.length);
  }
  const spec = fs.readFileSync(specPath, "utf8");
  const rel = path.relative(a.repo, path.resolve(specPath));
  const opts = { range: a.range, bases: a.base ? [a.base] : [], symbols: a["no-index"] ? null : openSymbols(a.repo), ...(rel.startsWith("..") ? {} : { specFile: rel }) };
  let result;
  if (a.fix) {
    // A spec tracked in the repo is compared with its committed version, so --fix is safe to rerun.
    const s = syncSpec(a.repo, specPath, { ...opts, range: a.range });
    if (s.applied) fs.writeFileSync(specPath, s.spec);
    emit({ repo: a.repo, spec: specPath, index: opts.symbols ? "codegraph" : "none (diff only)", mode: s.mode, fixed: s.applied, open: s.open, conflicts: s.conflicts, result: s.result }, s.open.length + s.conflicts.length);
  }
  result = staleness(a.repo, spec, opts);
  const problems = result.stale.length + result.conflicts.length + (a.strict ? result.fixes.length : 0);
  emit({ repo: a.repo, spec: specPath, index: opts.symbols ? "codegraph" : "none (diff only)", ...result }, problems);
}, usage);
