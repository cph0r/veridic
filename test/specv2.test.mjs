import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, renderMarkdown } from "../core/specdata.mjs";

const SPEC = {
  feature: "F",
  seeds: ["POST /x"],
  stories: [{ id: "US1", title: "t", scenarios: [{ given: "g", when: "w", then: "t", proves: ["FR-001"] }] }],
  requirements: [
    { id: "FR-001", rule: "MUST x", evidence: ["a.ts:1-2"] },
    { id: "FR-002", status: "planned", rule: "MUST y" },
  ],
  invariants: [{ id: "INV-1", rule: "never z", holds: "no", broken_by: ["R1"], evidence: ["a.ts:3"] }],
  risks: [{ id: "R1", severity: "high", title: "t", evidence: ["a.ts:3"] }],
};

test("validate accepts a good spec and a planned requirement without evidence", () => {
  assert.deepEqual(validate(SPEC), []);
});

test("validate names each problem", () => {
  const bad = { ...SPEC, requirements: [{ id: "FR-1", rule: "r", evidence: ["nope"] }, { id: "FR-002", rule: "r" }], risks: [{ id: "R1", severity: "urgent", title: "t", evidence: ["a.ts:1"] }] };
  const at = validate(bad).map((p) => `${p.at}: ${p.problem}`);
  assert.ok(at.some((x) => /FR-1: id must match/.test(x)));
  assert.ok(at.some((x) => /evidence "nope"/.test(x)));
  assert.ok(at.some((x) => /FR-002: needs at least one evidence/.test(x)));
  assert.ok(at.some((x) => /severity must be/.test(x)));
  assert.ok(at.some((x) => /proves unknown FR-001/.test(x)));
});

test("render produces Spec Kit sections the existing checks can read", () => {
  const md = renderMarkdown(SPEC, { contract: "## Contract (generated)\n", states: "## State machine (generated from code)\n" });
  assert.match(md, /- \*\*FR-001\*\*: MUST x \[evidence: a\.ts:1-2\]/);
  assert.match(md, /- \*\*FR-002\*\* \(planned\): MUST y/);
  assert.match(md, /\*\*INV-1\*\* \(holds: no; broken by R1\)/);
  assert.match(md, /\| R1 \| \*\*high\*\* \|/);
  assert.match(md, /## State machine/);
});

test("renderScaffolding writes the domain requirements layout with evidence and test mappings", async () => {
  const { renderScaffolding, scaffoldingId } = await import("../core/specdata.mjs");
  assert.equal(scaffoldingId("ORD", "FR-012"), "R-ORD-0012");
  const spec = { ...SPEC, domain: "ORD", requirements: [{ id: "FR-001", title: "Limit", category: "Cart", rule: "MUST x", evidence: ["a.ts:1-2"], verification: [{ id: "VC1", text: "one" }, { id: "VC2", text: "two" }] }] };
  const cov = { requirements: [{ id: "FR-001", tests: [], verification: [{ id: "VC1", covered: true, tests: [{ at: "t.ts:3", title: "FR-001 VC1: one" }] }, { id: "VC2", covered: false, tests: [] }] }] };
  const md = renderScaffolding(spec, cov);
  assert.match(md, /\| \*\*Cart\*\* \| R-ORD-0001 \| Limit \|/);
  assert.match(md, /### R-ORD-0001: Limit/);
  assert.match(md, /\*\*Evidence:\*\* `a\.ts:1-2`/);
  assert.match(md, /- VC1 → `t\.ts:3`: FR-001 VC1: one/);
  assert.match(md, /- VC2 → \(no test yet\)/);
});
