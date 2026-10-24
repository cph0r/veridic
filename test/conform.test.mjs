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
  { id: "GET /api/tags", method: "GET", path: "/api/tags", access: "auth", scoped: "yes", guards: ["auth.optional"] },
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
  "- **FR-005**: Only the author MAY delete an article [evidence: src/a.ts:2]",
  "  - Examples:",
  "",
  "    | Given | Then | Proven by |",
  "    |---|---|---|",
  "    | DELETE /api/articles/:slug as other | denied | not yet |",
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

test("conform: a route whose only guard is optional is open signed out: no 401 check", () => {
  const access = conformChecksFrom({ routes: ROUTES, specs: [] }).filter((c) => c.kind === "access");
  assert.ok(!access.some((c) => c.request.path === "/api/tags"));
});

test("conform: another user's record is denied only where the spec says so (403 or 404 both counting)", () => {
  assert.deepEqual(conformChecksFrom({ routes: ROUTES, specs: [] }).filter((c) => c.kind === "scope"), [], "using the caller's id isn't refusing others");
  const scope = conformChecksFrom({ routes: ROUTES, specs: [{ folder: "articles", text: SPEC }] }).filter((c) => c.kind === "scope");
  assert.deepEqual(scope.map((c) => [c.request.method, c.request.path, c.request.as, c.expect.status, c.rule]), [["DELETE", "/api/articles/:slug", "other", "denied", "articles:FR-005"]]);
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

// A tiny API in the test process: articles owned by a user, a token header for each user.
const http = await import("node:http");
const startApi = (behave = {}) => new Promise((resolve) => {
  const articles = { mine: { owner: "u1", title: "Mine" } };
  const server = http.createServer((req, res) => {
    const user = { "Token t1": "u1", "Token t2": "u2" }[req.headers.authorization ?? ""] ?? null;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(obj ? JSON.stringify(obj) : ""); };
      if (req.method === "POST" && req.url === "/api/articles") {
        if (!user) return send(401, { error: "sign in" });
        const b = JSON.parse(body || "{}");
        if (!b.title) return send(422, { errors: { title: ["can't be blank"] } });
        return send(201, { article: { title: b.title } });
      }
      const m = req.url.match(/^\/api\/articles\/(\w+)$/);
      if (req.method === "DELETE" && m) {
        if (!user) return send(401);
        const a = articles[m[1]];
        if (!a) return send(404);
        if (a.owner !== user) return send(behave.leaky ? 204 : 403);
        return send(204);
      }
      send(404);
    });
  });
  server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
});
const USERS = { owner: { headers: { authorization: "Token t1" } }, other: { headers: { authorization: "Token t2" } } };

test("conform run: passing checks, a failing one says what it got, a check with no seed isn't run", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  const api = await startApi({ leaky: true });
  const checks = conformChecksFrom({ routes: ROUTES, specs: [{ folder: "articles", text: SPEC }] });
  const r = await runChecks(checks, { url: api.url, users: USERS, seeds: { slug: "mine" } });
  const r2 = await runChecks(checks, { url: api.url, users: USERS, seeds: {} });
  api.close();
  assert.deepEqual(r.failed.map((f) => [f.id, f.got]), [["scope:articles:FR-005:1", 204]], "the leaky API lets another user delete");
  assert.equal(r.passed, 4);
  assert.equal(r.fidelity_pct, 80);
  assert.deepEqual(r2.not_run.map((n) => [n.id, n.why]), [["access:DELETE /api/articles/:slug:anon", "no seed for slug"], ["scope:articles:FR-005:1", "no seed for slug"]]);
});

test("conform run: 403 and 404 both count as denied", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  const api = await startApi();
  const scope = conformChecksFrom({ routes: ROUTES, specs: [{ folder: "articles", text: SPEC }] }).filter((c) => c.kind === "scope");
  const r = await runChecks(scope, { url: api.url, users: USERS, seeds: { slug: "mine" } });
  api.close();
  assert.equal(r.passed, 1);
});

