#!/usr/bin/env node
// Gather a feature's context before a spec session: scope, contract comparison
// and all relevant code as one Markdown document. Prints it, or writes it with
// --out <file>. Seeds as for scope.

import fs from "node:fs";
import { prepare } from "../../core/prepare.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = 'prepare.mjs --repo <path> "<METHOD /path>" | <file> | <symbol> ... [--out <context.md>] [--all] [--entry <app file>]';

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "out", "entry"], bools: ["all"] });
  if (!a.repo || !a._.length) fail("need --repo and at least one seed", usage);
  const r = prepare(a.repo, a._, { entry: a.entry, all: !!a.all });
  if (a.out) {
    fs.writeFileSync(a.out, r.markdown);
    emit({ repo: a.repo, wrote: a.out, ...r.stats });
  }
  writeAll(r.markdown);
}, usage);
