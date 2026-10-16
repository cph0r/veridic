import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { testCoverage, findTaggedTests } from "../core/tests.mjs";
import { scaffold } from "../core/scaffold.mjs";

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo(extra = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-tests-"));
  dirs.push(d);
  const files = {
    "src/order.ts": "export function place(q) {\n  if (q > 20) throw new Error('too many');\n  return q;\n}\n",
    "src/other.ts": "export const x = 1;\n",
    // Reaches the cited code through a helper: two relative hops.
    "src/__tests__/helper.ts": 'export { place } from "../order";\n',
    "src/__tests__/order.test.ts": 'import { place } from "./helper";\nit("FR-001: rejects more than 20", () => { expect(place(21)).toBe(false); });\nit.todo("FR-002: logs the rejection");\n',
    // Names FR-003 but never touches the code FR-003 cites.
    "src/__tests__/other.test.ts": 'import { x } from "../other";\ntest("FR-003: something", () => { expect(x).toBe(1); });\n',
    ...extra,
  };
  for (const [f, s] of Object.entries(files)) {
    fs.mkdirSync(path.join(d, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), s);
  }
  execFileSync("git", ["init", "-q"], { cwd: d });
  return d;
}

const SPEC = `### User Story 1 - Order (Priority: P1)
1. **Given** a cart, **When** it has 21 items, **Then** it is rejected.

- **FR-001**: MUST reject more than 20 items. [evidence: src/order.ts:2]
- **FR-002**: MUST log rejections. [evidence: src/order.ts:2]
- **FR-003**: MUST place the order. [evidence: src/order.ts:3]
- **FR-004**: MUST do something untested. [evidence: src/order.ts:1-4]
`;

test("findTaggedTests reads requirement ids from test titles, including todo", () => {
  const d = repo();
  const t = findTaggedTests(d, ["src/__tests__/order.test.ts", "src/__tests__/other.test.ts", "src/order.ts"]);
  assert.deepEqual(t.map((x) => [x.id, x.todo]), [["FR-001", false], ["FR-002", true], ["FR-003", false]]);
});

test("testCoverage: covered only when the named test reaches the cited code", () => {
  const d = repo();
  const r = testCoverage(d, SPEC);
  const status = Object.fromEntries(r.requirements.map((q) => [q.id, q.status]));
  assert.deepEqual(status, { "FR-001": "covered", "FR-002": "todo", "FR-003": "tagged_only", "FR-004": "none" });
  assert.equal(r.summary.tested_pct, 25);
});

test("a plumb-spec binding keeps a test file to its own spec", () => {
  const d = repo({ "src/__tests__/bound.test.ts": '// plumb-spec: specs/other/spec.md\nimport { place } from "../order";\nit("FR-004: bound elsewhere", () => { expect(place(1)).toBe(true); });\n' });
  const r = testCoverage(d, SPEC, { specPath: path.join(d, "specs/orders/spec.md") });
  assert.equal(r.requirements.find((q) => q.id === "FR-004").status, "none");
});

test("scaffold writes one placeholder per requirement, named with its id, plus the scenarios", () => {
  const d = repo();
  const r = scaffold(d, SPEC, { out: "src/__tests__/spec.test.ts" });
  assert.equal(r.framework.name, "node:test");
  assert.equal(r.requirements, 4);
  for (const id of ["FR-001", "FR-002", "FR-003", "FR-004"]) assert.match(r.text, new RegExp(`test\\.todo\\("${id}: `));
  assert.match(r.text, /cites: src\/order\.ts:2/);
  assert.match(r.text, /Given a cart, When it has 21 items/);
});

