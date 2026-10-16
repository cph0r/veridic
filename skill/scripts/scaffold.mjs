#!/usr/bin/env node
// A test skeleton for a spec: one placeholder per requirement, named with its id.
// Prints the file (or writes it with --out <repo-relative path> --write).
// --harness express adds a dependency-free helper that calls a router over HTTP.

import fs from "node:fs";
import path from "node:path";
import { scaffold } from "../../core/scaffold.mjs";
import { openSymbols } from "../../core/anchors.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "scaffold.mjs --repo <path> --spec <spec.md> [--out <repo-relative test path>] [--harness express] [--write]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "out", "harness", "base"], bools: ["write"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const r = scaffold(a.repo, fs.readFileSync(specPath, "utf8"), { specPath, out: a.out, harness: a.harness ?? null, symbols: openSymbols(a.repo), bases: a.base ? [a.base] : [] });
  if (a.write) {
    if (!a.out) fail("--write needs --out", usage);
    const dest = path.join(a.repo, a.out);
    if (fs.existsSync(dest)) fail(`${a.out} already exists; choose another --out`, usage);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, r.text);
    emit({ repo: a.repo, spec: specPath, wrote: a.out, framework: r.framework, requirements: r.requirements, groups: r.groups });
  }
  writeAll(r.text);
}, usage);
