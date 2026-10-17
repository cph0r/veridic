#!/usr/bin/env node
// Before editing: record what this task will change, as routes ("POST /api/x")
// or files. `veridic done` (and the Stop hook) then check the change against it:
// anything changed outside the code those routes run is a stray. Prints the
// impact of the claim, so the agent sees what it is about to touch.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { impact } from "../../core/impact.mjs";
import { saveClaim } from "../../core/seam.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = 'claim.mjs --repo <path> <"METHOD /path" | file> …';

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: [] });
  if (!a.repo || !a._.length) fail("need --repo and the routes or files this task will change", usage);
  const g = openGraph(a.repo);
  const r = impact(g, routeInventory(g), a._);
  if (r.unknown?.length) fail(`not a route or file here: ${r.unknown.join(", ")}`, usage);
  saveClaim(a.repo, a._);
  emit({ claimed: a._, ...r, next: "Make the change, then run `veridic done --card`" });
}, usage);
