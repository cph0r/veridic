#!/usr/bin/env node
// Every veridic number in one call: citations resolving, claims supported,
// anchors, staleness, dependency coverage, and how much of the API is specified.
// Default: every tracked *spec.md in the repo. --md prints a table instead of JSON.

import { metrics, toMarkdown, defaultSpecs } from "../../core/metrics.mjs";
import { specCard } from "../../core/card.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "metrics.mjs --repo <path> [--spec <spec.md>[,<spec.md>…]] [--md | --card] [--no-mutate] [--validate <n>] [--run-tests]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "validate"], bools: ["md", "card", "no-mutate", "run-tests"] });
  if (!a.repo) fail("need --repo", usage);
  const files = a.spec ? String(a.spec).split(",").concat(a._) : a._.length ? a._ : defaultSpecs(a.repo);
  if (!files.length) fail("no specs: pass --spec, or commit a *spec.md in the repo", usage);
  const r = metrics(a.repo, files, { mutate: !a["no-mutate"], validate: Number(a.validate ?? 0), runTests: !!a["run-tests"], raw: !!a.card });
  if (a.card) {
    writeAll(r._raw.map((s) => specCard(s, r.attention)).join("\n"));
    process.exit(r.attention.length ? 1 : 0);
  }
  delete r._raw;
  if (a.md) {
    writeAll(toMarkdown(r));
    process.exit(r.attention.length ? 1 : 0);
  }
  emit(r, r.attention.length);
}, usage);
