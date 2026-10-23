#!/usr/bin/env node
// Verify a spec's [evidence: path:line] citations. By default prints the summary
// and only the citations with a problem (with their text). --fr FR-007,FR-012
// prints those requirements' cited text to re-read against the claim; --text
// prints every citation's text (large: avoid in an agent session).

import fs from "node:fs";
import path from "node:path";
import { checkCitations } from "../../core/citations.mjs";
import { storyHeadingProblems } from "../../core/report.mjs";
import { execFileSync } from "node:child_process";
import { PRODUCT_SPEC, parseProduct, productProblems } from "../../core/product.mjs";
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
  // The product spec cites part rules (apps:FR-003): each must exist.
  let product = [];
  if (PRODUCT_SPEC.test(path.resolve(specPath))) {
    const specs = {};
    const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "specs/*/spec.md"], { cwd: a.repo, encoding: "utf8" }).split("\n").filter(Boolean);
    for (const f of files) {
      const folder = f.split("/").slice(-2)[0];
      if (folder === "product") continue;
      specs[folder] = [...fs.readFileSync(path.join(a.repo, f), "utf8").matchAll(/^\s*(?:[-*]\s*\*\*|#{1,6}\s+)((?:FR|NFR|AC|INV)-?\d+[a-z]?)\b/gm)].map((m) => m[1]);
    }
    product = productProblems(parseProduct(text), specs);
  }
  const wanted = a.fr ? new Set(String(a.fr).split(",").map((x) => x.trim())) : null;
  const problem = (c) => !c.resolves || c.warnings;
  const citations = a.text ? result.citations : result.citations.filter((c) => problem(c) || wanted?.has(c.fr));
  emit(
    { repo: a.repo, spec: specPath, summary: result.summary, citations, ...(stories.length ? { story_warnings: stories } : {}), ...(product.length ? { product_problems: product } : {}), ...(a.text || wanted ? {} : { note: "only citations with a problem are listed; --fr <ids> shows cited text" }) },
    result.summary.unresolved || result.summary.with_warnings || product.length,
  );
}, usage);
