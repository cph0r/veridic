#!/usr/bin/env node
// Claude Code Stop hook: before the agent finishes, check its work. It does
// nothing unless the repo opted in with a .veridic.json (`veridic init --enforce`):
//
//   { "stop": ["done", "stale"] }
//
// - done:  the change must stay inside what the agent claimed (`veridic claim`),
//          and every changed route needs an asserting test about it.
// - stale: spec requirements whose cited code changed must be updated; citations
//          that only moved are fixed in place.
//
// When something is missing, exit 2 sends the message back to the agent once
// (stop_hook_active stops it looping). Shipped in the plugin's hooks/hooks.json;
// without the plugin, add it to .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node /path/to/veridic/skill/hooks/claude-stop.mjs" } ] } ] } }

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, "utf8"));
} catch {}
// Already sent back once this turn: let the agent stop rather than loop.
if (input.stop_hook_active) process.exit(0);

let repo;
try {
  repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: input.cwd ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: repo, stdio: "ignore" });
} catch {
  process.exit(0); // not a git repo, or no commits yet
}

// Opt-in only: a repo without .veridic.json is never checked.
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(repo, ".veridic.json"), "utf8"));
} catch {
  process.exit(0);
}
const checks = new Set(config.stop ?? []);
const messages = [];

if (checks.has("stale")) {
  const { guard, describe } = await import("../../core/guard.mjs");
  const report = guard(repo, { range: "HEAD" });
  if (report.problems)
    messages.push(
      `Your changes touched code that these spec requirements cite.\n${describe(report)}\n` +
        "For each one, re-read the cited code, update the requirement text and its [evidence: …] citation, then run `veridic cite` on the spec.",
    );
}

if (checks.has("done") && fs.existsSync(path.join(repo, ".codegraph", "codegraph.db"))) {
  const { doneWithoutSpec, loadClaim } = await import("../../core/seam.mjs");
  try {
    const r = await doneWithoutSpec(repo, { claims: loadClaim(repo) });
    if (r.problems.length)
      messages.push(
        `veridic done: NOT DONE.\n${r.problems.map((p) => `- ${p}`).join("\n")}\n` +
          (r.claimed.length ? "" : "No claim was recorded for this task; run `veridic claim <routes or files>` so strays can be told apart from the task.\n") +
          "Fix these (undo a stray edit or claim it; add a test that asserts what the route does), then run `veridic done --card` until it prints DONE.",
      );
  } catch (e) {
    process.stderr.write(`veridic: couldn't run the done check (${e.message})\n`);
  }
}

if (!messages.length) process.exit(0);
process.stderr.write(`${messages.join("\n\n")}\n`);
process.exit(2);
