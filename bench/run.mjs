#!/usr/bin/env node
// Benchmark Veridic on public Express apps, pinned to exact commits (repos.json).
// For each app: index it, find its routes (and compare with an independent scan),
// run the agent-readiness check (and score its issues against verdicts.json),
// and audit its tests. Writes results.json and RESULTS.md next to this file.
//
//   node bench/run.mjs [--cache <dir>] [name …]
//
// Clones go to --cache (default: $TMPDIR/veridic-bench). Only reads the apps: it
// never installs their dependencies or runs their code.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openGraph } from "../core/graph.mjs";
import { routeInventory } from "../core/routes.mjs";
import { effectManifest, readiness } from "../core/effects.mjs";
import { auditTests } from "../core/tests.mjs";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const cacheAt = args.indexOf("--cache");
const cache = cacheAt >= 0 ? path.resolve(args[cacheAt + 1]) : path.join(os.tmpdir(), "veridic-bench");
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--cache");
const { repos, holdout_first_run: firstRun } = JSON.parse(fs.readFileSync(path.join(HERE, "repos.json"), "utf8"));
const verdicts = JSON.parse(fs.readFileSync(path.join(HERE, "verdicts.json"), "utf8"));
const git = (cwd, a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Clone the app at its pinned commit (shallow), or reuse the clone. */
function checkout(r) {
  const dir = path.join(cache, r.name);
  if (fs.existsSync(path.join(dir, ".git")) && git(dir, ["rev-parse", "HEAD"]) === r.sha) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["remote", "add", "origin", r.url]);
  git(dir, ["fetch", "-q", "--depth", "1", "origin", r.sha]);
  git(dir, ["checkout", "-q", "FETCH_HEAD"]);
  return dir;
}

/**
 * Independent route count, per file: a plain text scan that shares no code with
 * Veridic. Comments skipped; test, client and fixture files left out.
 */
function independentScan(repo) {
  const M = "(get|post|put|patch|delete|all|options|head)";
  const direct = new RegExp(`\\b(\\w+)\\s*\\.\\s*${M}\\s*\\(\\s*(['"\`])(/[^'"\`]*|\\*)\\3`, "g");
  const chain = new RegExp(`\\.\\s*route\\s*\\(\\s*(['"\`])([^'"\`]+)\\1\\s*\\)((?:\\s*\\.\\s*${M}\\s*\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\))+)`, "g");
  const notServer = new Set(["axios", "request", "http", "https", "supertest", "agent", "fetch", "client", "api", "$http", "cy", "res", "response", "Promise"]);
  const per = {};
  for (const f of git(repo, ["ls-files"]).split("\n")) {
    if (!/\.[cm]?[jt]s$/.test(f) || /(test|spec)\.|\/tests?\/|__tests__|node_modules|frontend\/|client\/|cypress|\.d\.ts$|codefixes\//.test(f)) continue;
    let src = fs.readFileSync(path.join(repo, f), "utf8");
    src = src.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length)).replace(/^\s*\/\/.*$/gm, "");
    let n = [...src.matchAll(direct)].filter((m) => !notServer.has(m[1])).length;
    for (const m of src.matchAll(chain)) n += (m[3].match(new RegExp(`\\.\\s*${M}\\s*\\(`, "g")) ?? []).length;
    if (n) per[f] = n;
  }
  return per;
}

const timed = (fn) => {
  const t = performance.now();
  const value = fn();
  return [value, Math.round(performance.now() - t)];
};

const results = [];
for (const r of repos.filter((x) => !only.length || only.includes(x.name))) {
  process.stderr.write(`${r.name}: `);
  const dir = checkout(r);
  const files = git(dir, ["ls-files"]).split("\n").filter(Boolean).length;
  fs.rmSync(path.join(dir, ".codegraph"), { recursive: true, force: true });
  const [init, indexMs] = timed(() => spawnSync(process.execPath, [path.join(ROOT, "skill/scripts/init.mjs"), "--repo", dir, "--json"], { encoding: "utf8" }));
  if (init.status !== 0) {
    process.stderr.write(`init failed\n${init.stdout}${init.stderr}\n`);
    continue;
  }
  const [inv, routesMs] = timed(() => routeInventory(openGraph(dir)));
  const found = {};
  for (const x of inv.routes) found[x.file] = (found[x.file] ?? 0) + 1;
  const scan = independentScan(dir);
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const mismatched = [...new Set([...Object.keys(found), ...Object.keys(scan)])].filter((f) => (found[f] ?? 0) !== (scan[f] ?? 0));
  const [ready, readyMs] = timed(() => readiness(effectManifest(openGraph(dir), inv)));
  const graded = ready.issues.filter((i) => i.severity !== "low");
  const v = verdicts[r.name] ?? {};
  const judged = graded.map((i) => v[`${i.kind} ${i.tool}`]?.[0]);
  const [auditFull, auditMs] = timed(() => auditTests(dir));
  const audit = auditFull.summary;
  const tv = verdicts._tests?.[r.name] ?? {};
  const nothing = [...auditFull.flagged.unasserted, ...auditFull.flagged.empty].map((x) => tv[x.at]?.[0]);
  results.push({
    name: r.name,
    set: r.set,
    url: r.url,
    sha: r.sha,
    files,
    routes: { found: inv.routes.length, independent: sum(scan), files_mismatched: mismatched },
    ...(firstRun?.[r.name] ? { holdout_first_run: firstRun[r.name] } : {}),
    agent_ready: { ...ready.summary, graded_issues: graded.length, judged_true: judged.filter((x) => x === true).length, judged_false: judged.filter((x) => x === false).length, unjudged: judged.filter((x) => x == null).length },
    tests: { ...audit, nothing_judged_true: nothing.filter((x) => x === true).length, nothing_judged_false: nothing.filter((x) => x === false).length, nothing_unjudged: nothing.filter((x) => x == null).length },
    ms: { index: indexMs, routes: routesMs, agent_ready: readyMs, test_audit: auditMs },
  });
  process.stderr.write(`${inv.routes.length} routes, ${graded.length} issues, ${audit.tests} tests (${indexMs + routesMs + readyMs + auditMs} ms)\n`);
}

