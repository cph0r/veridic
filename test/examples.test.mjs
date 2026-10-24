// Worked examples under rules: inputs and expected outcomes, mined from the tests linked to
// a rule when they're literal, written by the spec agent otherwise (and marked unproven).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mineExamples } from "../core/tests.mjs";
import { validate, renderMarkdown } from "../core/specdata.mjs";
import { specDoc } from "../core/report.mjs";

test("examples: a supertest request with literal values and its assertions become a row", () => {
  const body = 'const res = await request(app).post("/orders").send({ items: 3, total: 120 }).expect(201);\nexpect(res.body.discount).toBe(12);\nexpect(res.body.order.status).toEqual("paid");';
  assert.deepEqual(mineExamples(body), [{ given: { method: "POST", path: "/orders", body: "{ items: 3, total: 120 }" }, then: { status: 201, fields: { discount: "12", "order.status": '"paid"' } } }]);
});

test("examples: a fetch with a literal URL and a status check is a row", () => {
  const body = 'const res = await fetch(base + "/api/apps/42", { method: "DELETE", headers });\nexpect(res.status).toBe(403);';
  assert.deepEqual(mineExamples(body), [{ given: { method: "DELETE", path: "/api/apps/42" }, then: { status: 403 } }]);
});

test("examples: a request built from variables gives no row", () => {
  assert.deepEqual(mineExamples("const res = await request(app).post(`/orders/${id}`).send(payload).expect(201);"), []);
  assert.deepEqual(mineExamples("const res = await request(app).get(url).expect(200);"), []);
  assert.deepEqual(mineExamples('const res = await request(app).get("/orders");'), [], "no status asserted: nothing to write down");
});

test("examples: spec.json carries them, render writes a table under the rule, the report reads it back", () => {
  const spec = {
    feature: "Orders", seeds: ["POST /orders"],
    requirements: [{
      id: "FR-001", rule: "Orders over $100 MUST get 10% off", evidence: ["a.ts:1"],
      examples: [
        { given: { method: "POST", path: "/orders", body: "{ total: 120 }" }, then: { status: 201, fields: { discount: "12" } }, proven_by: "test/orders.test.ts:4" },
        { given: { method: "POST", path: "/orders", body: "{ total: 80 }", as: "anon" }, then: { status: 401 } },
      ],
    }],
  };
  assert.deepEqual(validate(spec), []);
  assert.ok(validate({ ...spec, requirements: [{ ...spec.requirements[0], examples: [{ given: { method: "POST" }, then: {} }] }] }).some((p) => /example/.test(p.at)));
  const md = renderMarkdown(spec);
  assert.match(md, /- \*\*FR-001\*\*: Orders over \$100 MUST get 10% off.*\n  - Examples:\n\n    \| Given \| Then \| Proven by \|\n    \|---\|---\|---\|\n    \| POST \/orders \{ total: 120 \} \| 201, discount: 12 \| `test\/orders\.test\.ts:4` \|\n    \| POST \/orders \{ total: 80 \} as anon \| 401 \| not yet \|/);
  const doc = specDoc(md);
  assert.deepEqual(doc.reqs["FR-001"].examples, [
    { given: "POST /orders { total: 120 }", then: "201, discount: 12", proven_by: "test/orders.test.ts:4" },
    { given: "POST /orders { total: 80 } as anon", then: "401", proven_by: null },
  ]);
});

test("examples: coverage lists the rows its linked tests give", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-ex-"));
  const w = (f, t) => (fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t));
  w("src/app.ts", "export const app = 1;\n");
  w("test/orders.test.ts", 'import { app } from "../src/app";\nit("FR-001: a discount over $100", async () => {\n  const res = await request(app).post("/orders").send({ total: 120 }).expect(201);\n  expect(res.body.discount).toBe(12);\n});\n');
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  const cov = testCoverage(repo, "- **FR-001**: discount [evidence: src/app.ts:1]\n");
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(cov.requirements[0].examples, [{ given: { method: "POST", path: "/orders", body: "{ total: 120 }" }, then: { status: 201, fields: { discount: "12" } }, proven_by: "test/orders.test.ts:2" }]);
});

test("examples: nothing invented from requests built from variables (review: bodies, concatenated paths, someone else's status)", () => {
  assert.deepEqual(mineExamples("const res = await request(app).post(\"/orders\").send({ items, total: price * 2 }).expect(201);"), [], "a body that isn't literal");
  assert.deepEqual(mineExamples('const res = await fetch("/orders/" + id);\nexpect(res.status).toBe(200);'), [], "a path with a variable added");
  assert.deepEqual(mineExamples('await request(app).get("/a");\nconst b = await request(app).get(path);\nexpect(b.status).toBe(404);'), [], "the 404 is the unnamed request's, not /a's");
});

test("examples: fetch options with nested objects keep their body", () => {
  assert.deepEqual(mineExamples('const res = await fetch("/api/orders", { method: "POST", headers: { a: "1" }, body: JSON.stringify({ total: 120 }) });\nexpect(res.status).toBe(201);'), [{ given: { method: "POST", path: "/api/orders", body: "{ total: 120 }" }, then: { status: 201 } }]);
});
