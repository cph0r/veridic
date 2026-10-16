#!/usr/bin/env node
// Do the facts each requirement states (identifiers, quoted messages, numbers)
// appear in the lines it cites? Exits 1 when a fact sits elsewhere in a cited
// file but outside the cited lines: that citation is probably off.

import fs from "node:fs";
import { checkClaims, plantedOffsetRecall } from "../../core/claims.mjs";
import { openSymbols } from "../../core/anchors.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "claims.mjs --repo <path> --spec <spec.md> [--base <dir>] [--all] [--eval-offset <n,...>]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base", "eval-offset"], bools: ["all"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const spec = fs.readFileSync(specPath, "utf8");
  const opts = { bases: a.base ? [a.base] : [], all: !!a.all, symbols: openSymbols(a.repo) };
  if (a["eval-offset"]) {
    // Measure the check: plant wrong citations by shifting them, count how many it catches.
    const runs = String(a["eval-offset"]).split(",").map((n) => plantedOffsetRecall(a.repo, spec, Number(n), opts));
    emit({ repo: a.repo, spec: specPath, recall: runs }, 0);
  }
  const r = checkClaims(a.repo, spec, opts);
  // List only the claims with something to look at.
  const lines = r.lines.filter((l) => l.facts.some((f) => f.status !== "cited"));
  emit({ repo: a.repo, spec: specPath, summary: r.summary, claims: lines }, r.summary.claims_with_misplaced_facts);
}, usage);
