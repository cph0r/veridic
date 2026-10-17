// The report: everything Veridic knows about a repo, gathered once and rendered as
// one self-contained HTML page (no server, no network, no LLM). Tabs: overview,
// specs (requirements with their cited code, tests and freshness), routes (what
// each really does and who can call it), findings (each with a suggested fix),
// tests (what they check), and the change in progress (claim, strays, untested).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openGraph } from "./graph.mjs";
import { routeInventory } from "./routes.mjs";
import { effectManifest, readiness } from "./effects.mjs";
import { auditTests, testCoverage } from "./tests.mjs";
import { metrics, defaultSpecs } from "./metrics.mjs";
import { checkCitations } from "./citations.mjs";
import { staleness } from "./staleness.mjs";
import { doneWithoutSpec, loadClaim } from "./seam.mjs";

const MAX_SNIPPET = 40; // lines of cited code shown per citation

// What to do about each kind of finding. Deterministic: the same finding always
// gets the same advice; the evidence lines say where.
export const FIXES = {
  "get-that-writes": "Make it a POST/PUT/DELETE, or move the write out of the GET. Crawlers, prefetchers and AI agents treat GET as safe to call.",
  "money-not-scoped": "Load the order/payment with the caller's id in the query (e.g. where: { id, userId: req.user.id }) before moving money.",
  "user-id-from-url": "Use the signed-in user's id (req.user.id) instead of the one in the URL, or reject when they differ.",
  "identity-from-request-body": "Take who the action is for from the session, not the request body; ignore or reject a body field that names another user.",
  "id-param-without-caller-scope": "Scope the lookup to the caller (where: { id, ownerId: caller }) or add an ownership guard before acting on the id.",
  "id-param-scoped-by-client-values": "The ids that scope this come from the client; derive them from the session instead.",
  "policy-mismatch": "The guard on this route disagrees with the intended access policy: change the guard, or update the policy if the code is right.",
  unasserted: "This test runs code but checks nothing, so it passes even when the code is broken. Add an assertion on what its title promises.",
  empty: "This test has no body. Write it, or remove it.",
  weak: "Only loose checks (toBeDefined, toBeTruthy, called at all). Assert the actual value or arguments.",
  stray: "This change edits code another route runs. Revert it, or claim that route too (veridic claim) if it belongs to the task.",
  untested: "No asserting test reaching this code names the route or the changed function. Add one before calling it done.",
  stale: "The cited code changed since the spec was written. Re-read it and update the requirement (veridic stale --fix moves citations that only shifted).",
  unresolved: "This citation doesn't resolve to code. Fix the path or line range.",
};

// Each kind of finding in plain words: a title anyone can read, and why it matters.
export const KINDS = {
  "get-that-writes": { title: "GET request changes data", why: "Browsers prefetch GETs, crawlers follow them and AI agents call them freely, so data can change by accident." },
  "money-not-scoped": { title: "Moves money on IDs it doesn't check", why: "A signed-in user could pay, refund or move money on someone else's order." },
  "user-id-from-url": { title: "Trusts the user ID in the URL", why: "Anyone signed in can read or change another user's data by editing the URL." },
  "identity-from-request-body": { title: "Trusts who it's for from the request body", why: "A caller can act as, or for, someone else by sending their ID." },
  "id-param-without-caller-scope": { title: "Acts on any record by ID", why: "It never checks the record belongs to the caller, so knowing or guessing an ID is enough." },
  "id-param-scoped-by-client-values": { title: "Checks ownership with values the client sends", why: "The values meant to prove ownership come from the client, who can send anyone's." },
  "policy-mismatch": { title: "Access differs from the intended policy", why: "Who can call this route isn't who the access policy says should." },
  "test asserts nothing": { title: "Test checks nothing", why: "It runs the code but asserts nothing, so it passes even when the code is broken." },
  "empty test": { title: "Empty test", why: "It has no body, so it tests nothing." },
  "weak test": { title: "Test only checks loosely", why: "Checks like toBeDefined or toHaveBeenCalled() pass for almost any value." },
  "stale requirement": { title: "Spec out of date with the code", why: "The code this requirement cites changed after the spec was written." },
  "citation doesn't resolve": { title: "Spec points at code that isn't there", why: "The cited file or lines don't exist, so the requirement can't be checked." },
  "stray edit": { title: "Edit outside the task", why: "The change touches code another route runs, which the task didn't claim." },
  untested: { title: "Changed code without a test", why: "No asserting test that reaches the change names the route or the changed function." },
  "a changed test asserts nothing": { title: "New or changed test checks nothing", why: "The test added with this change asserts nothing, so it can't catch a regression." },
};

