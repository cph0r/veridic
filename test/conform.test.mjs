// The conformance suite: black-box HTTP checks generated from the specs, runnable against
// any implementation (the original first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { conformChecksFrom } from "../core/conform/generate.mjs";

const ROUTES = [
  { id: "GET /api/articles", method: "GET", path: "/api/articles", access: "public", scoped: "no" },
  { id: "POST /api/articles", method: "POST", path: "/api/articles", access: "auth", scoped: "no" },
  { id: "DELETE /api/articles/:slug", method: "DELETE", path: "/api/articles/:slug", access: "auth", scoped: "yes" },
  { id: "POST /api/webhooks/stripe", method: "POST", path: "/api/webhooks/stripe", access: "public", scoped: "no" },
];
const SPEC = [
  "## Requirements",
  "",
  "- **FR-004**: Creating an article MUST require sign-in [evidence: src/a.ts:1]",
  "  - Examples:",
  "",
  "    | Given | Then | Proven by |",
  "    |---|---|---|",
  "    | POST /api/articles { title: \"Hi\", body: \"x\" } as owner | 201, article.title: \"Hi\" | `t.test.ts:4` |",
  "    | POST /api/articles { title: \"\" } as owner | 422 | not yet |",
  "",
].join("\n");

test("conform: signed-out checks for routes that need sign-in", () => {
  const checks = conformChecksFrom({ routes: ROUTES, specs: [] });
  const access = checks.filter((c) => c.kind === "access");
  assert.deepEqual(access.map((c) => [c.request.method, c.request.path, c.request.as, c.expect.status]), [
    ["POST", "/api/articles", "anon", 401],
    ["DELETE", "/api/articles/:slug", "anon", 401],
  ]);
  assert.deepEqual(access[1].needs, ["seed:slug"]);
});

test("conform: another user's record is denied, 403 or 404 both counting (Review Focus 5)", () => {
  const scope = conformChecksFrom({ routes: ROUTES, specs: [] }).filter((c) => c.kind === "scope");
  assert.deepEqual(scope.map((c) => [c.request.method, c.request.path, c.request.as, c.expect.status]), [["DELETE", "/api/articles/:slug", "other", "denied"]]);
  assert.deepEqual(scope[0].needs, ["seed:slug"]);
});

test("conform: each example row is a check, tied to its rule", () => {
  const ex = conformChecksFrom({ routes: ROUTES, specs: [{ folder: "articles", text: SPEC }] }).filter((c) => c.kind === "example");
  assert.deepEqual(ex.map((c) => c.rule), ["articles:FR-004", "articles:FR-004"]);
  assert.deepEqual(ex[0].request, { method: "POST", path: "/api/articles", as: "owner", body: '{ title: "Hi", body: "x" }' });
  assert.deepEqual(ex[0].expect, { status: 201, fields: { "article.title": '"Hi"' } });
  assert.deepEqual(ex[1].expect, { status: 422 });
});

test("conform: a product journey runs its steps' examples in order", () => {
  const product = { journeys: [{ id: "J-001", title: "Write an article", steps: [{ text: "Post it", refs: ["articles:FR-004"] }] }] };
  const j = conformChecksFrom({ routes: ROUTES, specs: [{ folder: "articles", text: SPEC }], product }).filter((c) => c.kind === "journey");
  assert.equal(j.length, 1);
  assert.equal(j[0].id, "journey:J-001");
  assert.deepEqual(j[0].steps.map((s) => s.request.path), ["/api/articles", "/api/articles"]);
});

test("conform: every check has a unique id", () => {
  const all = conformChecksFrom({ routes: ROUTES, specs: [{ folder: "articles", text: SPEC }] });
  assert.equal(new Set(all.map((c) => c.id)).size, all.length);
});
