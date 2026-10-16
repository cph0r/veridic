#!/usr/bin/env node
// Spec mutation score: break the code behind each requirement's facts, one line
// at a time, and check the guard would flag that requirement. Read-only on the
// repo: the --validate sample runs on a throwaway clone. The spec must describe
// the repo's HEAD.

import fs from "node:fs";
import { mutationScore } from "../../core/mutate.mjs";
import { openSymbols } from "../../core/anchors.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "mutate.mjs --repo <path> --spec <spec.md> [--base <dir>] [--validate <n>] [--seed <n>]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base", "validate", "seed"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const r = mutationScore(a.repo, fs.readFileSync(specPath, "utf8"), {
    symbols: openSymbols(a.repo),
    validate: Number(a.validate ?? 0),
    seed: Number(a.seed ?? 1),
    bases: a.base ? [a.base] : [],
  });
  emit({ repo: a.repo, spec: specPath, ...r }, r.validation_disagreements?.length ?? 0);
}, usage);
