#!/usr/bin/env node
// A snapshot of everything Veridic reads from an app's routes: the inventory (entry, mounts,
// every route and its guards), access, effects and, when the app has an OpenAPI file, contract
// drift. Not a test file: capture before a refactor of route discovery, compare after.
//
//   node test/adapter-snapshot.mjs --repo <path> --out <file.json>
//   node test/adapter-snapshot.mjs --repo <path> --compare <file.json>   (exit 1 on any difference)

import fs from "node:fs";
import { openGraph } from "../core/graph.mjs";
import { routeInventory } from "../core/routes.mjs";
import { accessMatrix } from "../core/access.mjs";
import { effectManifest } from "../core/effects.mjs";
import { findOpenapi, loadContract, drift } from "../core/contract.mjs";

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const repo = arg("--repo");
if (!repo) { console.error("usage: adapter-snapshot.mjs --repo <path> (--out <file> | --compare <file>)"); process.exit(2); }

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
const byId = (a, b) => String(a.id ?? a.route ?? a.tool).localeCompare(String(b.id ?? b.route ?? b.tool)) || String(a.file ?? a.at).localeCompare(String(b.file ?? b.at));

const g = openGraph(repo);
const inv = routeInventory(g);
const { routes, ...rest } = inv;
const snap = {
  inventory: { ...rest, routes: routes.map(({ framework, ...r }) => r).sort(byId) },
  access: accessMatrix(g, inv).sort(byId),
  effects: effectManifest(g, inv).sort(byId),
};
const openapi = findOpenapi(repo);
if (openapi) snap.drift = drift(g, loadContract(repo, openapi), inv.routes);
const metrics = sortKeys(snap);

const out = arg("--out"), cmp = arg("--compare");
if (out) { fs.writeFileSync(out, JSON.stringify(metrics, null, 1)); console.log(`wrote ${out}: ${routes.length} routes`); process.exit(0); }
if (cmp) {
  const before = JSON.parse(fs.readFileSync(cmp, "utf8"));
  const diffs = [];
  const walk = (a, b, at) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (a && b && typeof a === "object" && typeof b === "object") { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], at ? `${at}.${k}` : k); return; }
    diffs.push(`${at}: ${JSON.stringify(a)?.slice(0, 120)} -> ${JSON.stringify(b)?.slice(0, 120)}`);
  };
  walk(before, metrics, "");
  if (!diffs.length) { console.log(`same: ${routes.length} routes, access, effects${openapi ? ", drift" : ""} identical`); process.exit(0); }
  console.log(diffs.slice(0, 40).join("\n") + (diffs.length > 40 ? `\n… ${diffs.length - 40} more` : ""));
  process.exit(1);
}
console.log(JSON.stringify(metrics, null, 1));
