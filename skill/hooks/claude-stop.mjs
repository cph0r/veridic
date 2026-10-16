#!/usr/bin/env node
// Claude Code Stop hook: before the agent finishes, update citations that only
// moved, and if a cited requirement's code changed, keep the agent working
// (exit 2 sends the message back to it) until the spec is updated.
//
// .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node /path/to/plumb/skill/hooks/claude-stop.mjs" } ] } ] } }

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { guard, describe } from "../../core/guard.mjs";

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {}
// Already blocked once this turn: let the agent stop rather than loop.
if (input.stop_hook_active) process.exit(0);

let repo;
try {
  repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: input.cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo, stdio: "ignore" });
} catch {
  process.exit(0); // not a git repo, or no commits yet
}

const report = guard(repo, { range: "HEAD" });
if (!report.problems) process.exit(0);
process.stderr.write(
  `plumb: your changes touched code that these spec requirements cite.\n${describe(report)}\n` +
    "For each one, re-read the cited code, update the requirement text and its [evidence: …] citation, " +
    "then run the plumb cite script on the spec.\n",
);
process.exit(2);

