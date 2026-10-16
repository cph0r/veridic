#!/usr/bin/env node
// The app's routes, one per line ("METHOD /path @ file:start-end"), optionally
// filtered by words that must all appear. Use it to pick seeds for prepare/scope.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { parseArgs, fail, run, writeAll } from "./_cli.mjs";

const usage = "routes.mjs --repo <path> [word ...] [--entry <app file>]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "entry"] });
  if (!a.repo) fail("need --repo", usage);
  const inv = routeInventory(openGraph(a.repo), { entry: a.entry });
  const words = a._.map((w) => w.toLowerCase());
  const rows = inv.routes.filter((r) => words.every((w) => `${r.id} ${r.file}`.toLowerCase().includes(w)));
  writeAll(`${rows.map((r) => `${r.id} @ ${r.file}:${r.start}-${r.end}`).join("\n")}\n${rows.length} of ${inv.routes.length} routes\n`);
}, usage);
