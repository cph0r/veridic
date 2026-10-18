#!/usr/bin/env node
// The app's modules, as Veridic found them from the code: id, routes, what each
// does, its state (issues, untested routes, spec) and where its spec goes. Use the
// ids with `veridic prepare --module <id>`. --md prints a table instead of JSON.

import { loadModules, moduleList } from "../../core/modulectx.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "modules.mjs --repo <path> [--md]";

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["md"] });
  if (!a.repo) fail("need --repo", usage);
  const { data } = await loadModules(a.repo);
  const list = moduleList(data);
  if (!list.length) fail("no modules found: run `veridic init` so Veridic can index the code and find the routes", usage);
  if (a.md) {
    const rows = list.map((m) => `| \`${m.id}\` | ${m.name} | ${m.routes} | ${m.does.slice(0, 3).join(", ")} | ${m.issues.high ? `${m.issues.high} high` : m.issues.medium ? `${m.issues.medium} medium` : "—"} | ${m.untested}/${m.routes} | ${m.specs.length ? m.specs.map((s) => `\`${s}\``).join(", ") : "none"} |`);
    // The next step: write specs where there are none, else turn the riskiest module's rules into tests.
    const noSpec = list.filter((m) => !m.specs.length);
    const next = noSpec.length ? `/veridic:specs (${noSpec.length} module${noSpec.length === 1 ? "" : "s"} without a spec)` : `veridic tests --module ${list[0].id}`;
    writeAll(["| id | module | routes | does | issues | untested | spec |", "|---|---|---|---|---|---|---|", ...rows, "", `Next: ${next}`].join("\n") + "\n");
    return;
  }
  emit({ repo: a.repo, modules: list }, 0);
}, usage);
