#!/usr/bin/env node
// How much of the app the specs describe: every behaviour file, the specs that
// cite it, per part (module or screen group), what's in no part, and every file
// left out with its reason. A measure, not a gate: it always exits 0.
// --module <id> for one part; --md for people.

import { collectReport } from "../../core/report.mjs";
import { specCoverage, coverageMarkdown } from "../../core/coverage.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "coverage.mjs --repo <path> [--module <id>] [--md]";

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "module"], bools: ["md", "json"] });
  if (!a.repo) fail("need --repo", usage);
  const data = await collectReport(a.repo);
  const c = specCoverage(a.repo, data);
  if (a.module && !c.parts.some((p) => p.id === a.module)) fail(`no part "${a.module}": see veridic modules`, usage);
  if (a.md) { writeAll(coverageMarkdown(c, { module: a.module })); return; }
  const { cited, ...rest } = c;
  const out = a.module ? { repo: a.repo, covered: c.covered, behaviour: c.behaviour, pct: c.pct, part: c.parts.find((p) => p.id === a.module) } : { repo: a.repo, ...rest };
  emit(out, 0);
}, usage);
