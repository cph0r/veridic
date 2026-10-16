// A tiny Express repo with a hand-built CodeGraph index (only the columns
// veridic reads), so scope and drift can be tested without a real index.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FILES = {
  "src/app.ts": `import orders from "./routes/orders";
import hooks from "./routes/hooks";
import misc from "./routes/misc";
app.use("/api", orders);
app.use("/api", hooks);
app.use("/api", misc);
`,
  "src/log.ts": `export function log(msg) {
  console.log(msg);
}
`,
  "src/kitchen.ts": `export function notifyKitchen(order) {
  return order;
}
`,
  "src/services/orders.ts": `import { notifyKitchen } from "../kitchen";
import { log } from "../log";
export async function placeOrder(body) {
  log("placing");
  const order = { ...body, status: "awaiting_payment" };
  return notifyKitchen(order);
}
`,
  "src/routes/orders.ts": `import { Router } from "express";
import { placeOrder } from "../services/orders";
import { log } from "../log";
const router = Router();
router.post("/orders", async (req, res) => {
  log("x");
  if (!req.body.tableId) return res.status(400).json({ error: "table" });
  const o = await placeOrder({ table: req.body.tableId, note: req.body.note });
  res.status(201).json(o);
});
export default router;
`,
  "src/routes/hooks.ts": `import { Router } from "express";
import { notifyKitchen } from "../kitchen";
import { log } from "../log";
const router = Router();
router.post("/payment/webhook", (req, res) => {
  log("hook");
  notifyKitchen(req.body);
  res.json({ ok: true });
});
export default router;
`,
  "src/routes/misc.ts": `import { Router } from "express";
import { log } from "../log";
const router = Router();
router.get("/health", (req, res) => {
  log("h");
  res.json({});
});
export default router;
`,
  "src/jobs.ts": `import { log } from "./log";
export const expiry = setInterval(expire, 60_000);
function expire(rows) {
  log("e");
  return rows.filter((r) => r.status === "awaiting_payment");
}
`,
  "web/api.ts": `export const getPlaceOrderUrl = () => \`/api/orders\`;
export function placeOrder(body) {
  return fetch(getPlaceOrderUrl(), { method: "POST", body });
}
`,
  "web/page.tsx": `import { placeOrder } from "./api";
export function Page() {
  return placeOrder({});
}
`,
};

// [id, kind, name, file, start, end]
const NODES = [
  ["route:orders", "route", "POST /orders", "src/routes/orders.ts", 5, 5],
  ["route:hook", "route", "POST /payment/webhook", "src/routes/hooks.ts", 5, 5],
  ["route:health", "route", "GET /health", "src/routes/misc.ts", 4, 4],
  ["fn:log", "function", "log", "src/log.ts", 1, 3],
  ["fn:notifyKitchen", "function", "notifyKitchen", "src/kitchen.ts", 1, 3],
  ["fn:placeOrder", "function", "placeOrder", "src/services/orders.ts", 3, 7],
  ["const:expiry", "constant", "expiry", "src/jobs.ts", 2, 2],
  ["fn:expire", "function", "expire", "src/jobs.ts", 3, 6],
  ["fn:getPlaceOrderUrl", "constant", "getPlaceOrderUrl", "web/api.ts", 1, 1],
  ["fn:webPlaceOrder", "function", "placeOrder", "web/api.ts", 2, 4],
  ["fn:Page", "function", "Page", "web/page.tsx", 2, 4],
];
// [source, target, kind, line]
const EDGES = [
  ["route:orders", "fn:log", "calls", 5],
  ["route:orders", "fn:placeOrder", "calls", 5],
  ["fn:placeOrder", "fn:log", "calls", 4],
  ["fn:placeOrder", "fn:notifyKitchen", "calls", 6],
  ["route:hook", "fn:log", "calls", 5],
  ["route:hook", "fn:notifyKitchen", "calls", 5],
  ["route:health", "fn:log", "calls", 4],
  ["file:src/jobs.ts", "fn:expire", "references", 2],
  ["fn:expire", "fn:log", "calls", 4],
  ["fn:webPlaceOrder", "fn:getPlaceOrderUrl", "calls", 3],
  ["fn:Page", "fn:webPlaceOrder", "calls", 3],
];

export function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-fixture-"));
  for (const [f, src] of Object.entries(FILES)) {
    fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), src);
  }
  fs.mkdirSync(path.join(repo, ".codegraph"));
  const db = new DatabaseSync(path.join(repo, ".codegraph", "codegraph.db"));
  db.exec(`create table nodes (id text primary key, kind text, name text, file_path text, start_line int, end_line int);
           create table edges (source text, target text, kind text, line int);
           create table files (path text primary key);`);
  const addNode = db.prepare("insert into nodes values (?, ?, ?, ?, ?, ?)");
  for (const f of Object.keys(FILES)) {
    db.prepare("insert into files values (?)").run(f);
    addNode.run(`file:${f}`, "file", path.basename(f), f, 1, FILES[f].split("\n").length);
  }
  for (const n of NODES) addNode.run(...n);
  const addEdge = db.prepare("insert into edges values (?, ?, ?, ?)");
  for (const e of EDGES) addEdge.run(...e);
  db.close();
  return repo;
}
