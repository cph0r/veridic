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
  ];
  const g = { lines: () => src, text: () => src.join("\n"), nodes: new Map(), usesInRange: () => [] };
  const r = (i, method, p) => ({ id: `${method} ${p}`, method, path: p, file: "r.js", start: i, end: i, guards: [] });
  const m = accessMatrix(g, { routes: [r(1, "POST", "/workspace/:slug/chat-feedback/:chatId"), r(2, "DELETE", "/v1/admin/users/:id"), r(3, "DELETE", "/workspace/:slug/thread/:threadId"), r(4, "DELETE", "/documents/:docId")] });
  assert.equal(m[0].access, "auth", "validatedRequest signs the caller in");
  assert.equal(m[0].scoped, "yes", "userFromSession(request) is the caller");
  assert.equal(m[1].access, "role", "an API key on an /admin route is an admin credential");
  assert.ok(m[2].flags.includes("id-param-without-caller-scope"), "a signed-in delete by id with no caller scope is still flagged");
  assert.equal(m[3].flags.length, 0, "single-user mode has one owner");
});

test("effects: closing a response stream is not a destructive write", () => {
  const files = { "r.js": 'router.get("/stream", (req, res) => {\n  res.destroy();\n  stream.destroy();\n});\n' };
  const { g, done } = fakeRepo(files);
  assert.equal(routeEffects(g, { id: "x", file: "r.js", start: 1, end: 4 }).filter((e) => e.kind === "destructive").length, 0);
  done();
});
