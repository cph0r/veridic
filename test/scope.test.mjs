import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeRepo } from "./fixture.mjs";
import { openGraph } from "../core/graph.mjs";
import { routeInventory } from "../core/routes.mjs";
import { scope } from "../core/scope.mjs";
import { contractFromDoc, drift, handlerFacts } from "../core/contract.mjs";

const repo = makeRepo();
after(() => fs.rmSync(repo, { recursive: true, force: true }));
const g = openGraph(repo);
const inv = routeInventory(g, { entry: "src/app.ts" });
// Small fixture: any symbol used by more than two files counts as ubiquitous.
const OPTS = { minUbiquity: 2, percentile: 0.5 };

test("routeInventory mounts routes under their prefix with handler extents", () => {
  assert.deepEqual(
    inv.routes.map((r) => [r.id, r.start, r.end]),
    [
      ["POST /api/payment/webhook", 5, 9],
      ["GET /api/health", 4, 7],
      ["POST /api/orders", 5, 10],
    ],
  );
});

test("usesInRange attributes file-level edges by line", () => {
  assert.deepEqual(
    g.usesInRange("src/jobs.ts", 2, 2).map((u) => u.target.name),
    ["expire"],
  );
});

test("scope pulls in a webhook via a shared service and a timer via a shared state literal", () => {
  const s = scope(g, inv, ["POST /api/orders"], OPTS);
  assert.deepEqual(s.unresolved, []);
  assert.deepEqual(s.routes.map((r) => r.id), ["POST /api/orders"]);

  const hook = s.webhooks.find((w) => w.id === "POST /api/payment/webhook");
  assert.ok(hook, "webhook included");
  assert.deepEqual(hook.shared.map((x) => [x.symbol, x.hops]), [["notifyKitchen", 3]]);

  const timer = s.timers.find((t) => t.id.includes("expiry"));
  assert.ok(timer, "timer included");
  assert.deepEqual(timer.shared_literals, ["awaiting_payment"]);
  assert.equal(timer.every, "60000 ms");
  assert.equal(timer.tier, "core");
});

test("scope leaves out units that share only a ubiquitous symbol", () => {
  const s = scope(g, inv, ["POST /api/orders"], OPTS);
  assert.ok(s.thresholds.ubiquitous_in_degree < g.inDegree("fn:log"));
  assert.ok(![...s.routes, ...s.webhooks].some((r) => r.id === "GET /api/health"));
  assert.ok(!s.services.some((x) => x.name === "log"));
});

test("scope follows a client URL through its wrapper to the page that calls it", () => {
  const s = scope(g, inv, ["POST /api/orders"], OPTS);
  const c = s.clients.find((x) => x.route === "POST /api/orders");
  assert.equal(c.at, "web/api.ts:1");
  assert.deepEqual(c.callers, ["web/page.tsx:3"]);
});

test("scope read_list starts with the seed handler, then its callees", () => {
  const s = scope(g, inv, ["POST /api/orders"], OPTS);
  assert.equal(s.read_list[0].at, "src/routes/orders.ts:5-10");
  assert.equal(s.read_list[0].priority, 0);
  assert.ok(s.read_list.findIndex((r) => r.at.startsWith("src/services/orders.ts")) < s.read_list.findIndex((r) => r.at.startsWith("src/routes/hooks.ts")));
});

test("scope reports seeds it cannot resolve", () => {
  const s = scope(g, inv, ["DELETE /api/nope"], OPTS);
  assert.equal(s.error, "no seed resolved");
  assert.deepEqual(s.unresolved, ["DELETE /api/nope"]);
});

const contract = contractFromDoc({
  servers: [{ url: "/api" }],
  paths: {
    "/orders": {
      post: {
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Body" } } } },
        responses: { 201: {}, 401: {} },
      },
    },
    "/refunds": { post: { responses: { 200: {} } } },
  },
  components: { schemas: { Body: { type: "object", properties: { tableId: { type: "integer" } } } } },
});

test("handlerFacts finds explicit and implicit statuses and body reads", () => {
  const r = inv.routes.find((x) => x.id === "POST /api/orders");
  const f = handlerFacts(g, r);
  assert.deepEqual(f.statuses.map((s) => s.status), [400, 201]);
  assert.deepEqual(f.fields.map((x) => x.field), ["tableId", "note"]);
  const h = handlerFacts(g, inv.routes.find((x) => x.id === "GET /api/health"));
  assert.deepEqual(h.statuses, [{ status: 200, line: 6, implicit: true }]);
});

test("drift reports missing and extra operations, status gaps and undeclared body fields", () => {
  const d = drift(g, contract, inv.routes);
  assert.deepEqual(d.documented_not_implemented.map((o) => o.id), ["POST /api/refunds"]);
  assert.deepEqual(d.implemented_not_documented.map((o) => o.id).sort(), ["GET /api/health", "POST /api/payment/webhook"]);
  const op = d.operations.find((o) => o.id === "POST /api/orders");
  assert.deepEqual(op.undocumented_statuses.map((s) => s.status), [400]);
  assert.deepEqual(op.unreturned_statuses, [{ status: 401 }]);
  assert.deepEqual(op.undeclared_body_fields.map((f) => f.field), ["note"]);
  assert.ok(d.summary.problems > 0);
});

test("drift scoped to a feature does not report other features' documented ops", () => {
  const routes = inv.routes.filter((r) => r.id === "POST /api/orders");
  const d = drift(g, contract, routes, { scoped: true, scopeIds: new Set(["POST /api/orders"]) });
  assert.deepEqual(d.documented_not_implemented, []);
  assert.equal(d.summary.documented_ops, 1);
});

test("routeInventory finds routes on named routers that CodeGraph doesn't index", () => {
  const files = {
    "src/app.ts": 'import express from "express";\nimport { ordersRouter } from "./orders";\nconst app = express();\napp.use("/api", ordersRouter);\n',
    "src/orders.ts": 'import { Router } from "express";\nexport const ordersRouter = Router();\nordersRouter.get("/orders", (req, res) => {\n  res.json([]);\n});\nordersRouter.post(\n  "/orders/:id/refund", (req, res) => res.end());\n',
  };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-named-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  const fake = {
    repo,
    files: Object.keys(files),
    nodes: new Map([["use", { id: "use", kind: "route", name: "USE /api", file: "src/app.ts", start: 4, end: 4 }]]),
    text: (f) => files[f],
    lines: (f) => files[f].split("\n"),
  };
  const got = routeInventory(fake).routes.map((r) => [r.id, r.start, r.end]);
  assert.deepEqual(got, [["GET /api/orders", 3, 5], ["POST /api/orders/:id/refund", 6, 7]]);
  fs.rmSync(repo, { recursive: true, force: true });
});
