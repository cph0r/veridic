// Spec v2: the spec is data (spec.json); Markdown is a rendered view. The agent
// writes only what needs reasoning (rules, invariants, scenarios, risks). Every
// mechanical section (contract, state machine, traceability) is generated, and
// the data is validated before anything is rendered, so tools never have to
// guess at a format.

import { openGraph } from "./graph.mjs";
import { routeInventory, normRoute } from "./routes.mjs";
import { scope } from "./scope.mjs";
import { findOpenapi, loadContract, drift } from "./contract.mjs";
import { stateMachine, stateMachineMarkdown } from "./states.mjs";

const EVIDENCE = /^[^\s:]+:\d+(?:-\d+)?(?:#[^@]+@\d+)?$/;
const ID = { requirement: /^FR-\d{3}$/, invariant: /^INV-\d+$/, risk: /^R-?\d+$/, story: /^US\d+$/ };
const SEVERITY = new Set(["high", "medium", "low"]);
const HOLDS = new Set(["yes", "no", "unclear"]);

/** Problems with a spec.json, each { at, problem }. An empty list means it renders. */
export function validate(spec) {
  const problems = [];
  const bad = (at, problem) => problems.push({ at, problem });
  if (!spec || typeof spec !== "object") return [{ at: "spec", problem: "not a JSON object" }];
  if (!spec.feature) bad("feature", "missing");
  if (!Array.isArray(spec.seeds) || !spec.seeds.length) bad("seeds", "list the feature's entry routes (as in the context's scope)");
  const ids = new Set();
  const checkEvidence = (at, ev, required) => {
    if (!Array.isArray(ev) || !ev.length) return required && bad(at, "needs at least one evidence entry");
    for (const e of ev) if (typeof e !== "string" || !EVIDENCE.test(e)) bad(at, `evidence "${e}" is not path:line or path:start-end`);
  };
  const list = (name, idRe, fn) => {
    if (spec[name] == null) return;
    if (!Array.isArray(spec[name])) return bad(name, "must be a list");
    spec[name].forEach((x, i) => {
      const at = `${name}[${i}]${x?.id ? ` ${x.id}` : ""}`;
      if (idRe) {
        if (!x?.id || !idRe.test(x.id)) bad(at, `id must match ${idRe}`);
        else if (ids.has(x.id)) bad(at, "duplicate id");
        else ids.add(x.id);
      }
      fn(x ?? {}, at);
    });
  };
  // A requirement is `implemented` (default: must cite the code) or `planned`
  // (spec-first: no code yet, so evidence may be missing until it's built).
  if (spec.domain != null && !/^[A-Z]{2,6}$/.test(spec.domain)) bad("domain", "2-6 capital letters, e.g. ORD");
  list("requirements", ID.requirement, (r, at) => {
    if (!r.rule) bad(at, "missing rule");
    if (r.status && !["implemented", "planned"].includes(r.status)) bad(at, "status must be implemented or planned");
    checkEvidence(at, r.evidence, r.status !== "planned");
    // Verification criteria: each one a single checkable condition, tested on its own.
    const vcs = new Set();
    (r.verification ?? []).forEach((v, j) => {
      if (!/^VC\d+$/.test(v?.id ?? "")) bad(`${at}.verification[${j}]`, "id must be VC1, VC2, …");
      else if (vcs.has(v.id)) bad(`${at}.verification[${j}]`, `duplicate ${v.id}`);
      else vcs.add(v.id);
      if (!v?.text) bad(`${at}.verification[${j}]`, "missing text");
      if (v?.evidence) checkEvidence(`${at}.verification[${j}]`, v.evidence, false);
    });
  });
  if (!spec.requirements?.length) bad("requirements", "at least one requirement");
  list("invariants", ID.invariant, (r, at) => {
    if (!r.rule) bad(at, "missing rule");
    if (r.holds && !HOLDS.has(r.holds)) bad(at, "holds must be yes, no or unclear");
    checkEvidence(at, r.evidence, true);
  });
  list("risks", ID.risk, (r, at) => {
    if (!SEVERITY.has(r.severity)) bad(at, "severity must be high, medium or low");
    if (!r.title) bad(at, "missing title");
    checkEvidence(at, r.evidence, true);
  });
  list("stories", ID.story, (s, at) => {
    if (!s.title) bad(at, "missing title");
    (s.scenarios ?? []).forEach((sc, j) => {
      for (const k of ["given", "when", "then"]) if (!sc[k]) bad(`${at}.scenarios[${j}]`, `missing ${k}`);
    });
  });
  // References must point at things that exist.
  for (const s of spec.stories ?? []) for (const sc of s.scenarios ?? []) for (const p of sc.proves ?? []) if (!ids.has(p)) bad(`${s.id} scenario`, `proves unknown ${p}`);
  for (const inv of spec.invariants ?? []) for (const b of inv.broken_by ?? []) if (!ids.has(b)) bad(inv.id, `broken_by unknown ${b}`);
  list("edge_cases", null, (e, at) => {
    if (!e.text) bad(at, "missing text");
    checkEvidence(at, e.evidence, false);
  });
  return problems;
}

const ev = (list) => (list?.length ? ` [evidence: ${list.join(", ")}]` : "");
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Contract and state-machine sections, generated from the code for the spec's seeds. */
export function generatedSections(repo, seeds) {
  const g = openGraph(repo);
  const inv = routeInventory(g);
  const openapiFile = findOpenapi(repo);
  const contract = openapiFile ? loadContract(repo, openapiFile) : null;
  const sc = scope(g, inv, seeds, { openapi: contract?.ops ?? [] });
  if (sc.error) return { contract: "", states: "", error: sc.error };
  let contractMd = "";
  if (contract) {
    const ids = new Set([...sc.routes, ...sc.webhooks].map((r) => normRoute(r.id)));
    const d = drift(g, contract, inv.routes.filter((r) => ids.has(normRoute(r.id))), { scoped: true, scopeIds: ids });
    const lines = [`## Contract (generated: \`${contract.file}\` vs code)`, "", `${d.summary.documented_ops} documented operation(s) in scope, ${d.summary.implemented_routes} implemented route(s), ${d.summary.operations_clean} matching cleanly.`, ""];
    if (d.documented_not_implemented.length) lines.push(`Documented but not implemented: ${d.documented_not_implemented.map((o) => `\`${o.id}\``).join(", ")}.`, "");
    if (d.implemented_not_documented.length) lines.push(`Implemented but not documented: ${d.implemented_not_documented.map((o) => `\`${o.id}\``).join(", ")}.`, "");
    for (const o of d.operations) {
      const notes = [
        ...(o.undocumented_statuses ?? []).map((u) => `returns ${u.status} (undocumented) [evidence: ${u.at}]`),
        ...(o.unreturned_statuses ?? []).map((u) => `documents ${u.status}, never returned${u.maybe_from ? ` (maybe ${u.maybe_from.join(", ")})` : ""}`),
        ...(o.undeclared_body_fields ?? []).map((f) => `reads \`req.body.${f.field}\`, not in the schema [evidence: ${f.at}]`),
      ];
      lines.push(`- \`${o.id}\`: ${notes.join("; ")}`);
    }
    contractMd = lines.join("\n") + "\n";
  }
  return { contract: contractMd, states: stateMachineMarkdown(stateMachine(g, sc)) };
}

