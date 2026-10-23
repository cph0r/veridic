#!/usr/bin/env node
// Public sample apps for checking framework support on real code: each cloned once into
// $TMPDIR/veridic-samples/<name> at its pinned commit, indexed, and its routes counted.
// Not a test file (network, minutes): run it at a checkpoint.
//
//   node test/samples.mjs [name …]

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openGraph } from "../core/graph.mjs";
import { routeInventory } from "../core/routes.mjs";

const samples = JSON.parse(fs.readFileSync(new URL("./samples.json", import.meta.url), "utf8"));
const want = process.argv.slice(2);
const root = path.join(process.env.TMPDIR ?? os.tmpdir(), "veridic-samples");
const bin = new URL("../bin/veridic", import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

for (const s of samples.filter((x) => !want.length || want.includes(x.name))) {
  const dir = path.join(root, s.name);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", s.url);
  }
  let head = "";
  try { head = git(dir, "rev-parse", "HEAD"); } catch {} // a fresh clone has no commit yet
  if (!head.startsWith(s.sha)) {
    const full = git(dir, "ls-remote", "origin").split("\n").map((l) => l.split("\t")[0]).find((h) => h.startsWith(s.sha)) ?? s.sha;
    git(dir, "fetch", "-q", "--depth", "1", "origin", full);
    git(dir, "checkout", "-q", "FETCH_HEAD");
  }
  execFileSync(bin, ["init", "--repo", dir, "--no-specs", "--no-tests"], { stdio: "ignore" });
  const routes = routeInventory(openGraph(dir)).routes;
  const by = (k) => routes.reduce((m, r) => ((m[r[k]] = (m[r[k]] ?? 0) + 1), m), {});
  console.log(`${s.name}@${s.sha}: ${routes.length} routes`, JSON.stringify(by("method")), JSON.stringify(by("framework")));
}
