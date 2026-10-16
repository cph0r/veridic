#!/usr/bin/env node
// The app's actual access matrix from code (who can call each route, whether a
// paid-plan check runs on the server, whether data is limited to the caller),
// and its mismatches with an intended matrix CSV (--intended). Filter routes
// with words, as for `routes`.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { accessMatrix, loadIntended, compareAccess, accessMarkdown } from "../../core/access.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "access.mjs --repo <path> [--intended <access.csv>] [--md] [word ...]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "intended", "entry"], bools: ["md"] });
  if (!a.repo) fail("need --repo", usage);
  const words = a._.map((w) => w.toLowerCase());
  const matrix = accessMatrix(openGraph(a.repo), routeInventory(openGraph(a.repo), { entry: a.entry })).filter((r) => words.every((w) => r.route.toLowerCase().includes(w)));
  const comparison = a.intended ? compareAccess(matrix, loadIntended(a.intended)) : null;
  const flagged = matrix.filter((r) => r.flags.length).length;
  if (a.md) {
    writeAll(accessMarkdown(matrix, comparison));
    process.exit(comparison?.mismatches.length ? 1 : 0);
  }
  emit(
    { repo: a.repo, summary: { routes: matrix.length, public: matrix.filter((r) => r.access === "public").length, plan_checked: matrix.filter((r) => r.plan === "pro").length, flagged, ...(comparison ? { checked: comparison.checked, mismatches: comparison.mismatches.length } : {}) }, ...(comparison ? { mismatches: comparison.mismatches } : {}), flagged: matrix.filter((r) => r.flags.length) },
    comparison?.mismatches.length ?? 0,
  );
}, usage);
