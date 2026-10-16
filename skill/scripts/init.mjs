#!/usr/bin/env node
// Set a repo up for Veridic: check Node and git, find codegraph (or install it
// with --install), build the code index (or bring it up to date), and check that
// routes are found. Prints a card; --json for JSON.

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { findCodegraph, ensureIndex, CODEGRAPH_PACKAGE } from "../../core/indexer.mjs";
import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { defaultSpecs } from "../../core/metrics.mjs";
import { renderCard } from "../../core/card.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "init.mjs --repo <path> [--install] [--json]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["install", "json"] });
  if (!a.repo) fail("need --repo", usage);
  const rows = [];
  const next = [];
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 5);
  rows.push(["node", `v${process.versions.node}${nodeOk ? "" : " (needs 22.5 or newer for node:sqlite)"}`, nodeOk]);
  let repo;
  try {
    repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: a.repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    rows.push(["repo", repo, true]);
  } catch {
    rows.push(["repo", `${path.resolve(a.repo)} is not a git repository`, false]);
  }
  let bin = findCodegraph();
  if (!bin && a.install && repo) {
    const r = spawnSync("npm", ["install", "-g", CODEGRAPH_PACKAGE], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    if (r.status === 0) bin = findCodegraph();
    else rows.push(["install", `npm install -g ${CODEGRAPH_PACKAGE} failed: ${(r.stderr || "").trim().split("\n").pop()}`, false]);
  }
  rows.push(["codegraph", bin ?? "not installed", !!bin]);
  if (!bin) next.push(`Install the code indexer: \`veridic init --install\` (runs \`npm i -g ${CODEGRAPH_PACKAGE}\`)`);

  const result = { node: nodeOk, repo: repo ?? null, codegraph: bin };
  if (repo && bin && nodeOk) {
    const idx = ensureIndex(repo, { build: true, sync: true, log: () => {} });
    result.index = idx.index;
    rows.push(["index", { built: `built in ${(idx.ms / 1000).toFixed(1)}s`, synced: `updated ${idx.changed} changed file(s) in ${(idx.ms / 1000).toFixed(1)}s`, current: "current" }[idx.index] ?? idx.index, true]);
    try {
      const inv = routeInventory(openGraph(repo));
      result.routes = inv.routes.length;
      rows.push(["routes", inv.routes.length ? `${inv.routes.length} found (entry ${inv.entry})` : "none found: Veridic's route checks need an Express app", inv.routes.length ? true : null]);
    } catch (e) {
      rows.push(["routes", e.message, false]);
    }
    const specs = defaultSpecs(repo);
    result.specs = specs.length;
    rows.push(["specs", specs.length ? `${specs.length} tracked *spec.md` : "none yet", specs.length ? true : null]);
    next.push(specs.length ? "See every number: `veridic metrics --card`" : "Write your first spec: `/veridic:spec <feature>` in Claude Code, or `veridic routes <word>` to pick one");
    next.push("Check an API before handing it to agents: `veridic agent-ready --md`");
  }
  const ok = rows.every(([, , good]) => good !== false);
  if (a.json) emit({ ...result, ready: ok, next }, ok ? 0 : 1);
  writeAll(renderCard({ title: "init", rows, verdict: { ok, text: ok ? "READY" : "NOT READY" }, next }));
  process.exit(ok ? 0 : 1);
}, usage);
