// Every veridic number in one pass, for one or more specs: are the citations
// right (resolve, support their claims), will they survive change (anchored,
// in step with the code, dependencies cited), and how much of the API is
// specified at all. Read-only.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseSpec, checkCitations, makeResolver } from "./citations.mjs";
import { checkClaims } from "./claims.mjs";
import { syncSpec, staleness } from "./staleness.mjs";
import { mutationScore } from "./mutate.mjs";
import { openSymbols } from "./anchors.mjs";
import { openGraph } from "./graph.mjs";
import { routeInventory } from "./routes.mjs";
import { testCoverage } from "./tests.mjs";
import { recordedBasis } from "./basis.mjs";

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

/** Is this spec file tracked in the repo (so "in step" can compare against its committed version)? */
function tracked(repo, file) {
  const rel = path.relative(repo, path.resolve(file));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], { cwd: repo, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Numbers for one spec. */
export function specMetrics(repo, file, opts = {}) {
  const text = fs.readFileSync(file, "utf8");
  const symbols = opts.symbols ?? openSymbols(repo);
  const cite = checkCitations(repo, text);
  const parsed = parseSpec(text);
  const claims = checkClaims(repo, text, { symbols });
  const m = {
    // Relative to where it was run, unless that climbs out more than one level.
    spec: (() => {
      const rel = path.relative(process.cwd(), path.resolve(file));
      return rel.startsWith("../../") ? file : rel || file;
    })(),
    requirements: cite.summary.requirements,
    citations: cite.summary.citations,
    citations_resolving_pct: pct(cite.summary.resolving, cite.summary.citations),
    citations_with_warnings: cite.summary.with_warnings,
    anchored_pct: pct(parsed.citations.filter((c) => c.anchor).length, parsed.citations.length),
    claim_support_pct: claims.summary.support_rate == null ? null : Math.round(claims.summary.support_rate * 1000) / 10,
    claims_with_misplaced_facts: claims.summary.claims_with_misplaced_facts,
  };

  // In step with the code: against the committed spec when tracked, else against HEAD.
  try {
    if (tracked(repo, file)) {
      const s = syncSpec(repo, file, { symbols });
      Object.assign(m, { stale_requirements: s.open.length, citations_to_update: s.applied, conflicts: s.conflicts.length, freshness_baseline: "committed spec vs working tree" });
    } else {
      const rel = path.relative(repo, file);
      const r = staleness(repo, text, { range: "HEAD", symbols, ...(rel.startsWith("..") ? {} : { specFile: rel }) });
      Object.assign(m, { stale_requirements: r.summary.stale_requirements.length, citations_to_update: r.fixes.length, conflicts: r.conflicts.length, freshness_baseline: "HEAD vs working tree (spec outside repo)" });
    }
  } catch (e) {
    m.freshness_error = e.message;
  }

  // Requirements with a named test that reaches their cited code (and, with runTests, whether it passes).
  try {
    const t = testCoverage(repo, text, { specPath: file, run: !!opts.runTests });
    Object.assign(m, { tested_pct: t.summary.tested_pct, ...(opts.runTests ? { passing_pct: t.summary.passing_pct, failing_tests: t.summary.failing } : {}) });
    m._failing = t.requirements.filter((r) => r.status === "failing").map((r) => r.id);
    m._tests = t.summary;
    // Stored results (traceability.md next to the spec) only count for the code they were computed on.
    const trace = path.join(path.dirname(file), "traceability.md");
    if (fs.existsSync(trace)) {
      const rec = recordedBasis(fs.readFileSync(trace, "utf8"));
      m.results_current = rec ? rec.digest === t.basis.digest : null;
      m._basis = { now: t.basis.digest, recorded: rec?.digest ?? null, trace: path.relative(process.cwd(), trace) };
    }
  } catch (e) {
    m.tests_error = e.message;
  }

  if (opts.mutate !== false) {
    const mu = mutationScore(repo, text, { symbols, validate: opts.validate ?? 0 });
    Object.assign(m, {
      dependency_score_pct: mu.summary.score == null ? null : Math.round(mu.summary.score * 1000) / 10,
      uncited_constants: mu.missed.reduce((n, x) => n + x.constants.length, 0),
      ...(mu.summary.validation ? { guard_agreement_pct: Math.round(mu.summary.validation.agreement * 1000) / 10 } : {}),
    });
    m._missed_constants = mu.missed;
  }
  m._misplaced = claims.lines
    .filter((l) => l.facts.some((f) => f.status === "elsewhere_in_file"))
    .map((l) => ({ fr: l.fr, cites: l.ranges.map((r) => `${r.file}:${r.start}${r.end !== r.start ? `-${r.end}` : ""}`), facts: l.facts.filter((f) => f.status === "elsewhere_in_file") }));
  m._citations = parsed.citations;
  m._aliases = parsed.aliases;
  m._bases = parsed.bases;
  return m;
}

/** Share of the API's routes that at least one spec cites (a route counts if a citation falls in its handler). */
export function specCoverage(repo, specs) {
  let inv;
  try {
    inv = routeInventory(openGraph(repo));
  } catch (e) {
    return { error: e.message };
  }
  const cited = [];
  for (const s of specs) {
    const resolve = makeResolver(repo, { aliases: s._aliases, bases: s._bases });
    for (const c of s._citations) {
      const f = !c.bad && resolve(c.file).file;
      if (f) cited.push({ file: f, start: c.start, end: c.end });
    }
  }
  const covered = inv.routes.filter((r) => cited.some((c) => c.file === r.file && c.start <= r.end && c.end >= r.start));
  return { routes: inv.routes.length, routes_specified: covered.length, coverage_pct: pct(covered.length, inv.routes.length) };
}

/** Specs to measure: the given paths, or every tracked `*spec.md` in the repo. */
// A spec holds at least one rule id: **FR-001**, a "- FR-001:" item, a "### FR-1:" heading or
// a table row. A *spec.md without one (a command's instructions, a doc) isn't a spec.
const RULE_ID = /\*\*(?:FR|SC|NFR|AC|INV)-?\d+[a-z]?\*\*|^\s*(?:-|\d+\.|#{1,6}|\|)\s*(?:FR|SC|NFR|AC|INV)-?\d+[a-z]?\s*[:.|\-–—]/m;
export const isSpecFile = (file) => {
  try {
    return RULE_ID.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
};

export function defaultSpecs(repo) {
  try {
    return execFileSync("git", ["ls-files", "--", "*spec.md"], { cwd: repo, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((f) => path.join(repo, f))
      .filter(isSpecFile);
  } catch {
    return [];
  }
}

/** The scorecard: per-spec numbers, repo coverage, and a list of what to look at first. */
export function metrics(repo, files, opts = {}) {
  const symbols = openSymbols(repo);
  const specs = files.map((f) => specMetrics(repo, f, { ...opts, symbols }));
  const coverage = specCoverage(repo, specs);
  const attention = [];
  for (const s of specs) {
    if (s.citations_resolving_pct != null && s.citations_resolving_pct < 100) attention.push(`${s.spec}: ${s.citations - Math.round((s.citations_resolving_pct / 100) * s.citations)} citation(s) don't resolve (run cite)`);
    for (const x of s._misplaced)
      for (const f of x.facts)
        attention.push(`${s.spec}: ${x.fr} states \`${f.fact}\`, which is not in its cited lines (${x.cites.join(", ")}) but appears at ${f.at}: extend the citation to that line, or reword the requirement`);
    if (s.results_current === false) attention.push(`${s.spec}: traceability.md results were computed on different code (basis ${s._basis.recorded}, now ${s._basis.now}); re-run render --run-tests`);
    if (s._failing?.length) attention.push(`${s.spec}: requirement test(s) failing: ${s._failing.join(", ")}`);
    if (s.stale_requirements) attention.push(`${s.spec}: ${s.stale_requirements} requirement(s) cite code that changed (run stale)`);
    if (s.citations_to_update) attention.push(`${s.spec}: ${s.citations_to_update} citation(s) moved; run stale --fix`);
    for (const x of s._missed_constants ?? []) attention.push(`${s.spec}: ${x.fr} depends on uncited ${x.constants.map((c) => `${c.constant} (${c.at})`).join(", ")}`);
  }
  const clean = (s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_")));
  return { repo, specs: specs.map(clean), coverage, attention, ...(opts.raw ? { _raw: specs } : {}) };
}

/** A compact Markdown table for people (and for Claude to paste back). */
export function toMarkdown(r) {
  const cols = [
    ["requirements", "Reqs"],
    ["citations_resolving_pct", "Cites OK %"],
    ["claim_support_pct", "Claims supported %"],
    ["anchored_pct", "Anchored %"],
    ["stale_requirements", "Stale reqs"],
    ["citations_to_update", "Cites to update"],
    ["dependency_score_pct", "Deps cited %"],
    ["tested_pct", "Tested %"],
    ...(r.specs.some((s) => s.passing_pct != null) ? [["passing_pct", "Passing %"]] : []),
    ...(r.specs.some((s) => s.results_current != null) ? [["results_current", "Results current"]] : []),
  ];
  const fmt = (v) => (v == null ? "—" : String(v));
  const lines = [`| Spec | ${cols.map((c) => c[1]).join(" | ")} |`, `|---|${cols.map(() => "---:").join("|")}|`];
  for (const s of r.specs) lines.push(`| ${s.spec} | ${cols.map(([k]) => fmt(s[k])).join(" | ")} |`);
  const cov = r.coverage.error ? `Spec coverage: unavailable (${r.coverage.error})` : `Spec coverage: ${r.coverage.routes_specified} of ${r.coverage.routes} routes (${r.coverage.coverage_pct}%)`;
  const att = r.attention.length ? `\n\nNeeds attention:\n${r.attention.map((a) => `- ${a}`).join("\n")}` : "\n\nNothing needs attention.";
  return `${lines.join("\n")}\n\n${cov}${att}\n`;
}
