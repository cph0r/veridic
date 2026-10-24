#!/usr/bin/env node
// The facts a UI spec needs, per screen group: each page's URL, the API routes it calls
// (itself and through what it imports) and its form fields; and the app's design tokens.
// The spec agent writes what the code can't say (what each screen shows: loading, empty,
// error, success). --group <id> for one group; --md for Markdown, else JSON.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { screenGroups } from "../../core/screens.mjs";
import { repoFiles } from "../../core/citations.mjs";
import { screenFacts, designTokens } from "../../core/tokens.mjs";
import { findModules } from "../../core/modules.mjs";
import { linkUi } from "../../core/ui.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "screens.mjs --repo <path> [--group <id>] [--md]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "group"], bools: ["md"] });
  if (!a.repo) fail("need --repo", usage);
  const g = openGraph(a.repo);
  const inv = routeInventory(g);
  const routes = inv.routes;
  // Which routes each UI file calls, as ui.mjs links them (clients, hooks, API_BASE URLs), each
  // with the method it's called with: an API address only shown as text is no call. API client
  // files are left out: they hold every route, used by this screen or not.
  let linked = null;
  try { linked = new Map(linkUi(a.repo, routes, findModules(g, inv), { methods: true }).files.filter((u) => u.kind !== "client").map((u) => [u.file, u.routes ?? []])); } catch {}
  const groups = screenGroups(a.repo, { all: repoFiles(a.repo), routes: routes.map((r) => ({ file: r.file })), specs: [], ui: [] }).filter((sg) => !a.group || sg.id === a.group);
  if (a.group && !groups.length) fail(`no screen group ${a.group}`, usage);
  const out = groups.map((sg) => ({ id: sg.id, name: sg.name, spec_path: sg.spec_path, pages: sg.pages.map((p) => screenFacts(a.repo, p, { routes, url: sg.urls?.[p] ?? null, linked })) }));
  const tokens = designTokens(a.repo);
  if (!a.md) emit({ repo: a.repo, groups: out, tokens }, 0);
  const L = ["# Screens (generated)", ""];
  for (const g of out) {
    L.push(`## ${g.name} (\`${g.id}\`, spec: \`${g.spec_path}\`)`, "");
    for (const p of g.pages) {
      L.push(`### ${p.url ?? p.file}`, "", `- File: \`${p.file}\``, `- Calls: ${p.calls.length ? p.calls.map((c) => `\`${c}\``).join(", ") : "none found"}`);
      for (const f of p.forms) L.push(`- Form: ${f.fields.map((x) => `${x.name} (${x.type}${x.required ? ", required" : ""})`).join(", ")}`);
      L.push("");
    }
  }
  const tk = (label, o) => (Object.keys(o).length ? [`- ${label}: ${Object.entries(o).map(([k, v]) => `\`${k}\` ${v}`).join(", ")}`] : []);
  L.push("## Design tokens", "", ...tk("Colours", tokens.colors), ...tk("Fonts", tokens.fonts), ...tk("Spacing", tokens.spacing), ...tk("Radii", tokens.radii), "");
  writeAll(L.join("\n"));
  process.exit(0);
}, usage);