test("conform run: refuses an address that isn't local unless allowed", async () => {
  const { checkUrl } = await import("../core/conform/run.mjs");
  for (const u of ["http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:3000", "http://api.test", "http://app.localhost:5000"]) assert.equal(checkUrl(u), null, u);
  assert.match(checkUrl("https://example.com"), /isn't local/);
  assert.equal(checkUrl("https://example.com", { allowRemote: true }), null);
});

test("conform: an `as other` row refused with 403 or 404 is a scope check too", () => {
  const spec = "## Requirements\n\n- **FR-009**: Only the author MAY edit [evidence: src/a.ts:3]\n  - Examples:\n\n    | Given | Then | Proven by |\n    |---|---|---|\n    | PUT /api/articles/:slug { body: \"x\" } as other | 403 | not yet |\n";
  const c = conformChecksFrom({ routes: [], specs: [{ folder: "articles", text: spec }] });
  assert.deepEqual(c.map((x) => [x.kind, x.expect.status]), [["scope", "denied"]]);
});

test("conform run: {{unique}} is fresh for every request, {{name}} comes from the seed (paths, bodies and expected fields)", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  const seen = new Set();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const b = JSON.parse(body || "{}");
      const dup = seen.has(b.title);
      seen.add(b.title);
      res.writeHead(dup ? 422 : 201, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: b.title, by: b.by, q: req.url.split("?")[1] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const step = { request: { method: "POST", path: "/x?by={{username}}", as: "anon", body: '{ title: "T {{unique}}", by: "{{username}}" }' }, expect: { status: 201, fields: { by: '"{{username}}"', q: '"by=ann"' } } };
  const r = await runChecks([{ id: "a", ...step }, { id: "b", steps: [step, step] }], { url, seeds: { username: "ann" } });
  server.close();
  assert.equal(r.passed, 2, JSON.stringify(r.failed));
  assert.ok([...seen].every((t) => /^T \S+$/.test(t)) && seen.size === 3);
});

test("conform: an `as other` 403 row passes on a 404 too (denied either way), and the pass says what came back", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  const spec = "## Requirements\n\n- **FR-009**: Only the author MAY edit [evidence: src/a.ts:3]\n  - Examples:\n\n    | Given | Then | Proven by |\n    |---|---|---|\n    | DELETE /api/articles/:slug as other | 403 | not yet |\n";
  const [c] = conformChecksFrom({ routes: [], specs: [{ folder: "articles", text: spec }] });
  assert.equal(c.expect.status, "denied");
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const r = await runChecks([c], { url: `http://127.0.0.1:${server.address().port}`, users: USERS, seeds: { slug: "mine" } });
  server.close();
  assert.equal(r.passed, 1);
  assert.deepEqual(r.denied, [{ id: c.id, got: 404 }]);
});

test("conform: spec.json may write `denied` as an example's status", async () => {
  const { validate } = await import("../core/specdata.mjs");
  const spec = { feature: "A", seeds: ["DELETE /a/:id"], requirements: [{ id: "FR-001", rule: "Only the owner MAY delete", evidence: ["a.ts:1"], examples: [{ given: { method: "DELETE", path: "/a/:id", as: "other" }, then: { status: "denied" } }] }] };
  assert.deepEqual(validate(spec), []);
  assert.ok(validate({ ...spec, requirements: [{ ...spec.requirements[0], examples: [{ given: { method: "GET", path: "/a" }, then: { status: "nope" } }] }] }).length);
});

test("conform run: a row's path can't leave the app (//host, backslash, absolute URL): not run, no request sent", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; res.writeHead(200); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const checks = ["//evil.example/steal", "/\\evil.example/steal", `http://127.0.0.1:${port}/x`, "x/relative"].map((p, i) => ({ id: `c${i}`, request: { method: "GET", path: p, as: "owner" }, expect: { status: 200 } }));
  const r = await runChecks(checks, { url: `http://127.0.0.1:${port}`, users: USERS, seeds: {} });
  server.close();
  assert.equal(hits, 0);
  assert.equal(r.passed, 0);
  assert.deepEqual(r.not_run.map((n) => n.id), ["c0", "c1", "c2", "c3"]);
  assert.match(r.not_run[0].why, /path/);
});

test("conform run: bodies are sent as written (strings holding `, y:` too), a body that isn't literal isn't run, seed values are escaped", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  const got = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { got.push(b); res.writeHead(200, { "content-type": "application/json" }); res.end(b || "{}"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const row = (id, body, fields) => ({ id, request: { method: "POST", path: "/a", as: "anon", body }, expect: { status: 200, ...(fields ? { fields } : {}) } });
  const r = await runChecks([
    row("strings", `{ bio: "x, y: z", note: 'it\\'s' }`, { bio: '"x, y: z"' }),
    row("variables", "{ items, total: price * 2 }"),
    row("seeded", '{ name: "{{name}}" }', { name: '"{{name}}"' }),
  ], { url, seeds: { name: 'Ann "the" Admin' } });
  server.close();
  assert.deepEqual(JSON.parse(got[0]), { bio: "x, y: z", note: "it's" });
  assert.equal(r.passed, 2, JSON.stringify(r.failed));
  assert.deepEqual(r.not_run.map((n) => [n.id, n.why]), [["variables", "the body isn't literal JSON: { items, total: price * 2 }"]]);
  assert.equal(got.length, 2, "nothing sent for the body that isn't literal");
});

test("conform: the repo's seed command runs only with --run-seed; without it, it's shown and nothing runs", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-seed-"));
  fs.writeFileSync(path.join(repo, ".veridic.json"), JSON.stringify({ conform: { seed: "touch ran.txt" } }));
  const out = spawnSync(process.execPath, [path.resolve("skill/scripts/conform.mjs"), "--repo", repo, "--url", "http://127.0.0.1:9"], { encoding: "utf8" });
  const ran = fs.existsSync(path.join(repo, "ran.txt"));
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(ran, false);
  assert.notEqual(out.status, 0);
  assert.match(out.stdout + out.stderr, /touch ran\.txt[\s\S]*--run-seed/);
});
