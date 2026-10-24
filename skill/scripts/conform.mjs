#!/usr/bin/env node
// Run the conformance suite: checks generated from the specs (.veridic/conform/checks.json),
// against a running app at --url. The app's seed script (.veridic.json "conform": { "seed":
// "<command>" }) prints JSON: { "users": { "owner": { "headers": {…} }, "other": { "headers":
// {…} } }, "seeds": { "<param>": "<value>" } }. Run it on the original app first: a failure
// there means the spec or the seed is wrong; then on a rebuild, for its fidelity.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { conformChecks } from "../../core/conform/generate.mjs";
import { runChecks, checkUrl } from "../../core/conform/run.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "conform.mjs --repo <path> --url <base url> [--run-seed] [--allow-remote] [--checks-only]";

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "url"], bools: ["allow-remote", "checks-only", "run-seed"] });
  if (!a.repo) fail("need --repo", usage);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(a.repo, ".veridic.json"), "utf8")).conform ?? {}; } catch {}
  // The seed is a shell command from the repo's own config: it runs only when asked to.
  if (a.url && !a["checks-only"] && cfg.seed && !a["run-seed"]) fail(`.veridic.json's conform seed is a shell command: ${cfg.seed}\nRead it, then rerun with --run-seed to let it run.`, usage);
  const checks = await conformChecks(a.repo);
  const out = path.join(a.repo, ".veridic", "conform", "checks.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(checks, null, 1));
  if (a["checks-only"]) emit({ repo: a.repo, checks: checks.length, wrote: out }, 0);
  if (!a.url) fail("need --url (the running app), or --checks-only", usage);
  const bad = checkUrl(a.url, { allowRemote: !!a["allow-remote"] });
  if (bad) fail(bad, usage);
  let seed = { users: {}, seeds: {} };
  if (cfg.seed) {
    try { seed = JSON.parse(execSync(cfg.seed, { cwd: a.repo, encoding: "utf8", env: { ...process.env, VERIDIC_CONFORM_URL: a.url }, timeout: 300_000 })); } catch (e) { fail(`the seed command failed or didn't print JSON: ${e.message.slice(0, 300)}`); }
  }
  const r = await runChecks(checks, { url: a.url, users: seed.users ?? {}, seeds: seed.seeds ?? {} });
  // The last run, for the report: each check's outcome beside its example or journey.
  fs.writeFileSync(path.join(a.repo, ".veridic", "conform", "last.json"), JSON.stringify({ at: new Date().toISOString(), url: a.url, checks: r.checks, passed: r.passed, fidelity_pct: r.fidelity_pct, results: r.results }, null, 1));
  emit({ repo: a.repo, url: a.url, ...(cfg.seed ? {} : { note: "no conform.seed in .veridic.json: checks that need a user or a record aren't run" }), ...r }, r.failed.length ? 1 : 0);
}, usage);
