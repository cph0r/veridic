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
  assert.match(unknown.error, /no module "nope"/);
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

test("FR-015: the report names a broken rule 'broken, proven'", () => {
  const page = fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8");
  const req = page.match(/const REQ = \{([\s\S]*?)\};/)[1];
  assert.match(req, /broken: \["Broken, proven", "high"\]/);
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