// --- report ----------------------------------------------------------------
const total = (k, f) => results.reduce((n, x) => n + f(x), 0);
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "—");
const routesFound = total("", (x) => x.routes.found);
const routesIndep = total("", (x) => x.routes.independent);
const exact = results.filter((x) => !x.routes.files_mismatched.length).length;
const issues = total("", (x) => x.agent_ready.graded_issues);
const tp = total("", (x) => x.agent_ready.judged_true);
const fp = total("", (x) => x.agent_ready.judged_false);
const unjudged = total("", (x) => x.agent_ready.unjudged);
const tests = total("", (x) => x.tests.tests);
const nothing = total("", (x) => x.tests.unasserted + x.tests.empty);
const weak = total("", (x) => x.tests.weak);
const nothingTrue = total("", (x) => x.tests.nothing_judged_true);
const nothingJudged = nothingTrue + total("", (x) => x.tests.nothing_judged_false);
const holdouts = results.filter((x) => x.holdout_first_run);
const hFirst = holdouts.reduce((n, x) => n + x.holdout_first_run.found, 0);
const hIndep = holdouts.reduce((n, x) => n + x.holdout_first_run.independent, 0);
const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

const md = [
  "# Veridic benchmark",
  "",
  `${results.length} public Express apps, pinned to exact commits ([repos.json](repos.json)). Reproduce with \`node bench/run.mjs\`. Veridic only reads the apps; it never installs or runs them.`,
  "",
  "## Summary",
  "",
  `| Measure | Result |`,
  `|---|---|`,
  `| Routes found | **${routesFound}** of ${routesIndep} counted by an independent scan; ${exact} of ${results.length} apps match file by file |`,
  ...(holdouts.length ? [`| Holdout apps, first run | ${hFirst} of ${hIndep} routes (${pct(hFirst, hIndep)}) before the fix they prompted; ${holdouts.reduce((n, x) => n + x.routes.found, 0)} of ${holdouts.reduce((n, x) => n + x.routes.independent, 0)} now |`] : []),
  `| Agent-readiness issues (high + medium) | **${tp} of ${tp + fp} confirmed by hand (${pct(tp, tp + fp)} precision)**${unjudged ? `; ${unjudged} not yet reviewed` : ""} |`,
  `| Tests audited | ${tests.toLocaleString("en")} tests: **${nothing} assert nothing** (${nothingTrue} of ${nothingJudged} confirmed by hand), ${weak} only loose checks |`,
  `| Time per app | ${fmtMs(Math.max(...results.map((x) => x.ms.index + x.ms.routes + x.ms.agent_ready + x.ms.test_audit)))} at most, indexing included |`,
  "",
  "## Per app",
  "",
  "| App | Set | Routes (independent) | Read / write / destructive | GETs that write | Issues: high / med (confirmed) | Tests (assert nothing / weak) | Time |",
  "|---|---|---:|---|---:|---|---|---:|",
  ...results.map((x) => {
    const a = x.agent_ready;
    return `| [${x.name}](${x.url}/tree/${x.sha}) | ${x.set} | ${x.routes.found} (${x.routes.independent}) | ${a.reads} / ${a.writes} / ${a.destructive} | ${a.gets_that_write} | ${a.issues.high} / ${a.issues.medium} (${a.judged_true} of ${a.judged_true + a.judged_false}) | ${x.tests.tests} (${x.tests.unasserted + x.tests.empty} / ${x.tests.weak}) | ${fmtMs(x.ms.index + x.ms.routes + x.ms.agent_ready + x.ms.test_audit)} |`;
  }),
  "",
  "## How each number is measured",
  "",
  "- **Routes:** Veridic's route list is compared, per file, with an independent text scan in this script that shares no code with Veridic (direct `x.get('/path')` calls and `route('/path').get()` chains, comments skipped). Code snippets kept as data (Juice Shop's `data/static/codefixes`) aren't served routes and are left out of both.",
  "- **Holdout:** the holdout apps were run only after route discovery had been improved on the dev apps. Their first-run result is recorded before the one fix they prompted (an app handed into a function, `require('./routes')(app)`).",
  "- **Issues:** every high and medium issue was read against the source at the pinned commit; each verdict and its reason is in [verdicts.json](verdicts.json). Low issues aren't graded.",
  "- **Tests:** every `it`/`test` in the repo is classified by what it checks. *Assert nothing*: no assertion, or only one on a literal. *Weak*: only loose checks (`toBeTruthy`, `toBeDefined`, bare `toHaveBeenCalled()`); many are reasonable existence checks, so this column is informational.",
  "",
  "## Known misses",
  "",
  "- Juice Shop `PUT /api/BasketItems/:id` edits a basket item the caller may not own. Its route uses `appendUserId()`, which Veridic takes as caller scoping; the handler doesn't use it.",
  "- bulletproof-nodejs mounts its API under `config.api.prefix`, a value only known at run time, so its routes are listed without that prefix.",
  "",
].join("\n");

fs.writeFileSync(path.join(HERE, "results.json"), JSON.stringify({ generated: new Date().toISOString().slice(0, 10), results }, null, 2) + "\n");
fs.writeFileSync(path.join(HERE, "RESULTS.md"), md);
process.stderr.write(`wrote bench/RESULTS.md and bench/results.json\n`);
