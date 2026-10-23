// Express styles found while benchmarking on public apps: each test is one style
// that route discovery, effect tracing or the access check once missed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeInventory } from "../core/routes.mjs";
import { codeOnly } from "../core/tests.mjs";
import { routeEffects } from "../core/effects.mjs";
import { accessMatrix } from "../core/access.mjs";

// A fake index over real files: no CodeGraph route nodes, so discovery must come from source.
function fakeRepo(files, nodes = []) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-gen-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  const g = {
    repo,
    files: Object.keys(files),
    nodes: new Map(nodes.map((n) => [n.id, n])),
    text: (f) => files[f] ?? null,
    lines: (f) => files[f]?.split("\n") ?? [],
    usesInRange: () => [],
  };
  return { g, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
const ids = (g) => routeInventory(g).routes.map((r) => r.id).sort();

test("routes: route() chains, chained use(), anonymous exported routers", () => {
  const { g, done } = fakeRepo({
    "src/main.ts": 'import express from "express";\nimport routes from "./routes";\nconst app = express();\napp.use(routes);\napp.listen(3000);\n',
    "src/routes.ts": 'import { Router } from "express";\nimport users from "./users";\nconst api = Router()\n  .use(users);\nexport default Router().use("/api", api);\n',
    "src/users.ts": 'import { Router } from "express";\nconst router = Router();\nrouter\n  .route("/users/:id")\n  .get(show)\n  .delete(remove);\nrouter.route("/users").post(create).get(list);\nexport default router;\n',
  });
  assert.deepEqual(ids(g), ["DELETE /api/users/:id", "GET /api/users", "GET /api/users/:id", "POST /api/users"]);
  done();
});

test("routes: a helper mounting routes on the router it is given", () => {
  const { g, done } = fakeRepo({
    "src/main.ts": 'import express from "express";\nimport admin from "./admin";\nimport owner from "./owner";\nconst app = express();\napp.use("/api", admin);\napp.use("/api", owner);\napp.listen(3000);\n',
    "src/jobRoutes.ts": 'export function mountJobRoutes(router, { base, startPath, resolveId }) {\n  router.post(startPath ?? `${base}/start`, start);\n  router.get(`${base}/stream`, stream);\n}\n',
    "src/admin.ts": 'import { Router } from "express";\nimport { mountJobRoutes } from "./jobRoutes";\nconst router = Router();\nmountJobRoutes(router, { base: "/admin/jobs", resolveId: (req) => req.user.id });\nexport default router;\n',
    "src/owner.ts": 'import { Router } from "express";\nimport { mountJobRoutes } from "./jobRoutes";\nconst router = Router();\nmountJobRoutes(router, { base: "/owner/jobs", resolveId: (req) => req.params.id });\nexport default router;\n',
  });
  const got = ids(g);
  for (const id of ["POST /api/admin/jobs/start", "GET /api/admin/jobs/stream", "POST /api/owner/jobs/start", "GET /api/owner/jobs/stream"]) assert.ok(got.includes(id), `${id} in ${got.join(", ")}`);
  done();
});

test("routes: CommonJS require/module.exports and route lists mounted in a loop", () => {
  const { g, done } = fakeRepo({
    "src/app.js": 'const express = require("express");\nconst routes = require("./routes/v1");\nconst app = express();\napp.use("/v1", routes);\napp.listen(1);\n',
    "src/routes/v1/index.js": 'const express = require("express");\nconst authRoute = require("./auth.route");\nconst router = express.Router();\nconst defaultRoutes = [\n  { path: "/auth", route: authRoute },\n];\ndefaultRoutes.forEach((route) => {\n  router.use(route.path, route.route);\n});\nmodule.exports = router;\n',
    "src/routes/v1/auth.route.js": 'const express = require("express");\nconst router = express.Router();\nrouter.post("/login", login);\nmodule.exports = router;\n',
  });
  assert.deepEqual(ids(g), ["POST /v1/auth/login"]);
  done();
});

test("routes: an app handed in as a parameter mounts at the root; settings reads and commented routes aren't routes", () => {
  const { g, done } = fakeRepo({
    "server.js": 'const express = require("express");\nconst app = express();\napp.get("env");\n// app.get("/old", h);\nrequire("./config/routes")(app);\napp.listen(1);\n',
    "config/routes.js": 'module.exports = function (app) {\n  app.get("/login", login);\n  app.get(`/tutorial/${page}`, show);\n};\n',
  });
  assert.deepEqual(ids(g), ["GET /login", "GET /tutorial/:page"]);
  done();
});

test("code blanking: regex literals with quotes don't swallow the code after them", () => {
  const code = codeOnly('const r = /a href="([^"]+)"/g;\napp.use("/x", y);\nconst d = a / b / c;');
  assert.match(code, /app\.use\(/);
  assert.match(code, /a \/ b \/ c/);
});

test("code blanking: a template nested in ${…} doesn't end the outer one", () => {
  const code = codeOnly("cy.visit(`/x?d=${encodeURIComponent(`../${loc.pathname}/redirect?to=https://a.b/c`)}`)\ncy.expectChallengeSolved({ challenge: 'X' })\n");
  assert.match(code, /encodeURIComponent\(/);
  assert.match(code, /loc\.pathname/);
  assert.match(code, /cy\.expectChallengeSolved\(/);
  assert.doesNotMatch(code, /a\.b/);
});

test("effects: MongoDB/Mongoose writes and deletes, through a controller module and exports.x handlers", () => {
  const files = {
    "routes.js": 'const ctrl = require("./ctrl");\nrouter.post("/users", ctrl.create);\nrouter.delete("/users/:id", ctrl.remove);\nrouter.get("/pdf", ctrl.pdf);\n',
    "ctrl.js": 'exports.create = async (req, res) => {\n  const user = await User.create(req.body);\n  res.json(user);\n};\nexports.remove = async (req, res) => {\n  await User.findByIdAndDelete(req.params.id);\n};\nexports.pdf = async (req, res) => {\n  const doc = await PDFDocument.create();\n  res.set({ "Content-Type": "application/pdf" });\n};\n',
  };
  const { g, done } = fakeRepo(files);
  const kinds = (start) => new Set(routeEffects(g, { id: "x", file: "routes.js", start, end: start }).map((e) => e.kind));
  assert.ok(kinds(2).has("write"), "User.create is a write");
  assert.ok(kinds(3).has("destructive"), "findByIdAndDelete is destructive");
  assert.equal(kinds(4).size, 0, "PDFDocument.create and res.set are not database writes");
  done();
});

test("access: middleware guards (protect/admin, auth('perm'), isX()) and code-only params", () => {
  const src = [
    'router.route("/orders/:id/deliver").put(protect, admin, deliver);',
    'router.delete("/users/:userId", auth("manageUsers"), remove);',
    'app.put("/rest/order-history/:id/status", security.isAccounting(), toggle);',
    'app.put("/rest/continue-code/apply/:continueCode", apply);',
    'router.put("/orders/:id/pay", protect, pay);',
  ];
  const g = { lines: () => src, text: () => src.join("\n"), nodes: new Map(), usesInRange: () => [] };
  const r = (i, method, p, handlerText) => ({ id: `${method} ${p}`, method, path: p, file: "r.js", start: i, end: i, guards: [], ...(handlerText ? { handlerText } : {}) });
  const m = accessMatrix(g, { routes: [r(1, "PUT", "/orders/:id/deliver", "protect, admin, deliver"), r(2, "DELETE", "/users/:userId"), r(3, "PUT", "/rest/order-history/:id/status"), r(4, "PUT", "/rest/continue-code/apply/:continueCode"), r(5, "PUT", "/orders/:id/pay")] });
  assert.deepEqual(m.map((x) => x.access), ["role", "role", "role", "public", "auth"]);
  assert.deepEqual(m.map((x) => x.flags.length > 0), [false, false, false, false, true]);
});

test("routes: inline require and router factories in use(), folder loops, object registrars", () => {
  const { g, done } = fakeRepo({
    "server.js": 'const express = require("express");\nconst inventory = require("./routes/inventory");\nconst app = express();\napp.use("/api/inventory", auth, inventory(uploads));\napp.use("/v1", require("./routes"));\napp.listen(1);\n',
    "routes/inventory.js": 'const express = require("express");\nmodule.exports = function (uploads) {\n  const router = express.Router();\n  router.delete("/product/:id", del);\n  return router;\n};\n',
    "routes/index.js": 'const fs = require("fs");\nconst router = require("express").Router();\nconst express = require("express");\nfs.readdirSync(__dirname).forEach((routeFile) => {\n  router.use(`/${routeFile}`, require(`./${routeFile}`));\n});\nconst routes = { users };\nfor (const k in routes) routes[k](router);\nmodule.exports = router;\n',
    "routes/cities.js": 'const express = require("express");\nconst router = express.Router();\nrouter.get("/", list);\nmodule.exports = router;\n',
  });
  assert.deepEqual(ids(g), ["DELETE /api/inventory/product/:id", "GET /v1/cities"]);
  done();
});

test("routes: tsconfig path aliases, the router among several use() args, and factories behind a barrel", () => {
  const { g, done } = fakeRepo({
    "tsconfig.json": '{ "compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["*"] } }, /* a comment */ "include": ["src/**/*"] }',
    "src/index.ts": 'import express from "express";\nimport { router } from "@/routes";\nimport { notFound } from "@/middlewares";\nconst app = express();\napp.use(cors, router, notFound);\napp.listen(1);\n',
    "src/middlewares/index.ts": "export const notFound = (req, res) => res.status(404).end();\n",
    "src/routes/index.ts": 'import { Router } from "express";\nimport { createLoginRouter } from "../auth";\nexport const router = Router();\nlet loginRouter;\nloginRouter = createLoginRouter("local");\nrouter.use(`/login/${provider}`, loginRouter);\n',
    "src/auth/index.ts": 'export { createLoginRouter } from "./local";\n',
    "src/auth/local.ts": 'import { Router } from "express";\nexport function createLoginRouter(name) {\n  const router = Router();\n  router.post("/", login);\n  return router;\n}\n',
  });
  assert.deepEqual(ids(g), ["POST /login/:provider"]);
  done();
});

test("routes: an app handed to a class method mounts its routers; jsonc keeps strings with comment-like text", async () => {
  const { jsonc } = await import("../core/routes.mjs");
  assert.deepEqual(JSON.parse(jsonc('{ "paths": { "@/*": ["*"] }, // note\n "include": ["src/**/*"], /* x */ "a": 1, }')), { paths: { "@/*": ["*"] }, include: ["src/**/*"], a: 1 });
  const { g, done } = fakeRepo({
    "src/providers/Routes.ts": 'import apiRouter from "../routes/Api";\nclass Routes {\n  public mountApi(_express) {\n    return _express.use(`/${apiPrefix}`, apiRouter);\n  }\n}\nexport default new Routes();\n',
    "src/routes/Api.ts": 'import { Router } from "express";\nconst router = Router();\nrouter.get("/", home);\nexport default router;\n',
  });
  assert.deepEqual(ids(g), ["GET /:apiPrefix"]);
  done();
});

test("access: identity taken from the request body, and a user id from the URL that shadows the session", () => {
  const src = [
    'app.put("/api/BasketItems/:id", security.appendUserId(), (req, res) => BasketItem.update({ quantity: 2 }, { where: { BasketId: req.body.BasketId } }));',
    'app.post("/api/Cards", security.appendUserId(), (req, res) => Card.create({ UserId: req.body.UserId }));',
    'app.post("/api/users", (req, res) => User.create(req.body.user));',
    'app.get("/allocations/:userId", isLoggedIn, (req, res) => { const { userId } = req.session; const { userId: id } = req.params; dao.get(req.params.userId); });',
    'app.get("/users/:userId", isLoggedIn, (req, res) => { if (req.params.userId !== req.user.id) return res.status(403).end(); dao.get(req.params.userId); });',
    'router.get("/v1/users/:userId", auth("getUsers"), (req, res) => dao.get(req.params.userId));',
  ];
  const g = { lines: () => src, text: () => src.join("\n"), nodes: new Map(), usesInRange: () => [] };
  const r = (i, method, p) => ({ id: `${method} ${p}`, method, path: p, file: "r.js", start: i, end: i, guards: [] });
  const m = accessMatrix(g, { routes: [r(1, "PUT", "/api/BasketItems/:id"), r(2, "POST", "/api/Cards"), r(3, "POST", "/api/users"), r(4, "GET", "/allocations/:userId"), r(5, "GET", "/users/:userId"), r(6, "GET", "/v1/users/:userId")] });
  const has = (i, kind) => m[i].flags.some((f) => f.startsWith(kind));
  assert.equal(has(0, "identity-from-request-body"), true, "BasketId from the body");
  assert.equal(has(1, "identity-from-request-body"), false, "UserId injected by appendUserId");
  assert.equal(has(2, "identity-from-request-body"), false, "a { user: … } payload is data, not an identity");
  assert.equal(has(3, "user-id-from-url"), true, "params.userId used, session id ignored");
  assert.equal(m[3].scoped, "no");
  assert.equal(has(4, "user-id-from-url"), false, "compared with the caller");
  assert.equal(m[5].access, "role", "a guard given a permission is an authorization check");
});

test("access: guards passed as an array, identity from a session helper, API keys on admin routes, single-user mode", () => {
  const src = [
    'app.post("/workspace/:slug/chat-feedback/:chatId", [validatedRequest, flexUserRoleValid([ROLES.all]), validWorkspaceSlug], async (request, response) => { const user = await userFromSession(request, response); await Chats.get({ id: request.params.chatId, user_id: user?.id }); });',
    'app.delete("/v1/admin/users/:id", [validApiKey], async (request, response) => { await User.delete({ id: request.params.id }); });',
    'app.delete("/workspace/:slug/thread/:threadId", [validatedRequest], async (request, response) => { await Thread.delete({ id: request.params.threadId }); });',
    'app.delete("/documents/:docId", [validatedRequest, isSingleUserMode], async (request, response) => { await Doc.delete({ id: request.params.docId }); });',
    'router.delete("/access/:pk", asyncHandler(async (req, res, next) => { const service = new AccessService({ accountability: req.accountability, schema: req.schema }); await service.deleteOne(req.params.pk); }));',
  ];
  const g = { lines: () => src, text: () => src.join("\n"), nodes: new Map(), usesInRange: () => [] };
  const r = (i, method, p) => ({ id: `${method} ${p}`, method, path: p, file: "r.js", start: i, end: i, guards: [] });
  const m = accessMatrix(g, { routes: [r(1, "POST", "/workspace/:slug/chat-feedback/:chatId"), r(2, "DELETE", "/v1/admin/users/:id"), r(3, "DELETE", "/workspace/:slug/thread/:threadId"), r(4, "DELETE", "/documents/:docId"), r(5, "DELETE", "/access/:pk")] });
  assert.equal(m[0].access, "auth", "validatedRequest signs the caller in");
  assert.equal(m[0].scoped, "yes", "userFromSession(request) is the caller");
  assert.equal(m[1].access, "role", "an API key on an /admin route is an admin credential");
  assert.ok(m[2].flags.includes("id-param-without-caller-scope"), "a signed-in delete by id with no caller scope is still flagged");
  assert.equal(m[3].flags.length, 0, "single-user mode has one owner");
  assert.equal(m[4].scoped, "yes", "the caller's accountability handed to a service that enforces permissions");
});

test("effects: closing a response stream is not a destructive write", () => {
  const files = { "r.js": 'router.get("/stream", (req, res) => {\n  res.destroy();\n  stream.destroy();\n});\n' };
  const { g, done } = fakeRepo(files);
  assert.equal(routeEffects(g, { id: "x", file: "r.js", start: 1, end: 4 }).filter((e) => e.kind === "destructive").length, 0);
  done();
});

test("effects: cheerio/jQuery $(…).remove() edits HTML, it doesn't delete data", () => {
  const files = { "r.js": 'router.get("/status", (req, res) => {\n  $("link[rel=icon]").remove();\n  res.send($.html());\n});\nrouter.delete("/x/:id", (req, res) => {\n  Item.remove({ _id: req.params.id });\n});\n' };
  const { g, done } = fakeRepo(files);
  const kinds = (start, end) => new Set(routeEffects(g, { id: "x", file: "r.js", start, end }).map((e) => e.kind));
  assert.equal(kinds(1, 4).has("destructive"), false);
  assert.equal(kinds(5, 7).has("destructive"), true);
  done();
});

test("reach: a member call isn't linked by name to a function elsewhere, nor a built-in to a class it never names", async () => {
  const { reached } = await import("../core/reach.mjs");
  const files = {
    "routes.js": 'router.get("/info", async (req, res) => {\n  const list = items.sort();\n  await service.snapshot();\n  res.json(list);\n});\n',
    "cli.js": "function snapshot() {\n  db.insert();\n}\n",
    "utils.js": "class UtilsService {\n  sort() {\n    db.update();\n  }\n}\n",
  };
  const nodes = [
    { id: "f", kind: "function", name: "snapshot", file: "cli.js", start: 1, end: 3 },
    { id: "m", kind: "method", name: "sort", qname: "UtilsService::sort", file: "utils.js", start: 2, end: 4 },
  ];
  const { g, done } = fakeRepo(files, nodes);
  g.usesInRange = (file) => (file === "routes.js" ? nodes.map((t) => ({ target: t })) : []);
  const names = reached(g, { id: "GET /info", file: "routes.js", start: 1, end: 5 }, 1).slice(1).map((n) => n.name);
  assert.deepEqual(names, []);
  done();
});

test("modules: same feature across files joins, a file of many features splits by URL, .veridic.json pins", async () => {
  const { findModules } = await import("../core/modules.mjs");
  const r = (method, p, file, line) => ({ id: `${method} ${p}`, method, path: p, file, start: line, end: line });
  const big = ["users", "products", "baskets"].flatMap((w, i) => [1, 2, 3, 4].map((k) => r(k % 2 ? "GET" : "POST", `/api/${w}/${k}`, "server.js", i * 10 + k)));
  const routes = [r("GET", "/api/admin/orders", "src/routes/orders.ts", 1), r("POST", "/api/public/orders", "src/routes/public/orders/crud.ts", 1), r("GET", "/api/menu", "src/routes/menu.ts", 1), r("GET", "/api/healthz", "src/routes/health.ts", 1), ...big];
  const files = Object.fromEntries([...new Set(routes.map((x) => x.file))].map((f) => [f, "x\n".repeat(40)]));
  const { g, done } = fakeRepo(files);
  const name = (ms, id) => ms.find((m) => m.routes.includes(id))?.name;
  let ms = findModules(g, { routes });
  assert.equal(name(ms, "GET /api/admin/orders"), name(ms, "POST /api/public/orders"), "orders.ts and public/orders/crud.ts are one module");
  assert.notEqual(name(ms, "GET /api/menu"), name(ms, "GET /api/admin/orders"));
  assert.notEqual(name(ms, "GET /api/users/1"), name(ms, "GET /api/products/1"), "a file serving several features splits by URL");
  fs.writeFileSync(path.join(g.repo, ".veridic.json"), JSON.stringify({ modules: { Platform: ["src/routes/health.ts", "/api/menu"] } }));
  ms = findModules(g, { routes });
  assert.equal(name(ms, "GET /api/healthz"), "Platform");
  assert.equal(name(ms, "GET /api/menu"), "Platform");
  assert.ok(ms.find((m) => m.name === "Platform").pinned);
  done();
});

// ---- entry points beyond routes join the split ----
const entryRepo = (extra) => {
  const r = (method, p, file, line) => ({ id: `${method} ${p}`, method, path: p, file, start: line, end: line + 2 });
  const routes = [r("GET", "/api/orders", "src/orders.ts", 1), r("POST", "/api/orders", "src/orders.ts", 4)];
  const files = { "src/orders.ts": 'router.get("/orders", list);\n\n\nrouter.post("/orders", create);\n\n\n', ...extra };
  return { routes, ...fakeRepo(files) };
};

test("modules: a timer that shares nothing becomes its own module", async () => {
  const { findModules } = await import("../core/modules.mjs");
  const { routes, g, done } = entryRepo({ "src/jobs/retryPushes.ts": "export function start() {\n  setInterval(retry, 60000);\n}\n" });
  const ms = findModules(g, { routes });
  const m = ms.find((x) => x.id === "retry-pushes");
  assert.ok(m, "a module for the timer's file");
  assert.equal(m.entries[0].kind, "timer");
  assert.equal(m.routes.length, 0);
  assert.ok(m.files.includes("src/jobs/retryPushes.ts"));
  assert.deepEqual(ms.find((x) => x.routes.includes("GET /api/orders")).entries, []);
  done();
});

test("modules: an entry point in a module's file joins that module", async () => {
  const { findModules } = await import("../core/modules.mjs");
  const { routes, g, done } = entryRepo({});
  g.text = (f) => (f === "src/orders.ts" ? 'router.get("/orders", list);\n\n\nrouter.post("/orders", create);\nsetInterval(sweep, 1000);\n' : null);
  const ms = findModules(g, { routes });
  assert.equal(ms.length, 1);
  assert.equal(ms[0].entries.length, 1);
  done();
});

test("modules: entry points join the module owning their folder, stay in the server package, and leftovers group by folder", async () => {
  const { findModules } = await import("../core/modules.mjs");
  const { routes, g, done } = entryRepo({
    "package.json": "{}",
    "src/cleanup.ts": "export function start() {\n  setInterval(sweep, 1000);\n}\n",
    "src/realtime/index.ts": 'import { WebSocketServer } from "ws";\nconst wss = new WebSocketServer({ port: 1 });\n',
    "src/realtime/connection.ts": 'import { WebSocket } from "ws";\nexport function c(wss) {\n  wss.on("connection", (ws) => ws);\n}\n',
    "web/package.json": "{}",
    "web/src/hooks/usePolling.ts": "export function usePolling() {\n  setInterval(poll, 5000);\n}\n",
  });
  g.files = [...g.files, "package.json", "web/package.json"];
  routes[0].file = routes[1].file = "src/orders.ts";
  const ms = findModules(g, { routes });
  const orders = ms.find((m) => m.routes.includes("GET /api/orders"));
  assert.ok(orders.entries.some((e) => e.file === "src/cleanup.ts"), "a timer next to a module's handlers joins it");
  const rt = ms.find((m) => m.entries.some((e) => e.file === "src/realtime/index.ts"));
  assert.ok(rt.entries.some((e) => e.file === "src/realtime/connection.ts"), "one module per folder of leftovers");
  assert.equal(rt.id, "realtime");
  assert.ok(!ms.some((m) => m.entries.some((e) => e.file.startsWith("web/"))), "frontend timers are not server entry points");
  done();
});

test("modules: a WebSocket server is an entry point", async () => {
  const { entryPoints } = await import("../core/scope.mjs");
  const { g, done } = fakeRepo({ "src/realtime/index.ts": 'export function attach(server) {\n  const wss = new WebSocketServer({ server });\n  wss.on("connection", (ws) => onConn(ws));\n}\n' });
  const es = entryPoints(g, ["src/realtime/index.ts"]);
  assert.ok(es.some((e) => e.kind === "socket" && e.file === "src/realtime/index.ts"));
  done();
});

// ---- screen groups ----
function screensRepo() {
  const files = {
    "api/package.json": "{}",
    "api/src/orders.ts": 'router.get("/orders", list);\n',
    "web/package.json": "{}",
    "web/src/App.tsx": 'import { lazy } from "react";\nimport Landing from "./pages/landing";\nconst Order = lazy(() => import("./pages/order"));\nconst AdminOrders = lazy(() => import("./pages/admin-orders"));\nconst AdminMenu = lazy(() => import("./pages/admin-menu"));\nimport OwnerClients from "./pages/owner/clients";\nimport OwnerStats from "./pages/owner/stats";\nexport default () => (<Switch>\n  <Route path="/" component={Landing} />\n  <Route path="/t/:table" component={Order} />\n  <Route path="/admin/orders" component={AdminOrders} />\n  <Route path="/admin/menu" component={AdminMenu} />\n  <Route path="/owner/clients" component={OwnerClients} />\n  <Route path="/owner/stats" component={OwnerStats} />\n</Switch>);\n',
    "web/src/pages/landing.tsx": 'import { Button } from "../components/Button";\nexport default function Landing() { return <Button />; }\n',
    "web/src/pages/order.tsx": 'import { Button } from "../components/Button";\nimport { CartPanel } from "./order/CartPanel";\nexport default function Order() { return <CartPanel />; }\n',
    "web/src/pages/order/CartPanel.tsx": 'export function CartPanel() { return <div />; }\n',
    "web/src/pages/admin-orders.tsx": 'import { Button } from "../components/Button";\nexport default function AdminOrders() { return <Button />; }\n',
    "web/src/pages/admin-menu.tsx": 'export default function AdminMenu() { return <div />; }\n',
    "web/src/pages/owner/clients.tsx": 'import { Button } from "../../components/Button";\nexport default function OwnerClients() { return <Button />; }\n',
    "web/src/pages/owner/stats.tsx": 'export default function OwnerStats() { return <div />; }\n',
    "web/src/components/Button.tsx": 'export function Button() { return <button />; }\n',
    "web/src/pages/owner/settings.tsx": 'export function OwnerSettingsPage() { return <div />; }\n',
    "web/src/pages/order/components/Tip.tsx": 'export default function Tip() { return <div />; }\n',
  };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-screens-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  const routes = [{ id: "GET /api/orders", method: "GET", path: "/api/orders", file: "api/src/orders.ts", start: 1, end: 1 }];
  return { repo, all: Object.keys(files), routes, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}

test("screens group by URL area", async () => {
  const { screenGroups } = await import("../core/screens.mjs");
  const r = screensRepo();
  const gs = screenGroups(r.repo, { all: r.all, routes: r.routes, specs: [] });
  assert.deepEqual(gs.map((x) => x.id).sort(), ["admin-app", "guest-app", "owner-app"]);
  const guest = gs.find((x) => x.id === "guest-app");
  assert.ok(guest.files.includes("web/src/pages/order/CartPanel.tsx"));
  assert.ok(guest.pages.includes("web/src/pages/landing.tsx"));
  assert.ok(!gs.some((x) => x.files.includes("web/src/components/Button.tsx")), "a component every area uses is shared UI");
  assert.equal(gs.find((x) => x.id === "admin-app").spec_path, "specs/admin-app/spec.md");
  assert.equal(gs.find((x) => x.id === "owner-app").name, "Owner screens");
  assert.ok(gs.find((x) => x.id === "owner-app").pages.includes("web/src/pages/owner/settings.tsx"), "a page in an area folder, not in the router");
  assert.ok(!gs.some((x) => x.pages.includes("web/src/pages/order/components/Tip.tsx")), "a component folder under pages holds no pages");
  r.done();
});

test("screen files are in their group, not in no part", async () => {
  const { screenGroups } = await import("../core/screens.mjs");
  const { specCoverage } = await import("../core/coverage.mjs");
  const r = screensRepo();
  const screens = screenGroups(r.repo, { all: r.all, routes: r.routes, specs: [] });
  const c = specCoverage(r.repo, { specs: [], modules: [], screens }, { files: r.all });
  assert.ok(!c.orphans.includes("web/src/pages/order/CartPanel.tsx"));
  assert.ok(c.orphans.includes("web/src/components/Button.tsx"));
  r.done();
});

test("prepare for a screen group lists its pages and the server rules its calls depend on", async () => {
  const { screenMarkdown } = await import("../core/modulectx.mjs");
  const data = {
    name: "shop", app: { title: "Shop" },
    routes: [{ id: "POST /api/orders", handler: "api/src/orders.ts:1-3" }],
    specs: [{ path: "specs/orders/spec.md", requirements: [{ id: "FR-001", requirement: true, text: "Must create an order.", cites: [{ file: "api/src/orders.ts", start: 2, end: 2 }] }] }],
    screens: [{ id: "guest-app", name: "Guest screens", pages: ["web/src/pages/order.tsx"], urls: { "web/src/pages/order.tsx": "/t/:table" }, files: ["web/src/pages/order.tsx", "web/src/pages/order/CartPanel.tsx"], calls: ["POST /api/orders"], spec_path: "specs/guest-app/spec.md", specs: [] }],
  };
  const md = screenMarkdown(data, data.screens[0], { uncovered: ["web/src/pages/order/CartPanel.tsx"] });
  assert.match(md, /\/t\/:table/);
  assert.match(md, /POST \/api\/orders.*specs\/orders\/spec\.md FR-001/);
  assert.match(md, /specs\/guest-app\/spec\.md/);
  assert.match(md, /Not described by any spec yet[\s\S]*CartPanel\.tsx/);
});

// ---- final review fixes ----
test("final: one package for server and frontend still has screen groups, and client timers are not server modules", async () => {
  const { screenGroups } = await import("../core/screens.mjs");
  const { findModules } = await import("../core/modules.mjs");
  const files = {
    "package.json": "{}",
    "src/server/orders.ts": 'router.get("/orders", list);\n\n\n',
    "src/client/App.tsx": 'import { lazy } from "react";\nconst A = lazy(() => import("./pages/admin-orders"));\nconst B = lazy(() => import("./pages/admin-menu"));\nexport default () => (<Switch>\n  <Route path="/admin/orders" component={A} />\n  <Route path="/admin/menu" component={B} />\n</Switch>);\n',
    "src/client/pages/admin-orders.tsx": 'export default function A() { return <div />; }\n',
    "src/client/pages/admin-menu.tsx": 'export default function B() { return <div />; }\n',
    "src/client/hooks/usePolling.ts": "export function usePolling() {\n  setInterval(poll, 5000);\n}\n",
  };
  const { g, done } = fakeRepo(files);
  const routes = [{ id: "GET /api/orders", method: "GET", path: "/api/orders", file: "src/server/orders.ts", start: 1, end: 3 }];
  const gs = screenGroups(g.repo, { all: Object.keys(files), routes, specs: [] });
  assert.deepEqual(gs.map((x) => x.id), ["admin-app"]);
  const ms = findModules(g, { routes });
  assert.ok(!ms.some((m) => m.entries.some((e) => e.file.startsWith("src/client/"))), "a client hook's timer is not a server entry point");
  done();
});

test("final: Next.js app router pages and relative router paths form screen groups", async () => {
  const { screenGroups } = await import("../core/screens.mjs");
  const files = {
    "web/package.json": "{}",
    "web/app/page.tsx": "export default function Home() { return <div />; }\n",
    "web/app/admin/orders/page.tsx": "export default function Orders() { return <div />; }\n",
    "web/app/admin/menu/page.tsx": "export default function Menu() { return <div />; }\n",
    "spa/package.json": "{}",
    "spa/src/router.tsx": 'import Bills from "./screens/Bills";\nimport Plans from "./screens/Plans";\nexport const r = (<Routes><Route path="billing/bills" element={<Bills />} /><Route path="billing/plans" element={<Plans />} /></Routes>);\n',
    "spa/src/screens/Bills.tsx": "export default function Bills() { return <div />; }\n",
    "spa/src/screens/Plans.tsx": "export default function Plans() { return <div />; }\n",
  };
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-next-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  const gs = screenGroups(repo, { all: Object.keys(files), routes: [], specs: [] });
  const admin = gs.find((x) => x.id === "admin-app");
  assert.ok(admin && admin.pages.includes("web/app/admin/orders/page.tsx"), JSON.stringify(gs.map((x) => [x.id, x.pages])));
  assert.equal(admin.urls["web/app/admin/orders/page.tsx"], "/admin/orders");
  assert.ok(gs.some((x) => x.id === "billing-app" && x.pages.includes("spa/src/screens/Bills.tsx")));
  fs.rmSync(repo, { recursive: true, force: true });
});

test("final: helper routes resolve same-file constants, keep a mount without values, never rewrite their own params, and don't repeat", () => {
  const { g, done } = fakeRepo({
    "src/main.ts": 'import express from "express";\nimport admin from "./admin";\nimport owner from "./owner";\nimport labels from "./labels";\nconst app = express();\napp.use("/api", admin);\napp.use("/api/o", owner);\napp.use("/api", labels);\napp.listen(3000);\n',
    "src/jobRoutes.ts": 'export function mountJobRoutes(router, { base }) {\n  router.get(`${base}/stream`, stream);\n}\n',
    "src/admin.ts": 'import { Router } from "express";\nimport { mountJobRoutes } from "./jobRoutes";\nconst BASE = "/admin/jobs";\nconst router = Router();\nmountJobRoutes(router, { base: BASE });\nexport default router;\n',
    "src/owner.ts": 'import { Router } from "express";\nimport { mountJobRoutes } from "./jobRoutes";\nconst router = Router();\nmountJobRoutes(router);\nexport default router;\n',
    "src/labelRoutes.ts": 'export function mountLabels(router, label) {\n  router.get("/labels/:label", show);\n}\n',
    "src/labels.ts": 'import { Router } from "express";\nimport { mountLabels } from "./labelRoutes";\nconst router = Router();\nmountLabels(router, "admin");\nmountLabels(router, "owner");\nexport default router;\n',
  });
  const got = ids(g);
  assert.ok(got.includes("GET /api/admin/jobs/stream"), got.join(", "));
  assert.ok(got.some((x) => x.startsWith("GET /api/o/") && x.endsWith("/stream")), "the mount without values keeps its routes: " + got.join(", "));
  assert.ok(got.includes("GET /api/labels/:label"), "a route's own param is not rewritten: " + got.join(", "));
  assert.equal(got.filter((x) => x === "GET /api/labels/:label").length, 1, "no duplicate route");
  done();
});

test("ui: screens link to routes through generated clients, API objects and wrappers; in-app links don't count", async () => {
  const { linkUi } = await import("../core/ui.mjs");
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-ui-"));
  const files = {
    "server/package.json": "{}",
    "server/orders.js": "router.get('/api/orders', list);",
    "web/package.json": "{}",
    "web/src/api.ts": "export const getOrdersUrl = () => `/api/orders`;\nexport const listOrders = () => fetch(getOrdersUrl());\nexport const useListOrders = () => useQuery(listOrders);\n",
    "web/src/models/admin.js": "const Admin = {\n  users: async () => fetch(`${API_BASE}/users/all`),\n  invites: async () => fetch(`${API_BASE}/invites`),\n};\nexport default Admin;\n",
    "web/src/pages/Orders.tsx": "import { useListOrders } from '../api';\nexport default function Orders() { useListOrders(); return null; }\n",
    "web/src/pages/Users.jsx": "import Admin from '../models/admin';\nexport default function Users() { Admin.users(); return null; }\n",
    "web/src/pages/Menu.tsx": "const adminApi = (p) => fetch(`/api/admin${p}`);\nexport default function Menu() { adminApi('/menu/items'); return null; }\n",
    "web/src/pages/Pricing.tsx": "export default function Pricing() { return <Link href=\"/admin/menu/items\">Menu</Link>; }\nconst next = role ? '/owner' : '/admin/menu/items';\n",
    "web/src/pages/Invites.tsx": "export default function Invites() { return <a href=\"/api/invites\" download>Export</a>; }\n",
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const routes = [
    { id: "GET /api/orders", path: "/api/orders", file: "server/orders.js" },
    { id: "GET /api/users/all", path: "/api/users/all", file: "server/orders.js" },
    { id: "GET /api/invites", path: "/api/invites", file: "server/orders.js" },
    { id: "GET /api/admin/menu/items", path: "/api/admin/menu/items", file: "server/orders.js" },
    { id: "ALL /*", path: "/*", file: "server/orders.js" },
  ];
  const mod = (id, rs) => ({ id, routes: rs, files: ["server/orders.js"], code: [], shared: [] });
  const ui = linkUi(repo, routes, [mod("orders", ["GET /api/orders"]), mod("users", ["GET /api/users/all", "GET /api/invites"]), mod("menu", ["GET /api/admin/menu/items"])]);
  const of = (f) => ui.files.find((x) => x.file === f);
  assert.deepEqual(of("web/src/pages/Orders.tsx")?.routes, ["GET /api/orders"], "a hook from a generated client");
  assert.equal(of("web/src/pages/Orders.tsx")?.module, "orders");
  assert.deepEqual(of("web/src/pages/Users.jsx")?.routes, ["GET /api/users/all"], "one method of an API object, not all of them");
  assert.deepEqual(of("web/src/pages/Menu.tsx")?.routes, ["GET /api/admin/menu/items"], "a wrapper that adds /api/admin");
  assert.equal(of("web/src/pages/Pricing.tsx"), undefined, "links to the UI's own pages aren't API calls");
  assert.deepEqual(of("web/src/pages/Invites.tsx")?.routes, ["GET /api/invites"], "a link into the API (a download) is a call");
  assert.ok(!ui.files.some((x) => x.routes.includes("ALL /*")), "a catch-all matches nothing");
  assert.ok(!ui.files.some((x) => x.file.startsWith("server/")), "backend files aren't screens");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("data: tables from each kind of schema, and which module owns each", async () => {
  const { findTables, routeData, dataByModule } = await import("../core/data.mjs");
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-data-"));
  const files = {
    "db/schema.ts": 'export const ordersTable = pgTable(\n  "orders", { id: serial("id") });\nexport const menuItemsTable = pgTable("menu_items", {});\n',
    "models/user.js": 'const UserSchema = new mongoose.Schema({});\nmodule.exports = mongoose.model("User", UserSchema);\n',
    "models/basket.ts": "class Basket extends Model {}\nBasket.init({}, { tableName: 'Baskets', sequelize });\nexport { Basket as BasketModel }\n",
    "prisma/schema.prisma": "model Article {\n  id Int @id\n  @@map(\"articles\")\n}\n",
    "migrations/001.sql": "CREATE TABLE IF NOT EXISTS audit_log (id int);\n",
    "routes/orders.ts": [
      "const a = await db.insert(ordersTable).values(x);",
      "const b = await db.select().from(ordersTable).innerJoin(menuItemsTable, on);",
      "await db.delete(menuItemsTable).where(eq(menuItemsTable.id, id));",
      "const u = await User.findByIdAndDelete(id);",
      "const k = await BasketModel.findOne({ where: { id } });",
      "await prisma.article.update({ where: { id } });",
      'await knex("audit_log").insert(row);',
      'const s = await sql`SELECT * FROM audit_log`;',
      "// await db.delete(ordersTable)",
      "const t = new User(body);",
      "await db.update(menuItemsTable).set(v);",
    ].join("\n"),
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const tables = findTables(repo);
  assert.deepEqual(tables.map((t) => t.name).sort(), ["Baskets", "User", "articles", "audit_log", "menu_items", "orders"]);
  const text = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  const g = { repo, text, lines: (f) => text(f).split("\n"), usesInRange: () => [] };
  const line = (n) => ({ id: `R${n}`, file: "routes/orders.ts", start: n, end: n });
  const uses = routeData(g, Array.from({ length: 11 }, (_, i) => line(i + 1)), tables);
  const at = (n) => uses.get(`R${n}`).map((u) => `${u.op}:${u.table}`).sort();
  assert.deepEqual(at(1), ["write:orders"], "drizzle insert");
  assert.deepEqual(at(2), ["read:menu_items", "read:orders"], "select and join");
  assert.deepEqual(at(3), ["delete:menu_items"], "delete; a column in the where clause isn't a read");
  assert.deepEqual(at(4), ["delete:User"], "mongoose: findByIdAndDelete deletes");
  assert.deepEqual(at(5), ["read:Baskets"], "sequelize model exported under another name");
  assert.deepEqual(at(6), ["write:articles"], "prisma accessor, mapped table name");
  assert.deepEqual(at(7), ["write:audit_log"], "knex");
  assert.deepEqual(at(8), ["read:audit_log"], "raw SQL");
  assert.deepEqual(at(9), [], "comments ignored");
  assert.deepEqual(at(10), ["write:User"], "new Model(…) is a write");

  // Ownership: the module that writes a table most owns it; a module named after a table owns it if it writes it.
  const mods = [
    { id: "orders", name: "Orders", routes: ["R1", "R2"] },
    { id: "menu", name: "Menu", routes: ["R3", "R11"] },
    { id: "kitchen", name: "Kitchen", routes: ["R2"] },
  ];
  const d = dataByModule(mods, uses, tables);
  assert.deepEqual(d.byModule.get("orders").owns.map((r) => r.table), ["orders"]);
  assert.deepEqual(d.byModule.get("menu").owns.map((r) => r.table), ["menu_items"]);
  assert.deepEqual(d.byModule.get("orders").uses.map((r) => [r.table, r.owner]), [["menu_items", "menu"]]);
  assert.deepEqual(d.byModule.get("kitchen").owns, []);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("modules: the list and one module's context for an agent", async () => {
  const { moduleList, moduleMarkdown, findModule } = await import("../core/modulectx.mjs");
  const m = { id: "orders", name: "Orders", does: ["create order"], stats: { routes: 1, high: 1, medium: 0, money: 1 }, tests: { untested: ["POST /orders"], files: [] }, specs: [], specified: 0, files: ["src/orders.ts"], code: [], shared: [], usedBy: [], uses: [], screens: [], data: { owns: [{ table: "orders", at: "db.ts:3", reads: 0, writes: 1, deletes: 0, alsoWrittenBy: [] }], uses: [] } };
  const data = { name: "shop", modules: [m], routes: [{ id: "POST /orders", module: "orders", effect: "write", moves_money: true, access: "public", scoped: "no", handler: "src/orders.ts:1-9", tables: [{ table: "orders", op: "write" }] }], specs: [], findings: [{ module: "orders", severity: "high", title: "Acts on any record by ID", where: "POST /orders", text: "no owner check" }] };
  assert.equal(findModule([m], "ORDERS"), m);
  assert.equal(moduleList(data)[0].spec_path, "specs/orders/spec.md");
  const md = moduleMarkdown(data, m);
  assert.match(md, /`POST \/orders`: changes data, moves money; callable by anyone; tables: write orders; \*\*no test\*\*/);
  assert.match(md, /owns `orders`/);
  assert.match(md, /never as MUST requirements/);
  assert.match(md, /Acts on any record by ID/);
});

test("specs: a requirement written as a heading is a requirement, and its citations carry their lines", async () => {
  const { parseSpec } = await import("../core/citations.mjs");
  const p = parseSpec("# Auth\n\n### FR-1: Registration creates a user\nIt MUST create one. [evidence: src/auth.ts:14-21]\n\n## Notes\nSee [evidence: src/x.ts:3]\n");
  assert.deepEqual(p.citations.map((c) => [c.fr, c.start, c.end]), [["FR-1", 14, 21], ["Notes (line 7)", 3, 3]]);
});

test("routes: a route declared inside a test file isn't one of the app's routes", async () => {
  const { makeRepo } = await import("./fixture.mjs");
  const { openGraph } = await import("../core/graph.mjs");
  const { routeInventory } = await import("../core/routes.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const repo = makeRepo();
  // A test that mounts a throwaway route on an app it's handed (the shape the fallback picks up).
  const f = "src/routes/helpers.test.js";
  fs.writeFileSync(path.join(repo, f), 'module.exports = function (app) {\n  app.get("/fake", (req, res) => res.send("x"));\n};\n');
  const db = new DatabaseSync(path.join(repo, ".codegraph", "codegraph.db"));
  db.prepare("insert into files values (?)").run(f);
  db.prepare("insert into nodes values (?, ?, ?, ?, ?, ?)").run("route:fake", "route", "GET /fake", f, 2, 2);
  db.close();
  const inv = routeInventory(openGraph(repo), { entry: "src/app.ts" });
  assert.ok(inv.routes.length > 0, "the app's own routes are still found");
  assert.ok(!inv.routes.some((r) => r.file === f), "no route from a test file");
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---- rules to tests (specs/rules-to-tests/spec.md) ----
// A small repo: one source file, a spec citing it, and a test file importing it.
async function rulesRepo(testSrc, specExtra = "") {
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-rules-"));
  const files = {
    "src/a.js": "export function a(x) {\n  return x + 1;\n}\n",
    "specs/orders/spec.md": "- **FR-001**: a adds one. [evidence: src/a.js:1-3]\n- **FR-002**: a never returns its input. [evidence: src/a.js:1-3]\n- **FR-003**: a is pure. [evidence: src/a.js:1-3]\n" + specExtra,
    "test/a.test.js": testSrc,
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

test("FR-001: it.fails and test.failing are found and marked as expected failures", async () => {
  const { findTaggedTests } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { a } from "../src/a.js";\nit.fails("FR-001: a adds two", () => { expect(a(1)).toBe(3); });\ntest.failing("FR-002: a returns its input", () => { expect(a(1)).toBe(1); });\nit("FR-003: a is pure", () => { expect(a(1)).toBe(2); });\n');
  const t = findTaggedTests(repo, ["test/a.test.js"]);
  assert.deepEqual(t.map((x) => [x.id, x.expectFail]), [["FR-001", true], ["FR-002", true], ["FR-003", false]]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-002: a rule proven only by expected-failure tests is broken; a normal named test makes it covered", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { a } from "../src/a.js";\nit.fails("FR-001: a adds two", () => { expect(a(1)).toBe(3); });\nit.fails("FR-002: wrong", () => { expect(a(1)).toBe(3); });\nit("FR-002: a never returns its input", () => { expect(a(1)).not.toBe(1); });\n');
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  const cov = testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md") });
  const st = Object.fromEntries(cov.requirements.map((r) => [r.id, r.status]));
  assert.equal(cov.summary.broken, 1);
  assert.equal(st["FR-001"], "broken");
  assert.equal(st["FR-002"], "covered");
  assert.equal(st["FR-003"], "none");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-003: a title qualified with another module doesn't count for this one", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { a } from "../src/a.js";\nit("FR-001 (menu): a adds one", () => { expect(a(1)).toBe(2); });\nit("FR-002 (orders): a never returns its input", () => { expect(a(1)).not.toBe(1); });\n');
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  const st = Object.fromEntries(testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md"), module: "orders" }).requirements.map((r) => [r.id, r.status]));
  assert.equal(st["FR-001"], "none", "qualified for menu");
  assert.equal(st["FR-002"], "covered", "qualified for orders");
  fs.rmSync(repo, { recursive: true, force: true });
});

// A repo with three packages: vitest with a shared test helper, jest with HTTP tests, and none.
async function recipeRepo() {
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-recipe-"));
  const files = {
    "api/package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    "api/vitest.config.ts": 'export default { test: { setupFiles: ["./test/setup.ts"] } };\n',
    "api/test/setup.ts": "process.env.TZ = 'UTC';\n",
    "api/src/x.ts": "export const x = 1;\n",
    "api/src/y.ts": "export const y = 2;\n",
    "api/src/testkit/db.ts": "/**\n * A fake database for unit tests: queue results, inspect writes.\n */\nexport function fakeDb() { return {}; }\n",
    "api/src/x.test.ts": 'import { x } from "./x";\nimport { fakeDb } from "./testkit/db";\nit("x", () => { expect(x).toBe(1); });\n',
    "api/src/y.test.ts": 'import { y } from "./y";\nimport { fakeDb } from "./testkit/db";\nit("y", () => { expect(y).toBe(2); });\n',
    "web/package.json": JSON.stringify({ devDependencies: { jest: "29", supertest: "6" } }),
    "web/src/app.js": "module.exports = {};\n",
    "web/__tests__/app.test.js": 'const request = require("supertest");\nconst app = require("../src/app");\ntest("ok", async () => { await request(app).get("/").expect(200); });\n',
    "none/package.json": JSON.stringify({ name: "none" }),
    "none/src/z.js": "module.exports = 1;\n",
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return { repo, files: Object.keys(files) };
}

test("FR-004: the recipe names each package's framework and the command to run one test file", async () => {
  const { testRecipe } = await import("../core/recipe.mjs");
  const { repo, files } = await recipeRepo();
  const r = testRecipe(repo, files);
  assert.equal(r.get("api").framework, "vitest");
  assert.equal(r.get("api").run, "npx vitest run <file>");
  assert.equal(r.get("web").framework, "jest");
  assert.equal(r.get("web").run, "npx jest <file>");
  assert.equal(r.get("none").framework, null);
  assert.equal(r.get("none").run, null);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-005: the recipe reports where most of a package's tests live", async () => {
  const { testRecipe } = await import("../core/recipe.mjs");
  const { repo, files } = await recipeRepo();
  const r = testRecipe(repo, files);
  assert.equal(r.get("api").layout, "colocated");
  assert.equal(r.get("web").layout, "__tests__");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-006: the recipe lists setup files and shared helpers with their leading comment", async () => {
  const { testRecipe } = await import("../core/recipe.mjs");
  const { repo, files } = await recipeRepo();
  const api = testRecipe(repo, files).get("api");
  assert.deepEqual(api.setup, ["api/test/setup.ts"]);
  assert.deepEqual(api.helpers.map((h) => h.file), ["api/src/testkit/db.ts"]);
  assert.match(api.helpers[0].note, /fake database for unit tests/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-007: the recipe says HTTP or direct, gives the marker, and names a test to copy for a cited file", async () => {
  const { testRecipe, exampleTest } = await import("../core/recipe.mjs");
  const { repo, files } = await recipeRepo();
  const r = testRecipe(repo, files);
  assert.equal(r.get("api").style, "direct");
  assert.equal(r.get("web").style, "http");
  assert.equal(r.get("api").marker, "it.fails");
  assert.equal(r.get("web").marker, "test.failing");
  assert.equal(exampleTest(repo, r.get("api"), "api/src/x.ts"), "api/src/x.test.ts");
  assert.equal(exampleTest(repo, r.get("web"), "web/src/app.js"), "web/__tests__/app.test.js");
  fs.rmSync(repo, { recursive: true, force: true });
});

// A module "orders" with its own spec, a payments route that moves money, existing tests.
async function workRepo() {
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-work-"));
  const files = {
    "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    "src/pay.js": "export function pay(order) {\n  return { paid: true, id: order.id };\n}\n",
    "src/list.js": "export function list() {\n  return [];\n}\n",
    "specs/orders/spec.md": [
      "- **FR-001**: Listing returns an array. [evidence: src/list.js:1-3]",
      "- **FR-002**: Paying marks the order paid. [evidence: src/pay.js:1-3]",
      "- **INV-1**: An order is paid at most once. [evidence: src/pay.js:1-3]",
      "- **FR-003**: Orders are kept for a year.",
      "",
    ].join("\n"),
    "specs/menu/spec.md": "- **FR-002**: The menu lists items. [evidence: src/pay.js:1-3]\n",
    "src/pay.test.js": 'import { pay } from "./pay";\nit("pays an order", () => { expect(pay({ id: 1 }).paid).toBe(true); });\nit("FR-001: lists", () => { expect(1).toBe(1); });\n',
    "src/list.test.js": 'import { list } from "./list";\nit("FR-001: listing returns an array", () => { expect(list()).toEqual([]); });\n',
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const data = {
    modules: [
      { id: "orders", name: "Orders", specs: ["specs/orders/spec.md", "specs/menu/spec.md"], routes: ["POST /pay", "GET /orders"] },
      { id: "menu", name: "Menu", specs: ["specs/menu/spec.md"], routes: [] },
      { id: "tables", name: "Tables", specs: ["specs/orders/spec.md"], routes: [] },
      { id: "voice", name: "Voice", specs: [], routes: [] },
    ],
    routes: [
      { id: "POST /pay", module: "orders", moves_money: true, effect: "write", handler: "src/pay.js:1-3" },
      { id: "GET /orders", module: "orders", moves_money: false, effect: "read", handler: "src/list.js:1-3" },
    ],
  };
  return { repo, data };
}

test("FR-008: the work list gives each rule one status, money and invariants first", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo();
  const wl = await workList(repo, "orders", { data });
  assert.deepEqual(wl.specs, ["specs/orders/spec.md"], "only the module's own spec");
  assert.deepEqual(wl.rules.map((r) => [r.id, r.status, r.risk]), [["FR-002", "untested", 0], ["INV-1", "untested", 0], ["FR-001", "tested", 2], ["FR-003", "untested", 2]]);
  assert.equal(wl.totals.tested, 1);
  assert.equal(wl.totals.untested, 3);
  assert.equal(wl.rules.find((r) => r.id === "FR-003").reason, "no cited code");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-009: link candidates are existing asserting tests that reach the cited code and aren't named for the rule", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo();
  const wl = await workList(repo, "orders", { data });
  const fr2 = wl.rules.find((r) => r.id === "FR-002");
  assert.deepEqual(fr2.candidates.map((c) => c.title), ["pays an order"]);
  assert.equal(fr2.target, "src/pay.test.js");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-010: an id another spec also uses, with a test reaching both, is ambiguous", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo();
  const wl = await workList(repo, "orders", { data });
  assert.equal(wl.rules.find((r) => r.id === "FR-002").ambiguous, true);
  assert.equal(wl.rules.find((r) => r.id === "FR-001").ambiguous, false);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-014: unknown modules and modules without a spec of their own are explained", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo();
  const unknown = await workList(repo, "nope", { data });
  assert.match(unknown.error, /no part "nope"/);
  assert.deepEqual(unknown.modules, ["orders", "menu", "tables", "voice"]);
  const tables = await workList(repo, "tables", { data });
  assert.match(tables.error, /no spec of its own/);
  assert.match(tables.error, /Orders/);
  const voice = await workList(repo, "voice", { data });
  assert.match(voice.error, /\/veridic:specs voice/);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-011: --run runs node:test files and records pass or fail per named test", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { test } from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/a.js";\ntest("FR-001: a adds one", () => { assert.equal(a(1), 2); });\ntest("FR-002: a never returns its input", () => { assert.equal(a(1), 1); });\n');
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  const st = Object.fromEntries(testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md"), run: true }).requirements.map((r) => [r.id, r.status]));
  assert.equal(st["FR-001"], "passing");
  assert.equal(st["FR-002"], "failing");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-012: a test runner that can't start is reported, and its rules aren't called failing", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('const { a } = require("../src/a.js");\ntest("FR-001: a adds one", () => { expect(a(1)).toBe(2); });\n');
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ devDependencies: { jest: "29" } })); // declared, not installed
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  const cov = testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md"), run: true });
  assert.equal(cov.requirements.find((r) => r.id === "FR-001").status, "covered");
  assert.ok(cov.errors?.length >= 1, "the runner failure is reported");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-013: the module work list prints its totals and ends with the next command", async () => {
  const { workList, workListMarkdown } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo();
  const md = workListMarkdown(await workList(repo, "orders", { data }));
  assert.match(md, /^Totals: 4 rules · 1 tested · 0 broken · 0 failing · 0 weak · 3 untested$/m);
  assert.match(md.trim().split("\n").pop(), /^Next: veridic tests --module orders --run$/);
  assert.match(md, /^Next: \/veridic:tests orders \(2 to link, 1 to write\)$/m);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-015: the report names a broken rule 'broken, proven'", async () => {
  const vm = await import("node:vm");
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8"), ctx);
  const m = ctx.veridicModel({ name: "x", routes: [], modules: [], findings: [], specs: [{ path: "specs/a/spec.md", requirements: [{ id: "FR-001", requirement: true, status: "broken", text: "A must hold." }] }] });
  assert.equal(m.statusOf({ status: "broken" }).label, "Broken, proven");
  assert.equal(m.statusOf({ status: "broken" }).tone, "bad");
  assert.match(m.fix[0].w, /^Broken, proven/);
});

// ---- final review fixes ----
test("FR-012: under --run, a work-list rule whose runner couldn't start is 'not run', and the error is shown", async () => {
  const { workList, workListMarkdown } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo(); // declares vitest, doesn't install it
  const wl = await workList(repo, "orders", { data, run: true });
  assert.equal(wl.rules.find((r) => r.id === "FR-001").status, "not run");
  assert.ok(wl.errors.length >= 1);
  assert.match(workListMarkdown(wl), /^Could not run: /m);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-002: an expected-failure test that now fails means the code satisfies the rule: not broken", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { a } from "../src/a.js";\nit.fails("FR-001: a adds one", () => { expect(a(1)).toBe(2); });\n');
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  const runner = (_repo, files) => ({ results: new Map(files.map((f) => [`${f}\0FR-001: a adds one`, "failed"])), errors: [] });
  const r = testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md"), run: true, runner }).requirements.find((x) => x.id === "FR-001");
  assert.equal(r.status, "marker_stale");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-004: a workspace package without its own test framework uses the one the root installs", async () => {
  const { testRecipe } = await import("../core/recipe.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-mono-"));
  const files = { "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }), "packages/a/package.json": JSON.stringify({ name: "a" }), "packages/a/src/x.ts": "export const x = 1;\n", "packages/a/src/x.test.ts": 'import { it, expect } from "vitest";\nimport { x } from "./x";\nit("x", () => { expect(x).toBe(1); });\n' };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  assert.equal(testRecipe(repo, Object.keys(files)).get("packages/a").framework, "vitest");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-011: a node:test title with # in it still gets its result", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { test } from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/a.js";\ntest("FR-001: a adds one # really", () => { assert.equal(a(1), 2); });\n');
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  assert.equal(testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md"), run: true }).requirements.find((r) => r.id === "FR-001").status, "passing");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-003: a title qualified for one module never counts for another module's spec, in any view", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { a } from "../src/a.js";\nit("FR-001 (orders): a adds one", () => { expect(a(1)).toBe(2); });\n');
  fs.mkdirSync(path.join(repo, "specs/payments"), { recursive: true });
  fs.writeFileSync(path.join(repo, "specs/payments/spec.md"), "- **FR-001**: a adds one. [evidence: src/a.js:1-3]\n");
  const st = (p) => testCoverage(repo, fs.readFileSync(path.join(repo, p), "utf8"), { specPath: path.join(repo, p) }).requirements.find((r) => r.id === "FR-001").status;
  assert.equal(st("specs/orders/spec.md"), "covered");
  assert.equal(st("specs/payments/spec.md"), "none");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-011: run results are matched to test files even when the repo path goes through a symlink", async () => {
  const { relKey } = await import("../core/tests.mjs");
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-real-"));
  const link = real + "-link";
  fs.symlinkSync(real, link);
  fs.mkdirSync(path.join(real, "test"));
  fs.writeFileSync(path.join(real, "test/a.test.js"), "");
  // A runner reports the real path; the repo was given through the link.
  assert.equal(relKey(link, path.join(fs.realpathSync(real), "test/a.test.js")), "test/a.test.js");
  fs.rmSync(link);
  fs.rmSync(real, { recursive: true, force: true });
});

test("FR-016: test mutation changes a tested rule's cited code and counts the rules whose tests notice", async () => {
  const { testMutation } = await import("../core/testmut.mjs");
  const repo = await rulesRepo('import { test } from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/a.js";\ntest("FR-001: a adds one", () => { assert.equal(a(1), 2); });\ntest("FR-002: a returns a number", () => { assert.equal(typeof a(1), "number"); });\n');
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const before = fs.readFileSync(path.join(repo, "src/a.js"), "utf8");
  const rules = [
    { id: "FR-001", status: "tested", cites: ["src/a.js:1-3"], tests: ["test/a.test.js"] },
    { id: "FR-002", status: "tested", cites: ["src/a.js:1-3"], tests: ["test/a.test.js"] },
  ];
  const r = testMutation(repo, rules, 2);
  assert.deepEqual(r.rules.map((x) => [x.id, x.caught]), [["FR-001", true], ["FR-002", false]], "a(1) returns 3: FR-001's test fails; FR-002's still passes");
  assert.equal(r.caught, 1);
  assert.equal(fs.readFileSync(path.join(repo, "src/a.js"), "utf8"), before, "the code is restored");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("FR-004: a package that runs node --test is node:test, even if a test mentions vitest in a string", async () => {
  const { testRecipe } = await import("../core/recipe.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-nt-"));
  const files = { "package.json": JSON.stringify({ scripts: { test: "node --test test/" } }), "test/a.test.mjs": 'import { test } from "node:test";\nconst fixture = \'import { it } from "vitest";\';\ntest("a", () => {});\n' };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  assert.equal(testRecipe(repo, Object.keys(files)).get(".").framework, "node:test");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a *spec.md file without any rule id (a command or a doc) isn't a spec", async () => {
  const { defaultSpecs } = await import("../core/metrics.mjs");
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-specs-"));
  const files = { "commands/spec.md": "---\ndescription: write a spec\n---\nRun veridic prepare.\n", "specs/a/spec.md": "- **FR-001**: a. [evidence: x.js:1]\n", "docs/heading-spec.md": "### FR-1: Title\nText.\n" };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  assert.deepEqual(defaultSpecs(repo).map((f) => path.relative(repo, f)).sort(), ["docs/heading-spec.md", "specs/a/spec.md"]);
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the app's title and about come from the README's words, not its markdown (an image heading, a blockquoted heading)", async () => {
  const { appOverview } = await import("../core/report.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-about-"));
  fs.writeFileSync(path.join(repo, "README.md"), "# ![Node/Express/Prisma Example App](project-logo.png)\n\n> ### Example Node (Express + Prisma) codebase containing real world examples (CRUD, auth)\n\n## Getting Started\n\nRun the following command to install dependencies, then start the server.\n");
  const app = appOverview(repo);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(app.title, "Node/Express/Prisma Example App");
  assert.match(app.about, /^Example Node \(Express \+ Prisma\) codebase containing/);
});

// --link: the agent decides which existing tests check a rule; Veridic edits the titles in one call.
function linkRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-link-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  return repo;
}
const AUTH_TEST = [
  'import { register } from "./auth";',
  "describe('register', () => {",
  "  test('should throw when the username is empty', () => { expect(() => register({})).toThrow(); });",
  '  it("FR-002: rejects an empty email", () => { expect(() => register({ username: "a" })).toThrow(); });',
  "  it(`hashes the password`, async () => { expect(await register({ username: 'a', email: 'b' })).not.toBe('x'); });",
  "});",
  "",
].join("\n");

test("FR-017: linkTests puts the rule id at the front of the title on the given line, and nothing else changes", async () => {
  const { linkTests } = await import("../core/link.mjs");
  const repo = linkRepo({ "src/auth.test.ts": AUTH_TEST });
  const r = linkTests(repo, [{ id: "FR-001", at: "src/auth.test.ts:3" }, { id: "FR-009", at: "src/auth.test.ts:5" }]);
  const after = fs.readFileSync(path.join(repo, "src/auth.test.ts"), "utf8").split("\n");
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(r.linked.map((l) => l.title), ["FR-001: should throw when the username is empty", "FR-009: hashes the password"]);
  assert.equal(after[2], "  test('FR-001: should throw when the username is empty', () => { expect(() => register({})).toThrow(); });");
  assert.equal(after[4], "  it(`FR-009: hashes the password`, async () => { expect(await register({ username: 'a', email: 'b' })).not.toBe('x'); });");
  assert.deepEqual(after.filter((_, i) => i !== 2 && i !== 4), AUTH_TEST.split("\n").filter((_, i) => i !== 2 && i !== 4));
});

test("FR-017: linkTests adds a second id to an already-named test, qualifies ambiguous ids, and both are found as tagged", async () => {
  const { linkTests } = await import("../core/link.mjs");
  const { findTaggedTests } = await import("../core/tests.mjs");
  const repo = linkRepo({ "src/auth.test.ts": AUTH_TEST });
  linkTests(repo, [{ id: "FR-006", at: "src/auth.test.ts:4" }, { id: "FR-003", at: "src/auth.test.ts:3" }], { module: "auth", qualify: new Set(["FR-003"]) });
  const lines = fs.readFileSync(path.join(repo, "src/auth.test.ts"), "utf8").split("\n");
  const tagged = findTaggedTests(repo, ["src/auth.test.ts"]);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.match(lines[3], /it\("FR-002, FR-006: rejects an empty email"/);
  assert.match(lines[2], /test\('FR-003 \(auth\): should throw when the username is empty'/);
  assert.deepEqual(tagged.map((t) => [t.id, t.line, t.qual]).sort(), [["FR-002", 4, null], ["FR-003", 3, "auth"], ["FR-006", 4, null]]);
});

test("FR-017: linkTests refuses what isn't a test title in a test file, and leaves those files alone", async () => {
  const { linkTests } = await import("../core/link.mjs");
  const src = "export const x = 1;\n";
  const repo = linkRepo({ "src/auth.test.ts": AUTH_TEST, "src/auth.ts": src });
  const r = linkTests(repo, [
    { id: "FR-001", at: "src/auth.ts:1" },
    { id: "FR-001", at: "src/auth.test.ts:2" },
    { id: "FR-002", at: "src/auth.test.ts:4" },
    { id: "FR-001", at: "src/missing.test.ts:1" },
  ]);
  const after = fs.readFileSync(path.join(repo, "src/auth.test.ts"), "utf8");
  const appAfter = fs.readFileSync(path.join(repo, "src/auth.ts"), "utf8");
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(r.linked.length, 0);
  assert.deepEqual(r.skipped.map((s) => s.reason), ["not a test file", "describe block, not a test", "already named FR-002", "no such file"]);
  assert.equal(after, AUTH_TEST);
  assert.equal(appAfter, src);
});

test("FR-017: linkForModule parses ID=file:line[,line] pairs and qualifies ids the module shares with another spec", async () => {
  const { linkForModule, linkMarkdown } = await import("../core/link.mjs");
  const { repo, data } = await workRepo();
  const r = await linkForModule(repo, "orders", ["FR-002=src/pay.test.js:2", "INV-1=src/pay.test.js:2", "FR-001"], { data });
  const line = fs.readFileSync(path.join(repo, "src/pay.test.js"), "utf8").split("\n")[1];
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(line, 'it("FR-002 (orders), INV-1: pays an order", () => { expect(pay({ id: 1 }).paid).toBe(true); });');
  assert.deepEqual(r.skipped.map((x) => [x.id, x.reason]), [["FR-001", "expected ID=file:line"]]);
  assert.match(linkMarkdown(r), /^Linked 2 tests\b/);
});

test("FR-018: the work list carries what the agent would otherwise open: full rule text, the cited code of rules still to do, an example test, and the link command", async () => {
  const { workList, workListMarkdown } = await import("../core/worklist.mjs");
  const { repo, data } = await workRepo();
  const long = "Paying marks the order paid and records who paid, when, with which card, and the amount charged in the order's own currency, never converted.";
  const spec = path.join(repo, "specs/orders/spec.md");
  fs.writeFileSync(spec, fs.readFileSync(spec, "utf8").replace("Paying marks the order paid.", long));
  const md = workListMarkdown(await workList(repo, "orders", { data }));
  fs.rmSync(repo, { recursive: true, force: true });
  assert.ok(md.includes(long.replace(/\|/g, "\\|")), "the rule's whole text");
  const code = md.slice(md.indexOf("## Cited code"));
  assert.match(code, /`src\/pay\.js:1-3`\n```\n1 +export function pay\(order\) \{\n2 +  return \{ paid: true, id: order\.id \};\n3 +\}\n```/);
  assert.ok(!code.includes("src/list.js"), "a tested rule's code is left out");
  assert.match(md, /example test: `src\/pay\.test\.js`/);
  assert.match(md, /^Next: veridic tests --module orders --link ID=file:line\[,line\] …$/m);
});

// ---- one spec path per part ----
const partData = (specs) => ({
  name: "shop",
  modules: [{ id: "orders", name: "Orders", files: ["src/orders.ts"], code: [], specs: [], specified: 0, stats: { routes: 1, high: 0, medium: 0, money: 0 }, does: [], tests: { untested: [] }, usedBy: [], data: { owns: [] } }],
  screens: [],
  specs,
});
const specOf = (p, n, file = "src/orders.ts") => ({ path: p, requirements: Array.from({ length: n }, (_, i) => ({ id: `FR-00${i + 1}`, requirement: true, cites: [{ file }] })) });

test("one spec path per part: the main file", async () => {
  const { moduleList } = await import("../core/modulectx.mjs");
  const pathOf = (specs) => moduleList(partData(specs)).find((r) => r.id === "orders").spec_path;
  assert.equal(pathOf([specOf("specs/orders-analytics/spec.md", 3), specOf("specs/orders/spec.md", 2)]), "specs/orders/spec.md", "the file named after the part");
  assert.equal(pathOf([specOf("specs/orders-analytics/spec.md", 3), specOf("specs/orders-payment/spec.md", 5)]), "specs/orders-payment/spec.md", "else the one with the most rules");
  assert.equal(pathOf([]), "specs/orders/spec.md", "else a new file named after the part");
  assert.equal(pathOf([specOf("specs/elsewhere/spec.md", 4, "src/other.ts")]), "specs/orders/spec.md", "a spec citing other code isn't this part's");
});

test("one spec path per part: the same grouping as the dashboard", async () => {
  const { moduleList } = await import("../core/modulectx.mjs");
  const vm = await import("node:vm");
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8"), ctx);
  const d = partData([specOf("specs/orders-analytics/spec.md", 3), specOf("specs/orders-payment/spec.md", 5), specOf("specs/notes/spec.md", 1, "src/x.ts")]);
  const m = ctx.veridicModel({ ...d, routes: [], findings: [] });
  const row = moduleList(d).find((r) => r.id === "orders");
  assert.equal(m.partOf(row.spec_path), "orders");
  assert.deepEqual([...row.part_specs].sort(), [...m.P.get("orders").specs.map((s) => s.path)].sort());
});

// ---- three words: part, spec, rule ----
const OLD_WORDS = /\b(requirements?|modules?|screen groups?)\b/i;
const prose = (s) => String(s).replace(/`[^`]*`/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");

test("people read part, spec and rule", async () => {
  const { partsTable, moduleList } = await import("../core/modulectx.mjs");
  const { coverageMarkdown } = await import("../core/coverage.mjs");
  const { workList, workListMarkdown } = await import("../core/worklist.mjs");
  const vm = await import("node:vm");
  const ctx = {};
  vm.runInNewContext(fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8"), ctx);
  const d = partData([specOf("specs/orders/spec.md", 2), specOf("specs/notes/spec.md", 1, "src/x.ts")]);
  const m = ctx.veridicModel({ ...d, routes: [], findings: [], coverage: { behaviour: 4, covered: 2, pct: 50, parts: [{ id: "orders", name: "Orders", kind: "module", total: 2, covered: 1, uncovered: ["src/b.ts"] }], orphans: ["src/c.ts"] } });
  const said = [m.verdict, ...m.fix.flatMap((c) => [c.html, c.w]), ...m.later.flatMap((c) => [c.html, c.w]), ...m.parts.map((p) => p.health)];
  said.push(coverageMarkdown({ covered: 2, behaviour: 4, pct: 50, parts: [{ id: "orders", name: "Orders", kind: "module", total: 2, covered: 1, uncovered: ["src/b.ts"] }, { id: "guest-app", name: "Guest screens", kind: "screens", total: 1, covered: 1, uncovered: [] }], orphans: ["src/c.ts"], orphanFolders: [{ folder: "src", files: ["src/c.ts"] }], skipped: [{ file: "a.test.ts", reason: "test" }] }));
  const row = { ...moduleList(d)[0], does: [], issues: { high: 0, medium: 0 } };
  said.push(partsTable([row]));
  said.push(workListMarkdown(await workList("/nowhere", "nope", { data: d })));
  for (const s of said) assert.doesNotMatch(prose(s), OLD_WORDS, s.slice(0, 200));
});

// ---- final review fixes (simplify) ----
test("final: the spec file named after a part is that part's, whatever it cites", async () => {
  const { specHomes, partSpec } = await import("../core/parts.mjs");
  const { moduleMarkdown } = await import("../core/modulectx.mjs");
  const d = { modules: [{ id: "orders", files: ["src/orders.ts"], code: [] }, { id: "payments", files: ["src/pay.ts"], code: [] }], screens: [], specs: [specOf("specs/orders/spec.md", 3, "src/pay.ts")] };
  assert.equal(specHomes(d).get("specs/orders/spec.md"), "orders");
  assert.deepEqual(partSpec(d, "orders").specs, ["specs/orders/spec.md"]);
  const m = { id: "orders", name: "Orders", files: ["src/orders.ts"], code: [], shared: [], specs: [], specified: 0, stats: { routes: 0, high: 0, medium: 0, money: 0 }, does: [], tests: { files: [], untested: [] }, usedBy: [], uses: [], data: { owns: [], uses: [] } };
  assert.doesNotMatch(moduleMarkdown({ ...d, name: "x", routes: [], findings: [], modules: [m] }, m), /None yet/);
});

test("final: an uncited spec goes to the part its folder names most exactly", async () => {
  const { specHomes } = await import("../core/parts.mjs");
  const d = { modules: [{ id: "admin", files: [], code: [] }, { id: "orders", files: [], code: [] }], screens: [{ id: "admin-app", files: [] }, { id: "orders-admin", files: [] }], specs: [specOf("specs/admin-app/spec.md", 1, "nowhere.ts"), specOf("specs/orders-admin-v2/spec.md", 1, "nowhere.ts")] };
  const h = specHomes(d);
  assert.equal(h.get("specs/admin-app/spec.md"), "admin-app");
  assert.equal(h.get("specs/orders-admin-v2/spec.md"), "orders-admin");
});

test("final: tests --module uses the same ownership as the dashboard, and explains screen parts", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const d = { name: "x", routes: [], findings: [], screens: [{ id: "guest-app", name: "Guest screens", files: [] }],
    modules: [{ id: "orders", name: "Orders", files: ["src/orders.ts"], code: [], specs: ["specs/orders-payment/spec.md"] }, { id: "payments", name: "Payments", files: ["src/pay.ts"], code: [], specs: ["specs/orders-payment/spec.md"] }],
    specs: [specOf("specs/orders-payment/spec.md", 2, "src/pay.ts")] };
  const orders = await workList("/nowhere", "orders", { data: d });
  assert.match(orders.error, /no spec of its own/);
  assert.match(orders.error, /Payments/);
});

test("final: tests --module works on a screen part too, with its own spec", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-screenwl-"));
  const put = (f, t) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), t); };
  put("package.json", '{"devDependencies":{"vitest":"1.0.0"}}');
  put("web/src/pages/order.tsx", "export default function Order() {\n  return null;\n}\n");
  put("specs/guest-app/spec.md", "- **FR-001**: The order page shows the cart. [evidence: web/src/pages/order.tsx:1-3]\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  const d = { name: "x", routes: [], findings: [], modules: [{ id: "orders", name: "Orders", files: ["api/orders.ts"], code: [], specs: [] }],
    screens: [{ id: "guest-app", name: "Guest screens", files: ["web/src/pages/order.tsx"], specs: ["specs/guest-app/spec.md"] }],
    specs: [{ path: "specs/guest-app/spec.md", requirements: [{ id: "FR-001", requirement: true, text: "The order page shows the cart.", status: "none", cites: [{ file: "web/src/pages/order.tsx", start: 1, end: 3, cite: "web/src/pages/order.tsx:1-3" }], tests: [] }] }] };
  const wl = await workList(repo, "guest-app", { data: d });
  assert.ok(!wl.error, wl.error);
  assert.deepEqual([...wl.specs], ["specs/guest-app/spec.md"]);
  assert.equal(wl.module.name, "Guest screens");
  fs.rmSync(repo, { recursive: true, force: true });
});

// One part, two spec files that reuse the same ids (specs/voice and specs/voice-conversation).
async function sharedIdsRepo() {
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-shared-"));
  const files = {
    "package.json": JSON.stringify({ devDependencies: { vitest: "1" } }),
    "src/v.js": "export function order(x) {\n  return { placed: x > 0 };\n}\nexport function greet() {\n  return 'hi';\n}\n",
    "specs/voice/spec.md": "- **FR-001**: An order is placed for a positive amount. [evidence: src/v.js:1-3]\n",
    "specs/voice-conversation/spec.md": "- **FR-001**: The waiter greets the guest. [evidence: src/v.js:4-6]\n",
    "src/v.test.js": 'import { order, greet } from "./v";\nit("places an order", () => { expect(order(1).placed).toBe(true); });\nit("greets", () => { expect(greet()).toBe("hi"); });\n',
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const data = { modules: [{ id: "voice", name: "Voice", specs: [], routes: [] }], routes: [], specs: [{ path: "specs/voice/spec.md", requirements: [] }, { path: "specs/voice-conversation/spec.md", requirements: [] }] };
  return { repo, data };
}

test("FR-010: ids two spec files of the same part share are ambiguous, and their titles name the spec file", async () => {
  const { workList, workListMarkdown } = await import("../core/worklist.mjs");
  const { repo, data } = await sharedIdsRepo();
  const wl = await workList(repo, "voice", { data });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(wl.specs.sort(), ["specs/voice-conversation/spec.md", "specs/voice/spec.md"]);
  assert.deepEqual(wl.rules.map((r) => [r.spec, r.id, r.ambiguous]).sort(), [["specs/voice-conversation/spec.md", "FR-001", true], ["specs/voice/spec.md", "FR-001", true]]);
  const md = workListMarkdown(wl);
  assert.match(md, /`FR-001 \(voice-conversation\): …`/);
  assert.match(md, /`FR-001 \(voice\): …`/);
});

test("FR-017: a link for an id the part's spec files share names the spec file, and counts only for that file", async () => {
  const { linkForModule } = await import("../core/link.mjs");
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await sharedIdsRepo();
  const r = await linkForModule(repo, "voice", ["FR-001=src/v.test.js:2", "FR-001@voice-conversation=src/v.test.js:3", "FR-001@voice=src/v.test.js:2"], { data });
  const lines = fs.readFileSync(path.join(repo, "src/v.test.js"), "utf8").split("\n");
  const wl = await workList(repo, "voice", { data });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(r.skipped.map((x) => [x.id, x.reason]), [["FR-001", "FR-001 is in 2 of this part's spec files: write FR-001@voice or FR-001@voice-conversation"]]);
  assert.equal(lines[1], 'it("FR-001 (voice): places an order", () => { expect(order(1).placed).toBe(true); });');
  assert.equal(lines[2], 'it("FR-001 (voice-conversation): greets", () => { expect(greet()).toBe("hi"); });');
  const st = Object.fromEntries(wl.rules.map((x) => [x.spec, [x.status, x.tests]]));
  assert.deepEqual(st["specs/voice/spec.md"], ["tested", ["src/v.test.js"]]);
  assert.deepEqual(st["specs/voice-conversation/spec.md"], ["tested", ["src/v.test.js"]]);
});

test("FR-003: a title qualified with one spec file of a part never counts for the part's other spec file", async () => {
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await sharedIdsRepo();
  fs.writeFileSync(path.join(repo, "src/v.test.js"), 'import { order, greet } from "./v";\nit("FR-001 (voice): places an order", () => { expect(order(1).placed).toBe(true); });\nit("greets", () => { expect(greet()).toBe("hi"); });\n');
  const wl = await workList(repo, "voice", { data });
  fs.rmSync(repo, { recursive: true, force: true });
  const st = Object.fromEntries(wl.rules.map((x) => [x.spec, x.status]));
  assert.equal(st["specs/voice/spec.md"], "tested");
  assert.equal(st["specs/voice-conversation/spec.md"], "untested");
});

test("FR-003: a plain tag on a test that runs none of a spec's code is another spec's, not a weak test of this one", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const { repo } = await sharedIdsRepo();
  fs.writeFileSync(path.join(repo, "src/other.js"), "export const x = 1;\n");
  fs.mkdirSync(path.join(repo, "specs/menu"));
  fs.writeFileSync(path.join(repo, "specs/menu/spec.md"), "- **FR-001**: Menu has x. [evidence: src/other.js:1]\n");
  fs.writeFileSync(path.join(repo, "src/v.test.js"), 'import { order } from "./v";\nit("FR-001: places an order", () => { expect(order(1).placed).toBe(true); });\n');
  const spec = path.join(repo, "specs/menu/spec.md");
  const r = testCoverage(repo, fs.readFileSync(spec, "utf8"), { specPath: spec });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(r.requirements[0].status, "none");
  assert.deepEqual(r.requirements[0].tests, []);
});

test("FR-017: an id two of the part's spec files have is always written with its spec file, even when their tests don't overlap", async () => {
  const { linkForModule } = await import("../core/link.mjs");
  const { workList } = await import("../core/worklist.mjs");
  const { repo, data } = await sharedIdsRepo();
  fs.writeFileSync(path.join(repo, "src/a.js"), "export const a = (x) => x + 1;\n");
  fs.writeFileSync(path.join(repo, "src/b.js"), "export const b = () => 'hi';\n");
  fs.writeFileSync(path.join(repo, "specs/voice/spec.md"), "- **FR-001**: a adds one. [evidence: src/a.js:1]\n");
  fs.writeFileSync(path.join(repo, "specs/voice-conversation/spec.md"), "- **FR-001**: b greets. [evidence: src/b.js:1]\n");
  fs.writeFileSync(path.join(repo, "src/a.test.js"), 'import { a } from "./a";\nit("adds one", () => { expect(a(1)).toBe(2); });\n');
  const r = await linkForModule(repo, "voice", ["FR-001@voice=src/a.test.js:2"], { data });
  const line = fs.readFileSync(path.join(repo, "src/a.test.js"), "utf8").split("\n")[1];
  const wl = await workList(repo, "voice", { data });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(r.skipped, []);
  assert.equal(line, 'it("FR-001 (voice): adds one", () => { expect(a(1)).toBe(2); });');
  assert.ok(wl.rules.every((x) => x.ambiguous), "both files' FR-001 are flagged");
});

test("FR-003: a plain tag for an id another spec has counts only if the test runs that rule's own code", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const { repo } = await sharedIdsRepo();
  fs.writeFileSync(path.join(repo, "src/picks.js"), "export const picks = () => [];\n");
  fs.mkdirSync(path.join(repo, "specs/restaurant"));
  // restaurant's FR-001 is about picks.js; its FR-002 cites v.js, which the voice test does run
  fs.writeFileSync(path.join(repo, "specs/restaurant/spec.md"), "- **FR-001**: Picks are private. [evidence: src/picks.js:1]\n- **FR-002**: Orders exist. [evidence: src/v.js:1-3]\n");
  fs.writeFileSync(path.join(repo, "src/v.test.js"), 'import { order } from "./v";\nit("FR-001: places an order", () => { expect(order(1).placed).toBe(true); });\n');
  const spec = path.join(repo, "specs/restaurant/spec.md");
  const r = testCoverage(repo, fs.readFileSync(spec, "utf8"), { specPath: spec });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(r.requirements.find((q) => q.id === "FR-001").status, "none");
});

test("init: counts untested rules that an existing test already runs the code of (link candidates), per spec", async () => {
  const { linkable } = await import("../core/tests.mjs");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-linkable-"));
  const files = {
    "src/pay.js": "export const pay = () => true;\n",
    "src/list.js": "export const list = () => [];\n",
    "src/pay.test.js": 'import { pay } from "./pay";\nit("pays", () => { expect(pay()).toBe(true); });\n',
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  const r = (id, status, file) => ({ id, requirement: true, status, cites: [{ cite: file + ":1", file }] });
  const data = { specs: [{ path: "specs/orders/spec.md", requirements: [r("FR-001", "none", "src/pay.js"), r("FR-002", "covered", "src/pay.js"), r("FR-003", "none", "src/list.js"), { ...r("FR-004", "none", "src/pay.js"), requirement: false }] }] };
  const out = linkable(repo, data, Object.keys(files));
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(out.rules, 1, "FR-001 only: FR-002 is tested, no test runs list.js, FR-004 is not a rule");
  assert.deepEqual(out.bySpec, { "specs/orders/spec.md": 1 });
});

test("init: the parts to offer linking for, most linkable rules first, each once", async () => {
  const { linkableParts } = await import("../core/tests.mjs");
  const homes = new Map([["specs/voice/spec.md", "voice"], ["specs/voice-conversation/spec.md", "voice"], ["specs/orders/spec.md", "orders"], ["specs/misc/spec.md", null]]);
  assert.deepEqual(linkableParts({ "specs/orders/spec.md": 5, "specs/voice/spec.md": 3, "specs/voice-conversation/spec.md": 4, "specs/misc/spec.md": 9 }, homes), [["voice", 7], ["orders", 5]]);
});

// Launchpad's shape: guards attached to a tenant router with use(), which then mounts the
// feature routers; handlers act inside the membership-checked workspace.
const tenantRepo = () => fakeRepo({
  "src/main.ts": 'import express from "express";\nimport routes from "./routes";\nimport { notFound } from "./middlewares/not-found";\nconst app = express();\napp.use("/api", routes);\napp.use(notFound);\napp.listen(3000);\n',
  "src/middlewares/not-found.ts": 'export const notFound = (req, res) => { res.status(404).json({ error: "Not found" }); };\n',
  "src/routes.ts": 'import { Router } from "express";\nimport { requireAuth } from "./middlewares/require-auth";\nimport { requireWorkspace } from "./middlewares/require-workspace";\nimport appsRouter from "./apps";\nconst router = Router();\nconst workspace = Router({ mergeParams: true });\nworkspace.use(requireAuth, requireWorkspace);\nworkspace.use(appsRouter);\nrouter.use("/workspaces/:workspaceId", workspace);\nexport default router;\n',
  "src/middlewares/require-auth.ts": 'export const requireAuth = (req, res, next) => { if (!req.user) return res.status(401).end(); next(); };\n',
  "src/middlewares/require-workspace.ts": 'export const requireWorkspace = async (req, res, next) => {\n  const member = await findMember(req.params.workspaceId, req.user.id);\n  if (!member) return res.status(404).end();\n  req.workspace = { id: req.params.workspaceId };\n  next();\n};\n',
  "src/apps.ts": 'import { Router } from "express";\nconst router = Router();\nrouter.delete("/apps/:appRef", async (req, res) => {\n  res.json(await deleteApp(workspaceOf(req).id, String(req.params["appRef"])));\n});\nrouter.delete("/apps/:appRef/raw", async (req, res) => {\n  res.json(await wipeApp(String(req.params["appRef"])));\n});\nexport default router;\n',
});

test("routes: middleware attached with use() and no router guards every route the router mounts later", () => {
  const { g, done } = tenantRepo();
  const r = routeInventory(g).routes.find((x) => x.id === "DELETE /api/workspaces/:workspaceId/apps/:appRef");
  done();
  assert.ok(r, "the route is found under the tenant mount");
  assert.deepEqual(r.guards.map((x) => x.name ?? x).sort(), ["requireAuth", "requireWorkspace"]);
});

test("access: a record looked up inside the workspace a membership guard checked is scoped to the caller", () => {
  const { g, done } = tenantRepo();
  const m = accessMatrix(g, routeInventory(g));
  done();
  const del = m.find((x) => x.route === "DELETE /api/workspaces/:workspaceId/apps/:appRef");
  assert.equal(del.access, "auth");
  assert.equal(del.scoped, "yes");
  assert.deepEqual(del.flags, []);
  const raw = m.find((x) => x.route === "DELETE /api/workspaces/:workspaceId/apps/:appRef/raw");
  assert.ok(raw.flags.includes("id-param-without-caller-scope"), "a handler that ignores the workspace is still flagged");
});

test("routes: middleware that only loads the session (never rejects) is not a guard, even app-wide", () => {
  const { g, done } = fakeRepo({
    "src/main.ts": 'import express from "express";\nimport { authMiddleware } from "./auth";\nimport routes from "./routes";\nconst app = express();\napp.use(authMiddleware);\napp.use("/api", routes);\napp.listen(3000);\n',
    "src/auth.ts": 'export async function authMiddleware(req, res, next) {\n  const sid = req.cookies.sid;\n  if (!sid) { next(); return; }\n  req.user = await load(sid);\n  next();\n}\n',
    "src/routes.ts": 'import { Router } from "express";\nconst router = Router();\nrouter.get("/menu", (req, res) => res.json([]));\nexport default router;\n',
  });
  const r = routeInventory(g).routes.find((x) => x.id === "GET /api/menu");
  done();
  assert.deepEqual(r.guards, []);
});

test("FR-012: a runner that can't start is explained by its error line, not the last line of its output", async () => {
  const { runError } = await import("../core/worklist.mjs");
  const out = "⎯⎯ Startup Error ⎯⎯\nError: Cannot find module @rollup/rollup-darwin-arm64. npm has a bug related to optional dependencies.\n  [cause]: Error: Cannot find module '@rollup/rollup-darwin-arm64'\n    at Module._load (node:internal/modules/cjs/loader:1370:5)\n    code: 'MODULE_NOT_FOUND',\n  }\n}\n\n";
  assert.equal(runError(out), "Error: Cannot find module @rollup/rollup-darwin-arm64. npm has a bug related to optional dependencies.");
  assert.equal(runError("plain failure\n"), "plain failure");
});

test("FR-011: --run passes the environment .veridic.json's testEnv gives (e.g. DB_TESTS=1) to the test runner", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await rulesRepo('import { test } from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/a.js";\ntest("FR-001: a adds one, against the database", () => { assert.equal(process.env.DB_TESTS, "1"); assert.equal(a(1), 2); });\n');
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ type: "module", scripts: { test: "node --test" } }));
  const spec = fs.readFileSync(path.join(repo, "specs/orders/spec.md"), "utf8");
  const status = () => testCoverage(repo, spec, { specPath: path.join(repo, "specs/orders/spec.md"), run: true }).requirements.find((r) => r.id === "FR-001").status;
  const without = status();
  fs.writeFileSync(path.join(repo, ".veridic.json"), JSON.stringify({ testEnv: { DB_TESTS: "1" } }));
  const withEnv = status();
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(without, "failing");
  assert.equal(withEnv, "passing");
});

// An integration test drives the server over HTTP through a harness: test -> harness -> app ->
// routes -> the cited code, deeper than imports are followed. The URL it calls says what it runs.
async function httpRepo() {
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-http-"));
  const files = {
    "src/consent.js": "export function approve(id, user) {\n  if (!user.owner) throw new Error('forbidden');\n  return { id, approved: true };\n}\n",
    "src/other.js": "export const other = () => 1;\n",
    "src/routes.js": 'import { approve } from "./consent.js";\nexport function mount(router) {\n  router.post("/oauth/requests/:id/approve", (req, res) => res.json(approve(req.params.id, req.user)));\n}\n',
    "src/app.js": 'import { mount } from "./routes.js";\nexport const app = { mount };\n',
    "test/harness.js": 'import { app } from "../src/app.js";\nexport const start = () => ({ base: "http://localhost/api", app });\n',
    "specs/oauth/spec.md": "- **FR-001**: Only an owner can approve a request. [evidence: src/consent.js:1-4]\n- **FR-002**: Other is one. [evidence: src/other.js:1]\n",
    "test/oauth.test.js": 'import { start } from "./harness.js";\nconst h = start();\nit("FR-001: only an owner can approve", async () => {\n  const r = await fetch(`${h.base}/oauth/requests/${7}/approve`, { method: "POST" });\n  expect(r.status).toBe(403);\n});\nit("FR-002: other", async () => {\n  const r = await fetch(`${h.base}/oauth/requests/${7}/approve`, { method: "POST" });\n  expect(r.status).toBe(200);\n});\n',
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  return repo;
}

test("FR-003: a test that calls a route's URL reaches the code behind that route's handler", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await httpRepo();
  const routes = [{ id: "POST /api/oauth/requests/:id/approve", path: "/api/oauth/requests/:id/approve", file: "src/routes.js" }];
  const spec = path.join(repo, "specs/oauth/spec.md");
  const st = Object.fromEntries(testCoverage(repo, fs.readFileSync(spec, "utf8"), { specPath: spec, routes }).requirements.map((r) => [r.id, r.status]));
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(st["FR-001"], "covered", "the URL leads to consent.js");
  assert.notEqual(st["FR-002"], "covered", "the same URL doesn't lead to other.js");
});

test("FR-003: a plain id that two specs share, on a test running both rules' code, counts for neither until the title names its spec", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const repo = await httpRepo();
  fs.writeFileSync(path.join(repo, "src/apps.js"), "export const appOf = (id) => ({ id });\n");
  fs.writeFileSync(path.join(repo, "src/routes.js"), 'import { approve } from "./consent.js";\nimport { appOf } from "./apps.js";\nexport function mount(router) {\n  router.post("/oauth/requests/:id/approve", (req, res) => res.json({ ...approve(req.params.id, req.user), app: appOf(1) }));\n}\n');
  fs.mkdirSync(path.join(repo, "specs/apps"));
  fs.writeFileSync(path.join(repo, "specs/apps/spec.md"), "- **FR-001**: An app is found by id. [evidence: src/apps.js:1]\n");
  const routes = [{ path: "/api/oauth/requests/:id/approve", file: "src/routes.js" }];
  const status = () => Object.fromEntries(["oauth", "apps"].map((k) => { const spec = path.join(repo, `specs/${k}/spec.md`); return [k, testCoverage(repo, fs.readFileSync(spec, "utf8"), { specPath: spec, routes }).requirements.find((r) => r.id === "FR-001")]; }));
  const plain = status();
  const t = path.join(repo, "test/oauth.test.js");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace('it("FR-001: only', 'it("FR-001 (oauth): only'));
  const named = status();
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(plain.oauth.status, "ambiguous");
  assert.equal(plain.apps.status, "ambiguous");
  assert.deepEqual(plain.oauth.ambiguous_tests, ["test/oauth.test.js:3"]);
  assert.equal(named.oauth.status, "covered");
  assert.equal(named.apps.status, "none");
});

test("FR-003: a plain shared id belongs to the spec whose code sits next to the test, when only one does", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-near-"));
  const files = {
    "src/lib/tenant.js": "export const scope = (id) => id;\n",
    "src/oauth/rules.js": 'import { scope } from "../lib/tenant.js";\nexport const tools = (w) => (scope(w) ? ["read"] : []);\n',
    "src/oauth/rules.test.js": 'import { tools } from "./rules.js";\nit("INV-2: tools are only for the workspace", () => { expect(tools("w")).toEqual(["read"]); });\n',
    "specs/oauth/spec.md": "- **INV-2**: Tools are scoped. [evidence: src/oauth/rules.js:2]\n",
    "specs/apps/spec.md": "- **INV-2**: Every query is scoped. [evidence: src/lib/tenant.js:1]\n",
  };
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.join(repo, path.dirname(f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const st = (k) => { const spec = path.join(repo, `specs/${k}/spec.md`); return testCoverage(repo, fs.readFileSync(spec, "utf8"), { specPath: spec, routes: [] }).requirements[0].status; };
  const oauth = st("oauth"), apps = st("apps");
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(oauth, "covered", "the test sits next to oauth's code");
  assert.equal(apps, "none", "apps' INV-2 is only reached through a shared library");
});

test("contract: statuses from a helper given res, an error class thrown two calls down, and the route's guard count as returned", async () => {
  const { contractFromDoc, drift } = await import("../core/contract.mjs");
  const { g, done } = fakeRepo({
    "src/main.ts": 'import express from "express";\nimport routes from "./routes";\nconst app = express();\napp.use("/api", routes);\n',
    "src/routes.ts": 'import { Router } from "express";\nimport { requireWorkspace } from "./require-workspace";\nimport apps from "./apps";\nconst router = Router();\nconst workspace = Router({ mergeParams: true });\nworkspace.use(requireWorkspace);\nworkspace.use(apps);\nrouter.use("/workspaces/:workspaceId", workspace);\nexport default router;\n',
    "src/require-workspace.ts": 'export const requireWorkspace = async (req, res, next) => {\n  if (!req.user) { res.status(401).json({}); return; }\n  if (req.method !== "GET" && req.role === "reviewer") { res.status(403).json({}); return; }\n  next();\n};\n',
    "src/errors.ts": 'export class AppError extends Error {\n  constructor(status, message) { super(message); this.status = status; }\n}\nexport class NotFoundError extends AppError {\n  constructor(message) { super(404, message); }\n}\n',
    "src/http.ts": 'export function parseOr400(schema, value, res) {\n  const parsed = schema.safeParse(value);\n  if (parsed.success) return parsed.data;\n  res.status(400).json({ error: "Invalid request" });\n  return null;\n}\n',
    "src/apps.service.ts": 'import { NotFoundError } from "./errors";\nasync function findApp(ref) {\n  const app = await db.get(ref);\n  if (!app) throw new NotFoundError("no app");\n  return app;\n}\nexport async function deleteApp(ws: string, user: { id: string; email: string }): Promise<{ deleted: string }> {\n  const app = await findApp(ref);\n  return { deleted: app.name };\n}\n',
    "src/apps.ts": 'import { Router } from "express";\nimport { parseOr400 } from "./http";\nimport { deleteApp } from "./apps.service";\nconst router = Router();\nrouter.delete("/apps/:appRef", async (req, res) => {\n  const body = parseOr400(Schema, req.body, res);\n  if (!body) return;\n  res.json(await deleteApp(req.params.workspaceId, req.params.appRef));\n});\nexport default router;\n',
  });
  const contract = contractFromDoc({ servers: [{ url: "/api" }], paths: { "/workspaces/{workspaceId}/apps/{appRef}": { delete: { responses: { 200: {}, 400: {}, 401: {}, 403: {}, 404: {} } } } } });
  const d = drift(g, contract, routeInventory(g).routes);
  done();
  assert.equal(d.summary.documented_ops, 1);
  const op = d.operations.find((o) => o.id.startsWith("DELETE"));
  assert.deepEqual(op?.unreturned_statuses ?? [], [], "no documented status is reported as never returned");
});

test("contract: a handler that parses the request with zod returns what the app's error handler makes of a ZodError", async () => {
  const { contractFromDoc, drift } = await import("../core/contract.mjs");
  const { g, done } = fakeRepo({
    "src/main.ts": 'import express from "express";\nimport routes from "./routes";\nconst app = express();\napp.use("/api", routes);\n',
    "src/errors.ts": 'import { ZodError } from "zod";\nexport class AppError extends Error {\n  constructor(status, message) { super(message); this.status = status; }\n}\nexport class BadRequestError extends AppError {\n  constructor(message) { super(400, message); }\n}\nexport function toAppError(err) {\n  if (err instanceof ZodError) {\n    return new BadRequestError("Invalid request");\n  }\n  return err;\n}\n',
    "src/routes.ts": 'import { Router } from "express";\nconst router = Router();\nrouter.patch("/me", async (req, res) => {\n  const body = UpdateMeBody.parse(req.body);\n  res.json(await save(body));\n});\nexport default router;\n',
  });
  const contract = contractFromDoc({ servers: [{ url: "/api" }], paths: { "/me": { patch: { responses: { 200: {}, 400: {} } } } } });
  const d = drift(g, contract, routeInventory(g).routes);
  done();
  assert.deepEqual(d.operations.find((o) => o.id === "PATCH /api/me")?.unreturned_statuses ?? [], []);
});

test("adapters: every route says which framework it comes from, and Express's routes are unchanged", async () => {
  const { adapters } = await import("../core/frameworks/index.mjs");
  const { g, done } = tenantRepo();
  const routes = routeInventory(g).routes;
  done();
  assert.ok(routes.length > 0);
  assert.ok(routes.every((r) => r.framework === "express"));
  assert.deepEqual(adapters.map((a) => a.name), ["express", "nextjs"]);
});

test("contract: statuses thrown from helpers, through a callback and an error subclass", async () => {
  const { calledStatuses } = await import("../core/contract.mjs");
  const { g, done } = fakeRepo({
    "src/lib/errors.ts": [
      "export class AppError extends Error {",
      "  constructor(status, code, message) { super(message); this.status = status; }",
      "}",
      'export class NotFoundError extends AppError { constructor(m) { super(404, "not_found", m); } }',
      'export class ForbiddenError extends AppError { constructor(m) { super(403, "forbidden", m); } }',
    ].join("\n"),
    "src/apps/apps.service.ts": [
      'import { NotFoundError, ForbiddenError } from "../lib/errors";',
      "async function findApp(tx, ref) {",
      "  const app = await tx.query.apps.findFirst({ where: { ref } });",
      '  if (!app) throw new NotFoundError("no app");',
      "  return app;",
      "}",
      "export function requireOwner(user, app) {",
      '  if (app.ownerId !== user.id) throw new ForbiddenError("not yours");',
      "}",
      "export async function getApp(workspaceId, ref, user) {",
      "  return withWorkspaceRead(workspaceId, async (tx) => {",
      "    const app = await findApp(tx, ref);",
      "    requireOwner(user, app);",
      "    return app;",
      "  });",
      "}",
    ].join("\n"),
    "src/apps/apps.routes.ts": [
      'import { Router } from "express";',
      'import * as apps from "./apps.service";',
      "const router = Router();",
      'router.get("/apps/:ref", async (req, res) => {',
      "  res.json(await apps.getApp(req.workspaceId, req.params.ref, req.user));",
      "});",
      "export default router;",
    ].join("\n"),
  });
  const r = { id: "GET /apps/:ref", method: "GET", path: "/apps/:ref", file: "src/apps/apps.routes.ts", start: 4, end: 6, guards: [] };
  const st = [...new Set(calledStatuses(g, r).map((s) => s.status))].sort();
  done();
  assert.deepEqual(st, [403, 404]);
});
