#!/usr/bin/env node
// Which requirements have a real test: a test named with the requirement id
// (`it("FR-015: …")`) whose file reaches the code the requirement cites.
// --run executes the linked tests (vitest, jest, node:test) and reports passing/failing.
// --module <id>: the work list for turning that module's rules into tests (Markdown;
// --json for the data; --mutate N also checks N sampled rules' tests catch a change).
// --module <id> --link ID=file:line[,line] …: name those existing tests for those rules, in one call.

import fs from "node:fs";
import path from "node:path";
import { testCoverage, traceabilityTable, auditTests, reviewedSection } from "../../core/tests.mjs";
import { workList, workListMarkdown } from "../../core/worklist.mjs";
import { testMutation } from "../../core/testmut.mjs";
import { linkForModule, linkForSpec, linkMarkdown } from "../../core/link.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "tests.mjs --repo <path> (--module <id> [--run] [--json] [--mutate N] | --module <id> --link ID=file:line[,line] … | --spec <spec.md> [--run] [--table] [--base <dir>] | --audit)";

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base", "module", "mutate"], bools: ["run", "table", "audit", "json", "link"] });
  if (a.link && a.module && a.repo) {
    const r = await linkForModule(a.repo, a.module, a._);
    if (a.json) emit({ repo: a.repo, ...r }, r.skipped.length ? 1 : 0);
    writeAll(linkMarkdown(r));
    process.exit(r.skipped.length ? 1 : 0);
  }
  // A spec that isn't a part's: link its tests, then rewrite its traceability.md from what's linked.
  if (a.link && a.spec && a.repo) {
    const r = linkForSpec(a.repo, a.spec, a._);
    const trace = path.join(path.dirname(a.spec), "traceability.md");
    const cov = testCoverage(a.repo, fs.readFileSync(a.spec, "utf8"), { specPath: a.spec });
    fs.writeFileSync(trace, traceabilityTable(cov, { reviewed: reviewedSection(fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "") }));
    if (a.json) emit({ repo: a.repo, ...r, traceability: trace }, r.skipped.length ? 1 : 0);
    writeAll(linkMarkdown(r).replace(/Next: veridic tests --module \S+/, `Next: veridic tests --spec ${a.spec}`));
    process.exit(r.skipped.length ? 1 : 0);
  }
  // --module <id> for a spec folder that isn't a part (specs/server/spec.md): the spec's tests.
  const specOfFolder = a.module && a.repo && !a.spec ? path.join(a.repo, "specs", a.module, "spec.md") : null;
  let wl = null;
  if (a.module && a.repo && !a.spec) {
    wl = await workList(a.repo, a.module, { run: !!a.run });
    if (wl.error && specOfFolder && fs.existsSync(specOfFolder)) a.spec = specOfFolder;
  }
  if (a.module && a.repo && !a.spec) {
    // --mutate N: change the cited code of N tested rules; count those whose tests notice.
    if (!wl.error && a.mutate) wl.mutation = testMutation(a.repo, wl.rules, Number(a.mutate));
    if (a.json) emit({ repo: a.repo, ...wl }, wl.error ? 2 : 0);
    writeAll(workListMarkdown(wl) + (wl.mutation ? `Mutation: ${wl.mutation.caught} of ${wl.mutation.sampled} sampled rules' tests failed when their cited code changed${wl.mutation.rules.filter((r) => r.caught === false).map((r) => `\n- not caught: ${r.id} (${r.cite})`).join("")}\n` : ""));
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
    const trace = path.join(path.dirname(specPath), "traceability.md");
    writeAll(traceabilityTable(r, { reviewed: reviewedSection(fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "") }));
    process.exit((r.summary.failing ?? 0) ? 1 : 0);
  }
  emit({ repo: a.repo, spec: specPath, ...r }, (r.summary.failing ?? 0) + (r.errors?.length ?? 0));
}, usage);
