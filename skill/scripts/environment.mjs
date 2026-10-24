#!/usr/bin/env node
// The environment an app needs: env vars (required, defaults), services, schedules and
// deployment. Names only, never values. --write saves it as specs/environment/spec.md;
// --md prints it as Markdown; else JSON.

import fs from "node:fs";
import path from "node:path";
import { environment, environmentMarkdown } from "../../core/environment.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "environment.mjs --repo <path> [--write] [--md]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["write", "md"] });
  if (!a.repo) fail("need --repo", usage);
  const env = environment(a.repo);
  if (a.write) {
    const out = path.join(a.repo, "specs", "environment", "spec.md");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, environmentMarkdown(env));
    emit({ repo: a.repo, wrote: out, vars: env.vars.length, services: env.services.length, schedules: env.schedules.length, deploy: env.deploy.length }, 0);
  }
  if (a.md) { writeAll(environmentMarkdown(env)); process.exit(0); }
  emit({ repo: a.repo, ...env }, 0);
}, usage);
