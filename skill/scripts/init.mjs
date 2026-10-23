#!/usr/bin/env node
// Set a repo up for Veridic: check Node and git, find codegraph (or install it
// with --install), build the code index (or bring it up to date), and check that
// routes are found. --enforce opts the repo in to the Stop hook (.veridic.json):
// Claude can't finish while `veridic done` says NOT DONE. Prints a card; --json for JSON.
// At a terminal, when modules have no spec, it offers to start Claude Code on
// /veridic:specs (one agent per module, riskiest first); --specs starts it without
// asking, --no-specs never offers. Under CI or an agent it only lists the next step.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findCodegraph, ensureIndex, CODEGRAPH_PACKAGE } from "../../core/indexer.mjs";
import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { defaultSpecs } from "../../core/metrics.mjs";
import { renderCard } from "../../core/card.mjs";
import { loadModules } from "../../core/modulectx.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "init.mjs --repo <path> [--install] [--enforce] [--specs | --no-specs] [--json]";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

function hasClaude() {
  return spawnSync("claude", ["--version"], { stdio: "ignore" }).status === 0;
}
async function ask(question) {
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}
// Start Claude Code in this terminal on /veridic:specs. If the plugin isn't installed,
// load it from this copy of Veridic for the session.
function startSpecs(repo) {
  const listed = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" }).stdout ?? "";
  const args = /\bveridic@/.test(listed) ? [] : ["--plugin-dir", ROOT];
  return spawnSync("claude", [...args, "/veridic:specs"], { cwd: repo, stdio: "inherit" }).status ?? 1;
}

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["install", "json", "enforce", "specs", "no-specs"] });
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
    if (a.enforce) {
      const file = path.join(repo, ".veridic.json");
      let cfg = {};
      try {
        cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      cfg.stop = [...new Set([...(cfg.stop ?? []), "done", "stale"])];
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
      result.enforce = cfg.stop;
      rows.push(["enforce", "on: Claude can't finish while `veridic done` says NOT DONE (.veridic.json; commit it to share)", true]);
    }
    const specs = defaultSpecs(repo);
    result.specs = specs.length;
    rows.push(["specs", specs.length ? `${specs.length} tracked *spec.md` : "none yet", specs.length ? true : null]);
    // Modules with no written rules: the next step, and what --specs (or a yes) hands to Claude.
    if (result.routes) {
      try {
        const { data, modules } = await loadModules(repo);
        result.modules = modules.length;
        // Specs not committed yet count too; say so, since only committed ones are safe.
        const all = (data.specs ?? []).length;
        if (all > specs.length) {
          result.specs = all;
          const i = rows.findIndex(([k]) => k === "specs");
          rows[i] = ["specs", `${all} *spec.md, ${all - specs.length} not committed yet`, null];
        }
        result.modules_without_spec = modules.filter((m) => !m.specs.length).map((m) => m.id);
        rows.push(["parts", `${modules.length} found${result.modules_without_spec.length ? `, ${result.modules_without_spec.length} with no spec` : ", every one has a spec"}`, result.modules_without_spec.length ? null : true]);
      } catch (e) {
        rows.push(["parts", e.message, null]);
      }
    }
    if (result.modules_without_spec?.length) next.push(`Draft specs for ${result.modules_without_spec.length} parts, riskiest first: \`/veridic:specs\` in Claude Code, or \`veridic init --specs\``);
    else next.push(result.specs ? "See every number: `veridic metrics --card`" : "Write your first spec: `/veridic:spec <feature>` in Claude Code, or `veridic routes <word>` to pick one");
    next.push("See the whole app: `veridic report`");
    next.push("Check an API before handing it to agents: `veridic agent-ready --md`");
  }
  const ok = rows.every(([, , good]) => good !== false);
  if (a.json) emit({ ...result, ready: ok, next }, ok ? 0 : 1);
  writeAll(renderCard({ title: "init", rows, verdict: { ok, text: ok ? "READY" : "NOT READY" }, next }));
  // The handoff: only with a person at the terminal (or --specs), never in CI or under an agent.
  const missing = result.modules_without_spec?.length ?? 0;
  const person = process.stdin.isTTY && process.stdout.isTTY && !process.env.CI && !process.env.CLAUDECODE;
  if (ok && missing && !a["no-specs"] && (a.specs || person) && hasClaude()) {
    const go = a.specs || (await ask(`\n${missing} part${missing === 1 ? " has" : "s have"} no written rules. Start Claude Code to draft them, riskiest first? It asks before starting any agents. [y/N] `));
    if (go) process.exit(startSpecs(repo));
  }
  process.exit(ok ? 0 : 1);
}, usage);