const readLines = (repo, file) => {
  try {
    return fs.readFileSync(path.join(repo, file), "utf8").split("\n");
  } catch {
    return null;
  }
};

function specSection(repo, file, m) {
  const text = fs.readFileSync(file, "utf8");
  const cite = checkCitations(repo, text);
  let cov = { requirements: [] };
  try {
    cov = testCoverage(repo, text, { specPath: file });
  } catch {}
  let stale = new Set();
  try {
    stale = new Set((staleness(repo, text, { range: "HEAD" }).summary.stale_requirements ?? []).map((x) => x.fr ?? x));
  } catch {}
  const citesBy = new Map();
  for (const c of cite.citations ?? []) (citesBy.get(c.fr) ?? citesBy.set(c.fr, []).get(c.fr)).push(c);
  const ids = [...new Set([...cov.requirements.map((r) => r.id), ...citesBy.keys()])];
  const reqs = ids.map((id) => {
    const r = cov.requirements.find((x) => x.id === id) ?? {};
    const cites = (citesBy.get(id) ?? []).map((c) => {
      const lines = c.resolves ? readLines(repo, c.file) : null;
      return {
        cite: c.cite,
        file: c.file ?? null,
        start: c.start,
        end: c.end,
        resolves: !!c.resolves,
        problem: c.problem ?? null,
        code: lines ? lines.slice(c.start - 1, Math.min(c.end, c.start - 1 + MAX_SNIPPET)).join("\n") : null,
        truncated: lines ? c.end - c.start + 1 > MAX_SNIPPET : false,
      };
    });
    // Citations under a heading (a decision table, a contract section) aren't requirements.
    const requirement = /^(?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?$/.test(id);
    const text = (r.text ?? "").replace(/^\*\*[\w-]+\*\*\s*(?:\([^)]*\))?\s*:?\s*/, "");
    return { id, requirement, text, status: r.status ?? "none", tests: (r.tests ?? []).map((t) => (typeof t === "string" ? t : t.at ?? `${t.file}:${t.line}`)), stale: stale.has(id), cites };
  });
  return { spec: m.spec, path: path.relative(repo, file), numbers: m, requirements: reqs };
}

function untrackedSpecs(repo) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "*spec.md"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).map((f) => path.join(repo, f));
  } catch {
    return [];
  }
}

