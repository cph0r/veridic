#!/usr/bin/env node
// Verify a spec's [evidence: path:line] citations. By default prints the summary
// and only the citations with a problem (with their text). --fr FR-007,FR-012
// prints those requirements' cited text to re-read against the claim; --text
// prints every citation's text (large: avoid in an agent session).

import fs from "node:fs";
import { checkCitations } from "../../core/citations.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "cite.mjs --repo <path> --spec <spec.md> [--base <dir>] [--fr FR-001,FR-002] [--text]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base", "fr"], bools: ["text", "failures-only"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const result = checkCitations(a.repo, fs.readFileSync(specPath, "utf8"), { bases: a.base ? [a.base] : [] });
  const wanted = a.fr ? new Set(String(a.fr).split(",").map((x) => x.trim())) : null;
  const problem = (c) => !c.resolves || c.warnings;
  const citations = a.text ? result.citations : result.citations.filter((c) => problem(c) || wanted?.has(c.fr));
  emit(
    { repo: a.repo, spec: specPath, summary: result.summary, citations, ...(a.text || wanted ? {} : { note: "only citations with a problem are listed; --fr <ids> shows cited text" }) },
    result.summary.unresolved || result.summary.with_warnings,
  );
}, usage);
