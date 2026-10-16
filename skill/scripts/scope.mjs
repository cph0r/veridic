#!/usr/bin/env node
// What belongs to this feature. Seeds are routes ("POST /api/orders"), files or
// symbols. Prints routes, webhooks, timers, services, callers, schemas,
// contract_ops, clients and a prioritized read_list. Prints a compact summary;
// --json prints everything; --out <scope.json> saves everything for read/drift.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { scope } from "../../core/scope.mjs";
import { findOpenapi, loadContract } from "../../core/contract.mjs";
import fs from "node:fs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = 'scope.mjs --repo <path> [--entry <app file>] [--openapi <file>] [--depth 3] [--max-hops 3] [--json | --out <scope.json>] "<METHOD /path>" | <file> | <symbol> ...';

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "entry", "openapi", "depth", "max-hops", "out"], bools: ["json"] });
  if (!a.repo || !a._.length) fail("need --repo and at least one seed", usage);
  const g = openGraph(a.repo);
  const inv = routeInventory(g, { entry: a.entry });
  const openapiFile = a.openapi ?? findOpenapi(a.repo);
  const openapi = openapiFile ? loadContract(a.repo, openapiFile).ops : [];
  const result = scope(g, inv, a._, {
    openapi,
    ...(a.depth ? { depth: Number(a.depth) } : {}),
    ...(a["max-hops"] ? { maxHops: Number(a["max-hops"]) } : {}),
  });
  const full = { repo: a.repo, entry: inv.entry, ...result };
  const problems = result.error || result.unresolved?.length;
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(full));
  if (a.json) emit(full, problems);
  emit({ ...(a.out ? { saved: a.out } : {}), ...summarize(full) }, problems);
}, usage);

/** What an agent needs to decide what to read, without the full evidence. */
function summarize(r) {
  if (r.error) return { error: r.error, unresolved: r.unresolved };
  const unit = (u) => `${u.id} @ ${u.at}${u.seed ? " (seed)" : u.tier ? ` [${u.tier}]` : ""}`;
  return {
    entry: r.entry,
    ...(r.unresolved?.length ? { unresolved: r.unresolved } : {}),
    routes: r.routes.map(unit),
    webhooks: r.webhooks.map(unit),
    timers: r.timers.map(unit),
    callers: r.callers.map((c) => `${c.name} @ ${c.at}`),
    tables: r.schemas.map((t) => t.table ?? t.name),
    contract_ops: r.contract_ops.length,
    services: r.services.length,
    read_list: `${r.read_list.length} ranges, ${r.read_list.reduce((n, x) => n + x.lines, 0)} lines: print them with \`veridic read\` (same seeds, or --scope <saved file>)`,
  };
}
