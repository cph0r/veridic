#!/usr/bin/env node
// Is this API safe to hand to AI agents? Prints the agent-readiness report (GETs
// that write, money/destructive routes on ids the caller doesn't own, policy
// mismatches with --intended), or with --manifest the full tool manifest: each
// route's real effect (read/write/destructive, moves money, external, notifies),
// what a caller needs, and its contract facts, all with evidence. Filter routes
// with words, as for `routes`.

import fs from "node:fs";
import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { effectManifest, readiness, loadIntended, compareAccess, accessMatrix } from "../../core/effects.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "agent-ready.mjs --repo <path> [--intended <access.csv>] [--manifest [--out <file>]] [--md] [word ...]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "intended", "out", "entry"], bools: ["manifest", "md"] });
  if (!a.repo) fail("need --repo", usage);
  const g = openGraph(a.repo);
  const inv = routeInventory(g, { entry: a.entry });
  const words = a._.map((w) => w.toLowerCase());
  inv.routes = inv.routes.filter((r) => words.every((w) => r.id.toLowerCase().includes(w)));
  const manifest = effectManifest(g, inv);
  if (a.manifest) {
    if (a.out) fs.writeFileSync(a.out, JSON.stringify({ generated_by: "plumb agent-ready", tools: manifest }, null, 2));
    emit(a.out ? { wrote: a.out, tools: manifest.length } : { tools: manifest }, 0);
  }
  const comparison = a.intended ? compareAccess(accessMatrix(g, inv), loadIntended(a.intended)) : null;
  const r = readiness(manifest, comparison);
  if (a.md) {
    const s = r.summary;
    const lines = [
      `## Agent readiness`,
      "",
      `${s.tools} routes: ${s.reads} read, ${s.writes} write, ${s.destructive} destructive; ${s.move_money} move money; ${s.gets_that_write} GETs that write. **${s.agent_ready_pct}%** have no medium or high issue.`,
      "",
      `| Severity | Issue | Route | What | Evidence |`,
      `|---|---|---|---|---|`,
      ...r.issues.map((i) => `| ${i.severity} | ${i.kind} | \`${i.tool}\` | ${i.text} | ${i.evidence.map((e) => `\`${e}\``).join(", ")} |`),
      "",
    ];
    writeAll(lines.join("\n"));
    process.exit(r.summary.issues.high ? 1 : 0);
  }
  emit({ repo: a.repo, ...r }, r.summary.issues.high);
}, usage);
