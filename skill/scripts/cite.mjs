#!/usr/bin/env node
// Verify a spec's [evidence: path:line] citations. By default prints the summary
// and only the citations with a problem (with their text). --fr FR-007,FR-012
// prints those requirements' cited text to re-read against the claim; --text
// prints every citation's text (large: avoid in an agent session).

import fs from "node:fs";
import path from "node:path";
import { checkCitations } from "../../core/citations.mjs";
import { storyHeadingProblems } from "../../core/report.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "cite.mjs --repo <path> --spec <spec.md> [--base <dir>] [--fr FR-001,FR-002] [--text]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base", "fr"], bools: ["text", "failures-only"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const text = fs.readFileSync(specPath, "utf8");
  const result = checkCitations(a.repo, text, { bases: a.base ? [a.base] : [] });
  // Headings that look like stories but don't parse: the dashboard would show no story for them.
  const stories = storyHeadingProblems(text).map((p) => `${path.basename(specPath)}:${p.line} "${p.heading}" looks like a story but isn't read`);
  const wanted = a.fr ? new Set(String(a.fr).split(",").map((x) => x.trim())) : null;
  const problem = (c) => !c.resolves || c.warnings;
  const citations = a.text ? result.citations : result.citations.filter((c) => problem(c) || wanted?.has(c.fr));
  emit(
    { repo: a.repo, spec: specPath, summary: result.summary, citations, ...(stories.length ? { story_warnings: stories } : {}), ...(a.text || wanted ? {} : { note: "only citations with a problem are listed; --fr <ids> shows cited text" }) },
    result.summary.unresolved || result.summary.with_warnings,
  );
}, usage);
