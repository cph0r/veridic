#!/usr/bin/env node
// Print the code to read for a feature in one call: scope's read_list ranges, in
// priority order, numbered, each with why it is included. Seeds as for scope,
// or --scope <scope.json>. --budget caps a page (characters); the footer gives
// the command for the next page.

import fs from "node:fs";
import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { scope } from "../../core/scope.mjs";
import { findOpenapi, loadContract } from "../../core/contract.mjs";
import { bundle } from "../../core/read.mjs";
import { parseArgs, fail, run, writeAll } from "./_cli.mjs";

const usage = 'read.mjs --repo <path> [--scope <scope.json> | "<METHOD /path>" | <file> | <symbol> ...] [--budget 120000] [--from <n>]';

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "scope", "budget", "from", "entry"] });
  if (!a.repo || (!a.scope && !a._.length)) fail("need --repo and --scope or at least one seed", usage);
  let sc;
  if (a.scope) sc = JSON.parse(fs.readFileSync(a.scope, "utf8"));
  else {
    const g = openGraph(a.repo);
    const inv = routeInventory(g, { entry: a.entry });
    const openapiFile = findOpenapi(a.repo);
    sc = scope(g, inv, a._, { openapi: openapiFile ? loadContract(a.repo, openapiFile).ops : [] });
  }
  if (sc.error) fail(`scope: ${sc.error}`, usage);
  const r = bundle(a.repo, sc.read_list ?? [], { budget: a.budget ? Number(a.budget) : undefined, from: a.from ? Number(a.from) : 0 });
  const seeds = a.scope ? `--scope ${a.scope}` : a._.map((s) => JSON.stringify(s)).join(" ");
  const footer =
    r.next == null
      ? `\n=== end: ${r.printed} ranges, ${r.lines} lines (all ${r.total} read_list entries covered)\n`
      : `\n=== page ends: ${r.printed} ranges, ${r.lines} lines. Next page: plumb read ${seeds} --from ${r.next}\n`;
  writeAll(r.text + footer);
}, usage);