/** Everything the report shows, as data (also what `veridic report --json` prints). */
export async function collectReport(repo, { specs: specFiles } = {}) {
  const out = { repo, name: path.basename(repo), generated: new Date().toISOString(), errors: [] };
  const note = (where, e) => out.errors.push(`${where}: ${e.message ?? e}`);

  // Routes: effect, access, evidence.
  try {
    const g = openGraph(repo);
    const inv = routeInventory(g);
    const manifest = effectManifest(g, inv);
    const r = readiness(manifest);
    out.routes = manifest.map((t) => ({ id: t.tool, method: t.method, path: t.path, effect: t.effect, moves_money: t.moves_money, external: t.external, notifies: t.notifies, access: t.requires.access, scoped: t.requires.scoped_to_caller, handler: t.handler, evidence: t.evidence.map((e) => ({ kind: e.kind, at: e.at, via: e.via ?? null })), flags: t.access_flags }));
    out.readiness = r.summary;
    out.findings = r.issues.map((i) => ({ area: "API", severity: i.severity, kind: i.kind, where: i.tool, text: i.text, evidence: i.evidence, fix: FIXES[i.kind] ?? null }));
  } catch (e) {
    note("routes", e);
    out.routes = [];
    out.findings = [];
  }

  // Tests: strength across the repo.
  try {
    const a = auditTests(repo);
    out.tests = { summary: a.summary, flagged: a.flagged };
    for (const k of ["empty", "unasserted"]) for (const t of a.flagged[k] ?? []) out.findings.push({ area: "Tests", severity: "medium", kind: k === "empty" ? "empty test" : "test asserts nothing", where: t.at, text: t.title, evidence: [t.at], fix: FIXES[k] });
    for (const t of (a.flagged.weak ?? []).slice(0, 200)) out.findings.push({ area: "Tests", severity: "low", kind: "weak test", where: t.at, text: t.title, evidence: [t.at], fix: FIXES.weak });
  } catch (e) {
    note("tests", e);
  }

  // Specs: requirements, citations with code, tests, freshness.
  // Committed specs, and new ones not committed yet (a spec under review is often new).
  const files = specFiles?.length ? specFiles : [...new Set([...defaultSpecs(repo), ...untrackedSpecs(repo)])];
  out.specs = [];
  if (files.length) {
    try {
      const m = metrics(repo, files, { mutate: false });
      files.forEach((f, i) => {
        try {
          const s = specSection(repo, f, m.specs[i]);
          out.specs.push(s);
          for (const r of s.requirements) {
            if (r.stale) out.findings.push({ area: "Spec", severity: "medium", kind: "stale requirement", where: `${s.path} ${r.id}`, text: r.text, evidence: r.cites.map((c) => c.cite), fix: FIXES.stale });
            for (const c of r.cites.filter((c) => !c.resolves)) out.findings.push({ area: "Spec", severity: "medium", kind: "citation doesn't resolve", where: `${s.path} ${r.id}`, text: `${c.cite}: ${c.problem}`, evidence: [c.cite], fix: FIXES.unresolved });
          }
        } catch (e) {
          note(`spec ${f}`, e);
        }
      });
      out.coverage = m.coverage;
      out.attention = m.attention;
    } catch (e) {
      note("specs", e);
    }
  }

  // The change in progress: what the working tree changes against HEAD, checked against the claim.
  try {
    const claims = loadClaim(repo);
    const d = await doneWithoutSpec(repo, { claims });
    if (d.files?.length || d.tests?.length || claims.length) {
      out.change = { claims, done: d.done, problems: d.problems ?? [], files: d.files ?? [], seam: d.seam ?? null };
      for (const p of d.problems ?? []) {
        const kind = p.split(":")[0];
        out.findings.push({ area: "Change", severity: "high", kind: kind === "stray" ? "stray edit" : kind, where: "working tree", text: p.slice(kind.length + 1).trim(), evidence: [], fix: FIXES[kind] ?? null });
      }
    }
  } catch (e) {
    if (!/not a git|unknown revision|ambiguous argument 'HEAD'/i.test(e.message)) note("change", e);
  }

  const order = { high: 0, medium: 1, low: 2 };
  for (const f of out.findings) Object.assign(f, KINDS[f.kind] ?? { title: f.kind, why: "" });
  out.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return out;
}

/** The page: data embedded as JSON, rendered by report-page.js, styled by report-page.css. */
const asset = (name) => fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
export function renderReport(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = `Veridic · ${data.name}`.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${asset("report-page.css")}</style>
</head>
<body>
<div id="app"></div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script type="application/json" id="data">${json}</script>
<script>${asset("report-page.js")}</script>
</body>
</html>
`;
}
