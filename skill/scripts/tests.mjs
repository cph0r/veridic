#!/usr/bin/env node
// Which requirements have a real test: a test named with the requirement id
// (`it("FR-015: …")`) whose file reaches the code the requirement cites.
// --run executes the linked tests (vitest, jest, node:test) and reports passing/failing.
// --module <id>: the work list for turning that module's rules into tests (Markdown;
// --json for the data; --mutate N also checks N sampled rules' tests catch a change).

import fs from "node:fs";
import path from "node:path";
import { testCoverage, traceabilityTable, auditTests } from "../../core/tests.mjs";
import { workList, workListMarkdown } from "../../core/worklist.mjs";
import { mutationScore } from "../../core/mutate.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "tests.mjs --repo <path> (--module <id> [--run] [--json] [--mutate N] | --spec <spec.md> [--run] [--table] [--base <dir>] | --audit)";

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base", "module", "mutate"], bools: ["run", "table", "audit", "json"] });
  if (a.module && a.repo) {
    const wl = await workList(a.repo, a.module, { run: !!a.run });
    if (!wl.error && a.mutate) wl.mutation = wl.specs.map((s) => ({ spec: s, ...mutationScore(a.repo, fs.readFileSync(path.join(a.repo, s), "utf8"), { validate: Number(a.mutate) }).summary }));
    if (a.json) emit({ repo: a.repo, ...wl }, wl.error ? 2 : 0);
    writeAll(workListMarkdown(wl) + (wl.mutation ? wl.mutation.map((m) => `Mutation (${m.spec}): ${JSON.stringify(m)}`).join("\n") + "\n" : ""));
    process.exit(wl.error ? 2 : 0);
  }
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
