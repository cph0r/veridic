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
