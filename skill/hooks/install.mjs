#!/usr/bin/env node
// Install the veridic git pre-commit hook into a repo. Refuses to overwrite an
// existing hook unless --force; prints what it did.
//
//   node install.mjs --repo <path> [--force]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const repoArg = args[args.indexOf("--repo") + 1];
if (!args.includes("--repo") || !repoArg) {
  console.error("usage: install.mjs --repo <path> [--force]");
  process.exit(2);
}
const repo = path.resolve(repoArg);
const hooksDir = path.resolve(repo, execFileSync("git", ["rev-parse", "--git-path", "hooks"], { cwd: repo, encoding: "utf8" }).trim());
const target = path.join(hooksDir, "pre-commit");
const script = fs.realpathSync(path.join(import.meta.dirname, "pre-commit.mjs"));

if (fs.existsSync(target) && !args.includes("--force")) {
  console.error(`${target} already exists. Add this line to it instead, or rerun with --force:\n  node "${script}" || exit 1`);
  process.exit(1);
}
fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(target, `#!/bin/sh\n# veridic: keep specs in step with the code being committed\nexec node "${script}"\n`, { mode: 0o755 });
console.log(`installed ${target} -> ${script}`);
