#!/usr/bin/env node
// git pre-commit hook: update citations that only moved (and stage the spec),
// then block the commit if a cited requirement's code changed. Install with
// `node install.mjs --repo <repo>`. Bypass once with PLUMB_ALLOW_STALE=1.

import { execFileSync } from "node:child_process";
import { guard, describe } from "../../core/guard.mjs";

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
try {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo, stdio: "ignore" });
} catch {
  process.exit(0); // first commit: nothing to compare against
}

const report = guard(repo, { range: "HEAD", stage: true });
const text = describe(report);
if (text) process.stderr.write(`plumb:\n${text}\n`);
if (report.problems && process.env.PLUMB_ALLOW_STALE !== "1" && process.env.SPECGUARD_ALLOW_STALE !== "1") {
  process.stderr.write("plumb: commit blocked. Update the requirements above, or commit with PLUMB_ALLOW_STALE=1.\n");
  process.exit(1);
}