test("traceabilityTable marks a test that reaches the cited code without naming the requirement as related", async () => {
  const { traceabilityTable } = await import("../core/tests.mjs");
  const d = repo();
  const table = traceabilityTable(testCoverage(d, SPEC));
  assert.match(table, /\| FR-001 \| MUST reject more than 20 items\. \| `src\/order\.ts:2` \| `src\/__tests__\/order\.test\.ts:2` \| covered \|/);
  assert.match(table, /\| FR-004 \|[^\n]*\(related\) \| related \|/); // order.test.ts reaches order.ts but names FR-001, not FR-004
  assert.match(table, /\| FR-002 \|[^\n]*\| untested \(placeholder\) \|/); // only a todo, and the helper isn't a test
  assert.match(table, /\*\*Totals:\*\* 4 requirements: 1 covered, 2 related, 1 untested\./);
});

test("read bundle prints each range once, numbered, and pages by budget", async () => {
  const { bundle } = await import("../core/read.mjs");
  const d = repo();
  const list = [
    { at: "src/order.ts:1-4", why: "seed" },
    { at: "src/order.ts:2-3", why: "inside the seed" }, // already shown
    { at: "src/other.ts:1-1", why: "service" },
  ];
  const all = bundle(d, list);
  assert.equal(all.printed, 2);
  assert.match(all.text, /=== src\/order\.ts:1-4 {2}\(seed\)\n1 {2}export function place/);
  assert.equal(all.next, null);
  const page = bundle(d, list, { budget: 60 }); // the first range is always printed
  assert.equal(page.printed, 1);
  assert.equal(page.next, 2); // entry 1 is inside entry 0, so the next page starts at 2
});

test("scope and cite print compact output by default", () => {
  const d = repo();
  const out = execFileSync("node", [path.join(import.meta.dirname, "../skill/scripts/cite.mjs"), "--repo", d, "--spec", "/dev/stdin"], { input: SPEC, encoding: "utf8" });
  const r = JSON.parse(out);
  assert.equal(r.citations.length, 0); // all resolve: nothing listed
  assert.equal(r.summary.citations, 4);
  assert.ok(!out.includes("\n  "), "compact JSON when not a terminal");
});

test("tests link per verification criterion, in both FR-001 VC2 and T-ORD-0001.2.1-API naming", () => {
  const d = repo({
    "src/__tests__/vc.test.ts": 'import { place } from "../order";\nit("FR-001 VC1: rejects 21", () => { expect(place(21)).toBe(false); });\nit("T-ORD-0001.2.1-API: accepts 20", () => { expect(place(21)).toBe(false); });\n',
  });
  const spec = "- **FR-001**: MUST limit items. [evidence: src/order.ts:2]\n  - VC1. 21 is rejected.\n  - VC2. 20 is accepted.\n  - VC3. 0 is rejected.\n";
  const r = testCoverage(d, spec).requirements.find((q) => q.id === "FR-001");
  assert.deepEqual(r.verification.map((v) => [v.id, v.covered]), [["VC1", true], ["VC2", true], ["VC3", false]]);
  assert.equal(r.vc_covered, 2);
});

test("access matrix: plan gates, caller scoping, and mismatches with an intended matrix", async () => {
  const { accessMatrix, loadIntended, compareAccess } = await import("../core/access.mjs");
  const src = [
    'router.get("/vendors", requireAuth, async (req, res) => { res.json(await storage.vendors(req.userId)); });',
    'router.get("/reports/pl", requireAuth, requirePro, async (req, res) => { res.json(await storage.pl(req.userId)); });',
    'router.post("/orders/:id/mark-paid", async (req, res) => { await db.update(o).set({ paid: true }).where(eq(o.id, req.params.id)); });',
  ];
  const g = { lines: () => src };
  const inv = { routes: [
    { id: "GET /api/vendors", method: "GET", path: "/api/vendors", file: "r.ts", start: 1, end: 1, guards: [{ name: "requireAuth" }] },
    { id: "GET /api/reports/pl", method: "GET", path: "/api/reports/pl", file: "r.ts", start: 2, end: 2, guards: [{ name: "requireAuth" }, { name: "requirePro" }] },
    { id: "POST /api/orders/:id/mark-paid", method: "POST", path: "/api/orders/:id/mark-paid", file: "r.ts", start: 3, end: 3, guards: [] },
  ] };
  const m = accessMatrix(g, inv);
  assert.deepEqual(m.map((r) => [r.access, r.plan, r.scoped]), [["auth", "free", "yes"], ["auth", "pro", "yes"], ["public", "free", "no"]]);
  assert.deepEqual(m[2].flags, ["id-param-without-caller-scope"]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-access-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "a.csv"), "route,access,plan,scoped\n# pro features\n* /api/vendors*,auth,pro,yes\nGET /api/reports/*,auth,pro,yes\n");
  const c = compareAccess(m, loadIntended(path.join(dir, "a.csv")));
  assert.equal(c.checked, 2);
  assert.deepEqual(c.mismatches.map((x) => [x.route, x.problems[0]]), [["GET /api/vendors", "needs a paid-plan check on the server; none found"]]);
});

