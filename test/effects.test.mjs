import { test } from "node:test";
import assert from "node:assert/strict";
import { routeEffects, readiness } from "../core/effects.mjs";

// A two-function graph: the handler calls a helper that writes and notifies.
const files = {
  "routes.ts": ["router.get('/x', async (req, res) => {", "  // db.delete(ordersTable) in a comment", "  await save(req.query.id);", "  logger.emit('info', 'x');", "});"],
  "svc.ts": ["export async function save(id) {", "  await db.update(ordersTable).set({ paidAt: new Date() });", "  notifyOrderUpdate(1, {});", "  sendInvoiceEmail({});", "}"],
};
const save = { id: "save", kind: "function", name: "save", file: "svc.ts", start: 1, end: 5 };
const g = {
  lines: (f) => files[f],
  usesInRange: (f, s, e) => (f === "routes.ts" && s <= 3 && e >= 3 ? [{ target: save }] : []),
};

test("effects follow calls, skip comments and logger emits", () => {
  const found = routeEffects(g, { id: "GET /x", file: "routes.ts", start: 1, end: 5 });
  const kinds = found.map((e) => `${e.kind}@${e.at}`);
  assert.ok(kinds.includes("write@svc.ts:2"));
  assert.ok(kinds.includes("moves_money@svc.ts:2"));
  assert.ok(kinds.includes("notifies@svc.ts:3"));
  assert.ok(kinds.includes("notifies@svc.ts:4"), "sendInvoiceEmail counts as a notification");
  assert.ok(!kinds.some((k) => k.startsWith("destructive")), "commented-out delete ignored");
  assert.ok(!kinds.some((k) => k.endsWith("routes.ts:4")), "logger emit is not a notification");
  assert.equal(found.find((e) => e.at === "svc.ts:2").via, "save");
});

const tool = (over) => ({ tool: "X", method: "POST", effect: "write", moves_money: false, notifies: false, requires: { access: "auth", scoped_to_caller: "yes" }, handler: "a.ts:1-9", evidence: [], access_flags: [], ...over });

test("readiness flags GETs that write, unscoped money and id routes", () => {
  const r = readiness([
    tool({ tool: "GET /pay-status", method: "GET", moves_money: true, evidence: [{ kind: "write", at: "a.ts:3" }] }),
    tool({ tool: "POST /verify", moves_money: true, requires: { access: "auth", scoped_to_caller: "no" }, evidence: [{ kind: "moves_money", at: "a.ts:5" }] }),
    tool({ tool: "POST /webhook", moves_money: true, requires: { access: "public", scoped_to_caller: "no" } }),
    tool({ tool: "DELETE /o/:id", effect: "destructive", access_flags: ["id-param-without-caller-scope"] }),
    tool({ tool: "GET /o/:id", method: "GET", effect: "read", access_flags: ["id-param-without-caller-scope"] }),
    tool({ tool: "GET /list", method: "GET", effect: "read" }),
  ]);
  const got = r.issues.map((i) => `${i.severity} ${i.kind} ${i.tool}`);
  assert.deepEqual(got.sort(), [
    "high get-that-writes GET /pay-status",
    "high id-param-without-caller-scope DELETE /o/:id",
    "high money-not-scoped POST /verify",
    "low id-param-without-caller-scope GET /o/:id",
  ]);
  assert.equal(r.summary.gets_that_write, 1);
  assert.equal(r.summary.agent_ready_pct, 50);
});

test("policy mismatches from an intended matrix are high", () => {
  const r = readiness([tool({})], { mismatches: [{ route: "X", problems: ["needs a paid-plan check"], at: "a.ts:1" }] });
  assert.equal(r.issues[0].kind, "policy-mismatch");
  assert.equal(r.summary.issues.high, 1);
});
