#!/usr/bin/env node
// The report: one page with everything Veridic knows about the repo (specs,
// routes, findings with suggested fixes, tests, the change in progress). Writes
// .codegraph/veridic-report.html (git-ignored) and opens it in the browser.
// --json prints the data instead; --no-open only writes the file.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { collectReport, renderReport } from "../../core/report.mjs";
import { parseArgs, emit, fail, run } from "./_cli.mjs";

const usage = "report.mjs --repo <path> [--spec <spec.md>[,…]] [--out <file.html>] [--no-open] [--json]";

function openInBrowser(file) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [file]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", file]] : ["xdg-open", [file]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

run(async () => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "out"], bools: ["no-open", "json"] });
  if (!a.repo) fail("need --repo", usage);
  const data = await collectReport(a.repo, { specs: a.spec ? String(a.spec).split(",").map((s) => path.resolve(s)) : null });
  if (a.json) emit(data, 0);
  const out = path.resolve(a.out ?? path.join(a.repo, ".codegraph", "veridic-report.html"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, renderReport(data));
  // Opening a browser is for a person at a terminal; an agent or CI gets the path.
  const opened = !a["no-open"] && process.stdout.isTTY && !process.env.CI ? openInBrowser(out) : false;
  const high = data.findings.filter((f) => f.severity === "high").length;
  emit({ wrote: out, opened, routes: data.routes.length, specs: data.specs.length, findings: { high, medium: data.findings.filter((f) => f.severity === "medium").length }, ...(data.errors.length ? { errors: data.errors } : {}) }, 0);
}, usage);
