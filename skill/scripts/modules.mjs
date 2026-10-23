#!/usr/bin/env node
// The app's parts (server modules and screen groups), as Veridic found them from the code: id, routes, what each
// does, its state (issues, untested routes, spec) and where its spec goes. Use the
// ids with `veridic prepare --module <id>`. --md prints a table instead of JSON.

import { loadModules, moduleList, partsTable } from "../../core/modulectx.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "modules.mjs --repo <path> [--md]";

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["md"] });
  if (!a.repo) fail("need --repo", usage);
  const { data } = await loadModules(a.repo);
  const list = moduleList(data);
  if (!list.length) fail("no parts found: run `veridic init` so Veridic can index the code and find the routes", usage);
  if (a.md) {
    writeAll(partsTable(list));
    return;
  }
  emit({ repo: a.repo, modules: list }, 0);
}, usage);
