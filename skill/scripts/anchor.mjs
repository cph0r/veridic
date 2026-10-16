#!/usr/bin/env node
// Add symbol anchors to a spec's citations: `path:120-140` becomes
// `path:120-140#createOrder@26`, naming the smallest enclosing symbol from the
// CodeGraph index. Anchored citations survive code moving around them.
// Prints the proposed anchors; --write rewrites the spec.

import fs from "node:fs";
import { parseSpec, makeResolver } from "../../core/citations.mjs";
import { openSymbols, enclosingSymbol, formatCite, applyEdits } from "../../core/anchors.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "anchor.mjs --repo <path> --spec <spec.md> [--base <dir>] [--write]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "base"], bools: ["write"] });
  const specPath = a.spec ?? a._[0];
  if (!a.repo || !specPath) fail("need --repo and --spec", usage);
  const symbols = openSymbols(a.repo);
  if (!symbols) fail(`no CodeGraph index in ${a.repo}; run \`veridic init\``, usage);
  const spec = fs.readFileSync(specPath, "utf8");
  const parsed = parseSpec(spec);
  const resolve = makeResolver(a.repo, { aliases: parsed.aliases, bases: [...(a.base ? [a.base] : []), ...parsed.bases] });

  const edits = [];
  const skipped = [];
  let already = 0;
  for (const c of parsed.citations) {
    if (c.bad) continue;
    if (c.anchor) {
      already++;
      continue;
    }
    const file = resolve(c.file).file;
    if (!file) {
      skipped.push({ fr: c.fr, cite: c.cite, problem: "file not found" });
      continue;
    }
    const enc = enclosingSymbol(symbols, file, c.start, c.end);
    if (enc.problem) {
      skipped.push({ fr: c.fr, cite: c.cite, problem: enc.problem });
      continue;
    }
    edits.push({ fr: c.fr, spec_line: c.spec_line, cite: c.cite, replacement: formatCite(c.file, c.start, c.end, { name: enc.symbol.name, line: enc.symbol.start }), symbol: enc.symbol.kind });
  }
  let applied = 0;
  if (a.write && edits.length) {
    const out = applyEdits(spec, edits);
    fs.writeFileSync(specPath, out.spec);
    applied = out.applied;
  }
  emit({
    repo: a.repo,
    spec: specPath,
    summary: { citations: parsed.citations.length, already_anchored: already, anchorable: edits.length, skipped: skipped.length, ...(a.write ? { written: applied } : {}) },
    anchors: edits,
    skipped,
  });
}, usage);
