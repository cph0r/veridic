#!/usr/bin/env node
// The feature's state machine from code: who writes each status, from which
// state, and deterministic hints for bug-shaped patterns. Seeds as for scope.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { scope } from "../../core/scope.mjs";
import { stateMachine, stateMachineMarkdown } from "../../core/states.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = 'states.mjs --repo <path> "<METHOD /path>" ... [--md]';

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["md"] });
  if (!a.repo || !a._.length) fail("need --repo and at least one seed", usage);
  const g = openGraph(a.repo);
  const sc = scope(g, routeInventory(g), a._);
  if (sc.error) fail(`scope: ${sc.error}`, usage);
  const sm = stateMachine(g, sc);
  if (a.md) {
    writeAll(stateMachineMarkdown(sm) || "No status writes found in this feature's code.\n");
    process.exit(0);
  }
  emit(sm, 0);
}, usage);
