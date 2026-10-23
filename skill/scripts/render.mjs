#!/usr/bin/env node
// spec.json -> spec.md + traceability.md (next to it, or in --out-dir), and, when
// the spec has a `domain`, requirements.md in the domain requirements format. Validates
// first and refuses to render a spec with problems. The contract and state
// machine sections are generated from the code for the spec's seeds.

import fs from "node:fs";
import path from "node:path";
import { validate, renderMarkdown, generatedSections, renderScaffolding } from "../../core/specdata.mjs";
import { testCoverage, traceabilityTable } from "../../core/tests.mjs";
import { stampSpec } from "../../core/staleness.mjs";
import { checkDecisions, committedSpec } from "../../core/decisions.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "render.mjs --repo <path> --spec <spec.json> [--out-dir <dir>] [--run-tests]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "out-dir"], bools: ["run-tests"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  } catch (e) {
    emit({ spec: specPath, rendered: false, problems: [{ at: "spec.json", problem: `not valid JSON: ${e.message}` }] }, 1);
  }
  const problems = [...validate(spec)];
  // Decisions cite commits: they must exist, have touched the cited files, and stay append-only.
  if (!problems.length && (spec.decisions?.length || committedSpec(a.repo, specPath)?.decisions?.length)) problems.push(...checkDecisions(a.repo, spec, committedSpec(a.repo, specPath)));
  if (problems.length) emit({ spec: specPath, rendered: false, problems }, 1);

  const dir = a["out-dir"] ?? path.dirname(specPath);
  const generated = generatedSections(a.repo, spec.seeds);
  // Each citation records what it points at now (a hash of its lines), so it's judged by its text.
  const md = stampSpec(a.repo, renderMarkdown(spec, generated)).spec;
  const mdPath = path.join(dir, "spec.md");
  fs.writeFileSync(mdPath, md);
  const cov = testCoverage(a.repo, md, { specPath: mdPath, run: !!a["run-tests"] });
  fs.writeFileSync(path.join(dir, "traceability.md"), traceabilityTable(cov));
  const wrote = [mdPath, path.join(dir, "traceability.md")];
  if (spec.domain) {
    fs.writeFileSync(path.join(dir, "requirements.md"), renderScaffolding(spec, cov));
    wrote.push(path.join(dir, "requirements.md"));
  }
  emit({
    spec: specPath,
    rendered: true,
    wrote,
    ...(cov.summary.criteria ? { criteria: { total: cov.summary.criteria, covered: cov.summary.criteria_covered } } : {}),
    counts: { requirements: spec.requirements.length, invariants: spec.invariants?.length ?? 0, decisions: spec.decisions?.length ?? 0, risks: spec.risks?.length ?? 0, stories: spec.stories?.length ?? 0 },
    ...(generated.error ? { generated_error: generated.error } : {}),
    next: "veridic cite --spec spec.md, then veridic claims --spec spec.md",
  });
}, usage);
