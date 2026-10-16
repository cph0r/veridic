#!/usr/bin/env node
// Which requirements have a real test: a test named with the requirement id
// (`it("FR-015: …")`) whose file reaches the code the requirement cites.
// --run executes the linked tests (vitest) and reports passing/failing.

import fs from "node:fs";
import { testCoverage, traceabilityTable, auditTests } from "../../core/tests.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "tests.mjs --repo <path> (--spec <spec.md> [--run] [--table] [--base <dir>] | --audit)";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base"], bools: ["run", "table", "audit"] });
  // --audit: every test in the repo, by what it checks; no spec needed.
  if (a.audit && a.repo) {
    const r = auditTests(a.repo);
    emit({ repo: a.repo, ...r }, 0);
  }
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const r = testCoverage(a.repo, fs.readFileSync(specPath, "utf8"), { specPath, run: !!a.run, bases: a.base ? [a.base] : [] });
  if (a.table) {
    writeAll(traceabilityTable(r));
    process.exit((r.summary.failing ?? 0) ? 1 : 0);
  }
  emit({ repo: a.repo, spec: specPath, ...r }, (r.summary.failing ?? 0) + (r.errors?.length ?? 0));
}, usage);