/** spec.json -> spec.md, in Spec Kit's section order. */
export function renderMarkdown(spec, generated = {}) {
  const out = [`# Feature Specification: ${spec.feature}`, "", `**Status**: ${spec.status ?? "Recovered from code"} · **Seeds**: ${spec.seeds.map((s) => `\`${s}\``).join(", ")}`, "", "_Rendered by `plumb render` from spec.json; edit the JSON, not this file._", ""];

  out.push("## User Scenarios & Testing", "");
  for (const s of spec.stories ?? []) {
    out.push(`### User Story ${s.id.replace(/^US/, "")} - ${s.title} (Priority: ${s.priority ?? "P2"})`, "");
    if (s.narrative) out.push(s.narrative, "");
    if (s.why) out.push(`**Why this priority**: ${s.why}`, "");
    if (s.scenarios?.length) {
      out.push("**Acceptance Scenarios**:", "");
      s.scenarios.forEach((sc, i) => out.push(`${i + 1}. **Given** ${sc.given}, **When** ${sc.when}, **Then** ${sc.then}${sc.proves?.length ? ` (${sc.proves.join(", ")})` : ""}`));
      out.push("");
    }
  }
  if (spec.edge_cases?.length) out.push("### Edge Cases", "", ...spec.edge_cases.map((e) => `- ${e.text}${ev(e.evidence)}`), "");

  out.push("## Requirements", "", "### Functional Requirements", "");
  for (const r of spec.requirements) {
    out.push(`- **${r.id}**${r.status === "planned" ? " (planned)" : ""}: ${r.rule}${ev(r.evidence)}${r.clarify ? ` [NEEDS CLARIFICATION: ${r.clarify}]` : ""}`);
    for (const v of r.verification ?? []) out.push(`  - ${v.id}. ${v.text}${ev(v.evidence)}`);
  }
  out.push("");
  if (spec.invariants?.length) {
    out.push("### Invariants", "", "_Rules that must hold across every route, timer and webhook._", "");
    for (const v of spec.invariants) out.push(`- **${v.id}** (holds: ${v.holds ?? "unclear"}${v.broken_by?.length ? `; broken by ${v.broken_by.join(", ")}` : ""}): ${v.rule}${ev(v.evidence)}`);
    out.push("");
  }
  for (const t of spec.decision_tables ?? []) {
    out.push(`### Decision table: ${t.title ?? t.for}${t.for ? ` (${t.for})` : ""}`, "", `| ${t.columns.map(cell).join(" | ")} |`, `|${t.columns.map(() => "---").join("|")}|`, ...t.rows.map((r) => `| ${r.map(cell).join(" | ")} |`), "");
    if (t.evidence?.length) out.push(`Evidence:${ev(t.evidence).replace(/^ /, " ")}`, "");
  }
  if (spec.entities?.length) out.push("### Key Entities", "", ...spec.entities.map((e) => `- **${e.name}**: ${e.description ?? e.fields ?? ""}${ev(e.evidence)}`), "");

  if (generated.contract) out.push(generated.contract);
  if (generated.states) out.push(generated.states);

  if (spec.success_criteria?.length) out.push("## Success Criteria", "", ...spec.success_criteria.map((c, i) => `- **SC-${String(i + 1).padStart(3, "0")}**: ${c.text ?? c}${ev(c.evidence)}`), "");
  if (spec.assumptions?.length) out.push("## Assumptions", "", ...spec.assumptions.map((a) => `- ${a}`), "");

  out.push("## Open Questions & Observed Risks", "");
  if (spec.risks?.length) {
    out.push("| # | Severity | Risk | Evidence |", "|---|---|---|---|");
    const order = { high: 0, medium: 1, low: 2 };
    for (const r of [...spec.risks].sort((a, b) => order[a.severity] - order[b.severity])) out.push(`| ${r.id} | **${r.severity}** | **${cell(r.title)}** ${cell(r.detail ?? "")} | ${r.evidence.map((e) => `\`${e}\``).join(", ")} |`);
    out.push("");
  }
  for (const q of spec.open_questions ?? []) out.push(`- [NEEDS CLARIFICATION: ${q}]`);
  out.push("");
  return out.join("\n");
}

/** FR-001 -> R-ORD-0001: the domain requirement id for a spec requirement. */
export const scaffoldingId = (domain, frId) => `R-${domain}-${String(Number(frId.replace(/\D/g, ""))).padStart(4, "0")}`;

/**
 * spec.json -> a requirements file in the domain requirements format (docs/requirements/<domain>/…):
 * overview, key behaviors, scope, summary table, then per requirement its
 * verification criteria and test mappings. Adds an Evidence line per requirement,
 * which that format doesn't have: the code each requirement is true of.
 * @param coverage  testCoverage() result for the rendered spec.md, for the test mappings
 */
export function renderScaffolding(spec, coverage = null) {
  const domain = spec.domain ?? "REQ";
  const today = new Date().toISOString().slice(0, 10);
  const added = `**Added:** ${spec.added ?? today} (CR: ${spec.change ?? "recovered-from-code"})`;
  const title = (r) => r.title ?? r.rule.replace(/^The system MUST\s*/i, "").replace(/[.;].*$/s, "").slice(0, 70);
  const byReq = new Map((coverage?.requirements ?? []).map((q) => [q.id, q]));
  const out = [`# ${domain} — ${spec.feature}`, "", `### ${spec.summary ?? spec.feature}`, "", "## Overview", "", spec.overview ?? spec.stories?.[0]?.narrative ?? spec.stories?.[0]?.why ?? "", ""];
  const behaviors = spec.key_behaviors ?? (spec.invariants ?? []).map((v) => v.rule);
  if (behaviors.length) out.push("### Key Behaviors", "", ...behaviors.slice(0, 6).map((b) => `- ${b}`), "");
  if (spec.scope) out.push("### Scope", "", `Covers: ${spec.scope.covers ?? ""}`, "", `Does not cover: ${spec.scope.excludes ?? ""}`, "");
  out.push("### Requirements Summary", "", "| Category | ID | Title |", "|----------|----|-------|");
  const groups = new Map();
  for (const r of spec.requirements) (groups.get(r.category ?? "General") ?? groups.set(r.category ?? "General", []).get(r.category ?? "General")).push(r);
  for (const [cat, rs] of groups) rs.forEach((r, i) => out.push(`| ${i === 0 ? `**${cat}**` : ""} | ${scaffoldingId(domain, r.id)} | ${title(r)} |`));
  out.push("", "---", "", "## Requirements", "");
  for (const [cat, rs] of groups) {
    out.push(`### ${cat}`, "");
    for (const r of rs) {
      const rid = scaffoldingId(domain, r.id);
      out.push(`### ${rid}: ${title(r)}`, "", r.status === "planned" ? `${added} — planned, not built yet` : added, "", r.rule, "");
      if (r.evidence?.length) out.push(`**Evidence:** ${r.evidence.map((e) => `\`${e}\``).join(", ")}`, "");
      const vcs = r.verification?.length ? r.verification : [{ id: "VC1", text: r.rule }];
      out.push("#### Verification Criteria", "", ...vcs.map((v) => `- ${v.id}. ${v.text}`), "");
      const cov = byReq.get(r.id);
      const maps = [];
      for (const v of vcs) {
        const tests = cov?.verification?.find((x) => x.id === v.id)?.tests ?? (r.verification?.length ? [] : (cov?.tests ?? []).filter((t) => !t.todo && t.strength !== "empty" && t.strength !== "unasserted").map((t) => t.at));
        if (!tests.length) maps.push(`- ${v.id} → (no test yet)`);
        else for (const t of tests) maps.push(`- ${v.id} → ${typeof t === "string" ? `\`${t}\`` : `\`${t.at}\`: ${t.title}`}`);
      }
      out.push("#### Test Mappings", "", ...maps, "", "---", "");
    }
  }
  return out.join("\n");
}