import { testStrength, codeOnly } from "../core/tests.mjs";

test("test strength: empty, unasserted, literal-only, weak, strong", () => {
  const s = (src) => testStrength(codeOnly(src));
  assert.equal(s(", () => {}"), "empty");
  assert.equal(s(", async () => { /* expect(x).toBe(1) */ }"), "empty");
  assert.equal(s(", async () => { await place(order); }"), "unasserted");
  assert.equal(s(', () => { const msg = "expect(x)"; run(msg); }'), "unasserted");
  assert.equal(s(", () => { expect(true).toBe(true); }"), "unasserted");
  assert.equal(s(", () => { expect(order).toBeDefined(); expect(fn).toHaveBeenCalled(); }"), "weak");
  assert.equal(s(", () => { expect(order).toBeDefined(); expect(order.total).toBe(20); }"), "strong");
  assert.equal(s(", () => expect(cancel(o)).toHaveLength(0)"), "strong");
  assert.equal(s(", () => { assert.equal(x, 1); }"), "strong");
});

test("coverage counts only tests that assert; skipped describe blocks don't count", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "sg-strength-"));
  const w = (f, t) => (fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t));
  w("src/a.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n");
  w(
    "src/__tests__/a.test.ts",
    [
      'import { a } from "../a";',
      'it("FR-001: real", () => { expect(a).toBe(1); });',
      'it("FR-002: empty", () => {});',
      'it("FR-003: weak", () => { expect(a).toBeTruthy(); });',
      'describe.skip("later", () => {',
      '  it("FR-004: skipped", () => { expect(a).toBe(1); });',
      "});",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const spec = [1, 2, 3, 4].map((n) => `- **FR-00${n}**: x [evidence: src/a.ts:${n}]`).join("\n");
  const cov = testCoverage(repo, spec);
  const st = Object.fromEntries(cov.requirements.map((r) => [r.id, r.status]));
  assert.deepEqual(st, { "FR-001": "covered", "FR-002": "unasserted", "FR-003": "covered", "FR-004": "todo" });
  assert.equal(cov.summary.with_tests, 2);
  assert.deepEqual(cov.summary.tests_asserting_nothing, ["src/__tests__/a.test.ts:3"]);
  assert.deepEqual(cov.summary.weak_tests, ["src/__tests__/a.test.ts:4"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the old specguard-spec binding comment still binds a test file", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "plumb-legacy-"));
  const w = (f, t) => (fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t));
  w("src/a.ts", "export const a = 1;\n");
  w("src/__tests__/a.test.ts", '// specguard-spec: specs/other/spec.md\nimport { a } from "../a";\nit("FR-001: x", () => { expect(a).toBe(1); });\n');
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const cov = testCoverage(repo, "- **FR-001**: x [evidence: src/a.ts:1]", { specPath: path.join(repo, "specs/mine/spec.md") });
  assert.equal(cov.requirements[0].status, "none", "bound to another spec, so it doesn't cover this one");
  fs.rmSync(repo, { recursive: true, force: true });
});
