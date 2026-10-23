#!/usr/bin/env node
// A metrics baseline, to prove a change kept every number Veridic produces:
// routes, each spec's rules and their states, coverage per part, the split's files,
// finding counts and the dashboard's headline totals. Not a test file (npm test
// doesn't run it): capture before a change, compare after.
//
//   node test/metrics-baseline.mjs --repo <path> --out <file.json>
//   node test/metrics-baseline.mjs --repo <path> --compare <file.json>   (exit 1 on any difference)

import fs from "node:fs";
import vm from "node:vm";
import { collectReport } from "../core/report.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const repo = arg("--repo");
if (!repo) { console.error("usage: metrics-baseline.mjs --repo <path> (--out <file> | --compare <file>)"); process.exit(2); }

const d = await collectReport(repo);
const ctx = {};
vm.runInNewContext(fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8"), ctx);
const counts = { ...ctx.veridicModel(JSON.parse(JSON.stringify(d))).counts };
const tally = (xs, k) => xs.reduce((a, x) => ((a[x[k]] = (a[x[k]] ?? 0) + 1), a), {});
const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const metrics = {
  routes: d.routes.length,
  specs: d.specs.map((s) => {
    const rules = s.requirements.filter((r) => r.requirement !== false);
    return { path: s.path, rules: rules.length, statuses: sorted(tally(rules, "status")), stale: rules.filter((r) => r.stale).length, lost: rules.filter((r) => (r.cites ?? []).some((c) => c.resolves === false)).length, stories: s.doc?.stories?.length ?? 0 };
  }).sort((a, b) => a.path.localeCompare(b.path)),
  coverage: d.coverage ? { behaviour: d.coverage.behaviour, covered: d.coverage.covered, pct: d.coverage.pct, parts: d.coverage.parts.map((p) => ({ id: p.id, total: p.total, covered: p.covered })).sort((a, b) => a.id.localeCompare(b.id)) } : null,
  modules: (d.modules ?? []).map((m) => ({ id: m.id, routes: m.routes.length, files: [...m.files].sort(), code: [...m.code].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
  screens: (d.screens ?? []).map((s) => ({ id: s.id, files: [...s.files].sort() })).sort((a, b) => a.id.localeCompare(b.id)),
  findings: sorted(tally(d.findings, "severity")),
  model: { counts: sorted(counts) },
};

const out = arg("--out"), cmp = arg("--compare");
if (out) { fs.writeFileSync(out, JSON.stringify(metrics, null, 1)); console.log(`wrote ${out}`); process.exit(0); }
if (cmp) {
  const before = JSON.parse(fs.readFileSync(cmp, "utf8"));
  const diffs = [];
  const walk = (a, b, at) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], at ? `${at}.${k}` : k); return; }
    diffs.push(`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  };
  walk(before, metrics, "");
  if (!diffs.length) { console.log("same: every metric matches the baseline"); process.exit(0); }
  console.log(diffs.slice(0, 40).join("\n") + (diffs.length > 40 ? `\n… ${diffs.length - 40} more` : ""));
  process.exit(1);
}
console.log(JSON.stringify(metrics, null, 1));
