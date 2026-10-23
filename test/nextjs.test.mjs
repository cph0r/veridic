// Next.js: routes from files (app router, pages/api, server actions), guards, statuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInventory } from "../core/routes.mjs";
import { fakeRepo } from "./fake.mjs";

const PKG = { "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }) };
const ids = (g) => routeInventory(g).routes.filter((r) => r.framework === "nextjs").map((r) => r.id).sort();
const H = (m) => `export async function ${m}() {\n  return Response.json({});\n}\n`;

test("next: route.ts folders become paths", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "app/(shop)/orders/[id]/route.ts": H("GET"),
    "src/app/api/[...slug]/route.ts": H("GET"),
    "app/docs/[[...slug]]/route.ts": H("GET"),
    "app/@modal/x/route.ts": H("GET"),
    "app/_lib/route.ts": H("GET"),
    "app/page.tsx": "export default function Home() { return null; }\n",
  });
  const got = ids(g);
  done();
  assert.deepEqual(got, ["GET /api/*", "GET /docs/*", "GET /orders/:id"]);
  const b = fakeRepo({ ...PKG, "next.config.js": 'module.exports = { basePath: "/app" };\n', "app/orders/[id]/route.ts": H("GET") });
  const withBase = ids(b.g);
  b.done();
  assert.deepEqual(withBase, ["GET /app/orders/:id"]);
});

test("next: each exported method is a route with its own extent", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "app/api/items/route.ts": 'export async function GET() {\n  return Response.json([]);\n}\n\nexport const POST = async (req: Request) => {\n  const body = await req.json();\n  return Response.json(body, { status: 201 });\n};\n\nexport const runtime = "edge";\nexport const dynamic = "force-dynamic";\nexport function helper() {\n  return 1;\n}\n',
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.file, r.start, r.end]), [
    ["GET /api/items", "app/api/items/route.ts", 1, 3],
    ["POST /api/items", "app/api/items/route.ts", 5, 8],
  ]);
  assert.ok(rs.every((r) => Array.isArray(r.guards)));
});

test("next: re-exported handlers are routes", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "app/api/hook/route.ts": 'async function handler(req: Request) {\n  return Response.json({ ok: true });\n}\n\nexport { handler as GET, handler as POST };\n',
    "app/api/auth/[...nextauth]/route.ts": 'import { handlers } from "@/auth";\nexport const { GET, POST } = handlers;\n',
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.start, r.end]).sort(), [
    ["GET /api/auth/*", 2, 2],
    ["GET /api/hook", 1, 3],
    ["POST /api/auth/*", 2, 2],
    ["POST /api/hook", 1, 3],
  ]);
});

test("next: an app is found from package.json on disk, which the code index doesn't list", () => {
  const { g, done } = fakeRepo({ ...PKG, "apps/web/package.json": PKG["package.json"], "app/api/x/route.ts": H("GET"), "apps/web/app/api/y/route.ts": H("POST") });
  g.files = g.files.filter((f) => !f.endsWith("package.json")); // as CodeGraph: source files only
  const text = g.text;
  g.text = (f) => (f.endsWith("package.json") ? null : text(f));
  const got = ids(g);
  done();
  assert.deepEqual(got, ["GET /api/x", "POST /api/y"]);
});

test("next: pages/api routes and their methods", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "pages/api/users/[id].ts": 'export default async function handler(req, res) {\n  if (req.method === "GET") return res.json({});\n  if (req.method === "DELETE") return res.status(204).end();\n  res.status(405).end();\n}\n',
    "pages/api/ping.ts": "export default function handler(req, res) {\n  res.json({ ok: true });\n}\n",
    "pages/api/orders/index.ts": 'export default async function (req, res) {\n  switch (req.method) {\n    case "POST":\n      return res.status(201).json({});\n  }\n}\n',
    "pages/api/login.ts": 'export default async function handler(req, res) {\n  if (req.method !== "POST" && req.method !== "PUT") return res.status(405).end();\n  res.json({});\n}\n',
    "pages/api/record.ts": 'export default async function handler(req, res) {\n  if (req.method !== "POST") {\n    res.status(405).json({ error: "Method Not Allowed" });\n    return;\n  }\n  res.json({});\n}\n',
    "pages/api/alias.ts": 'export default function handler(req, res) {\n  const { method } = req;\n  if (method === "GET") return res.json([]);\n  if (method === "PUT") return res.json({});\n}\n',
    "pages/api/wrapped.ts": 'async function handler(req, res) {\n  res.json({});\n}\n\nexport default withAuth(handler);\n',
    "pages/api/_middleware.ts": "export default function m() {}\n",
    "pages/about.tsx": "export default function About() { return null; }\n",
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  assert.deepEqual(rs.map((r) => r.id).sort(), ["ALL /api/ping", "ALL /api/wrapped", "DELETE /api/users/:id", "GET /api/alias", "GET /api/users/:id", "POST /api/login", "POST /api/orders", "POST /api/record", "PUT /api/alias", "PUT /api/login"]);
  const w = rs.find((r) => r.id === "ALL /api/wrapped");
  assert.deepEqual([w.start, w.end], [1, 3], "a wrapped default export spans its handler");
  const u = rs.find((r) => r.id === "GET /api/users/:id");
  assert.deepEqual([u.start, u.end], [1, 5]);
});

test("next: pages/api handlers given to a library, written as an arrow, or re-exported from another file", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "pages/api/auth/[...nextauth].ts": 'import NextAuth from "next-auth";\nimport { authOptions } from "@/lib/auth";\n\nexport default NextAuth(authOptions);\n',
    "pages/api/pages.ts": 'export default async (req, res) => {\n  if (req.method !== "POST") return res.status(405).end();\n  res.json({});\n};\n',
    "pages/api/jobs/notify.ts": 'export { default } from "@/ee/jobs/notify";\n',
    "ee/jobs/notify.ts": 'export default async function handler(req, res) {\n  if (req.method === "POST") return res.json({});\n}\n',
    "pages/api/jobs/gone.ts": '// moved\nexport { default } from "@/ee/jobs/gone";\n',
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  const by = Object.fromEntries(rs.map((r) => [r.id, [r.file, r.start, r.end]]));
  assert.deepEqual(by["ALL /api/auth/*"], ["pages/api/auth/[...nextauth].ts", 4, 4]);
  assert.deepEqual(by["POST /api/pages"], ["pages/api/pages.ts", 1, 4]);
  assert.deepEqual(by["POST /api/jobs/notify"], ["ee/jobs/notify.ts", 1, 3], "the route's handler is in the file it re-exports");
  assert.deepEqual(by["ALL /api/jobs/gone"], ["pages/api/jobs/gone.ts", 2, 2], "a re-export of a missing file is still a route, on its line");
  assert.equal(rs.length, 4);
});

test("next: exported functions of a 'use server' file are actions", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "app/(dashboard)/settings/actions.ts": '"use server";\n\nimport { db } from "@/lib/db";\n\nexport async function updateName(form: FormData) {\n  await db.update(users).set({ name: form.get("name") });\n}\n\nexport const deleteAccount = async () => {\n  await db.delete(users);\n};\n\nasync function helper() {\n  return 1;\n}\n',
    "lib/actions.ts": "'use server'\nexport async function sendInvite(email: string) {\n  return { ok: true };\n}\n",
    "lib/plain.ts": "export async function notAnAction() {}\n",
  });
  const rs = routeInventory(g).routes.filter((r) => r.method === "ACTION");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.start, r.end]).sort(), [
    ["ACTION /_action/actions/sendInvite", 2, 4],
    ["ACTION /settings/_action/deleteAccount", 9, 11],
    ["ACTION /settings/_action/updateName", 5, 7],
  ]);
});

test("next: a function whose body starts with 'use server' is an action", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "app/posts/page.tsx": 'export default function Page() {\n  async function create(form: FormData) {\n    "use server";\n    await db.insert(posts).values({ title: form.get("title") });\n  }\n  return <form action={create} />;\n}\n',
  });
  const rs = routeInventory(g).routes.filter((r) => r.method === "ACTION");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.start, r.end]), [["ACTION /posts/_action/create", 2, 5]]);
});

test("next: an app with only pages and actions forms parts", async () => {
  const { findModules } = await import("../core/modules.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "app/settings/actions.ts": '"use server";\nexport async function updateName() {\n  await db.update(users).set({});\n}\nexport async function deleteAccount() {\n  await db.delete(users);\n}\n',
    "app/settings/page.tsx": "export default function Page() { return null; }\n",
  });
  const inv = routeInventory(g);
  const mods = findModules(g, inv);
  done();
  assert.ok(inv.routes.length === 2, "two actions");
  assert.ok(mods.some((m) => m.routes.includes("ACTION /settings/_action/updateName")), "a part holds the actions");
});

test("next: every export of a 'use server' file is an action, wrapped ones too", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "app/(login)/actions.ts": '"use server";\n\nexport const signIn = validatedAction(signInSchema, async (data, formData) => {\n  const user = await findUser(data.email);\n  return { ok: !!user };\n});\n\nexport const deleteAccount = validatedActionWithUser(\n  deleteSchema,\n  async (data, _, user) => {\n    await db.delete(users);\n  }\n);\n\nexport function signOut() {\n  return logout();\n}\n',
  });
  const rs = routeInventory(g).routes.filter((r) => r.method === "ACTION");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.start, r.end]), [
    ["ACTION /_action/signIn", 3, 6],
    ["ACTION /_action/deleteAccount", 8, 13],
    ["ACTION /_action/signOut", 15, 17],
  ]);
});

test("next: each package depending on next is its own app, each file in its nearest app", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "apps/web/package.json": PKG["package.json"],
    "apps/web/app/api/x/route.ts": H("GET"),
    "apps/web/app/settings/actions.ts": '"use server";\nexport async function save() {}\n',
    "packages/lib/package.json": JSON.stringify({ dependencies: { zod: "3" } }),
    "packages/lib/app/api/no/route.ts": H("GET"),
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.file]).sort(), [
    ["ACTION /settings/_action/save", "apps/web/app/settings/actions.ts"],
    ["GET /api/x", "apps/web/app/api/x/route.ts"],
  ]);
});

test("adapters: an Express server and a Next app side by side", async () => {
  const { adapters } = await import("../core/frameworks/index.mjs");
  const files = {
    "package.json": JSON.stringify({ workspaces: ["server", "web"] }),
    "server/package.json": JSON.stringify({ dependencies: { express: "4" } }),
    "server/src/main.ts": 'import express from "express";\nimport orders from "./orders";\nconst app = express();\napp.use("/api", orders);\napp.listen(3000);\n',
    "server/src/orders.ts": 'import { Router } from "express";\nconst router = Router();\nrouter.get("/orders", (req, res) => res.json([]));\nexport default router;\n',
    "web/package.json": PKG["package.json"],
    "web/app/api/health/route.ts": H("GET"),
  };
  const { g, done } = fakeRepo(files);
  const all = routeInventory(g).routes;
  const expressAlone = adapters.find((a) => a.name === "express").routes(g, {}).routes;
  done();
  assert.deepEqual(all.map((r) => `${r.framework} ${r.id}`).sort(), ["express GET /api/orders", "nextjs GET /api/health"]);
  assert.deepEqual(all.filter((r) => r.framework === "express").map(({ framework, ...r }) => r), expressAlone);
});

test("next: Noir's Next.js fixtures give the endpoints its specs expect", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = new URL("./fixtures/noir/", import.meta.url).pathname;
  const norm = (id) => id.replace(/\/:[\w$]+/g, "/:").replace(/\/\*/g, "/:");
  // Noir writes ALL as the five methods, a catch-all as {slug}, and a server action as POST /<name>.
  const expand = (r) => (r.method === "ACTION" ? [`POST /${r.path.split("/").pop()}`] : (r.method === "ALL" ? ["GET", "POST", "PUT", "DELETE", "PATCH"] : [r.method]).map((m) => norm(`${m} ${r.path}`)));
  for (const dir of fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "expected.json")))) {
    const files = {};
    const walk = (d) => { for (const e of fs.readdirSync(path.join(root, dir, d), { withFileTypes: true })) { const rel = d ? `${d}/${e.name}` : e.name; if (e.isDirectory()) walk(rel); else files[rel] = fs.readFileSync(path.join(root, dir, rel), "utf8"); } };
    walk("");
    delete files["expected.json"];
    const { g, done } = fakeRepo(files);
    const got = new Set(routeInventory(g).routes.flatMap(expand));
    done();
    const want = new Set(JSON.parse(files["expected.json"] ?? fs.readFileSync(path.join(root, dir, "expected.json"), "utf8")).endpoints.map(norm));
    const missing = [...want].filter((x) => !got.has(x)), extra = [...got].filter((x) => !want.has(x));
    assert.deepEqual({ dir, missing, extra }, { dir, missing: [], extra: [] });
  }
});

test("next: a verb map answers only its verbs, and a renamed re-export is followed", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "pages/api/legacy.ts": 'import { defaultHandler } from "../../lib/responder";\nconst getHandler = async (req, res) => ({ ok: true });\n\nexport default defaultHandler({\n  GET: Promise.resolve({ default: getHandler }),\n  POST: import("./_post"),\n});\n',
    "pages/api/verify.ts": 'export { handler as default } from "../../lib/verify";\n',
    "lib/verify.ts": "export async function handler(req, res) {\n  res.status(200).json({ verified: true });\n}\n",
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  assert.deepEqual(rs.map((r) => [r.id, r.file, r.start, r.end]).sort(), [
    ["ALL /api/verify", "lib/verify.ts", 1, 3],
    ["GET /api/legacy", "pages/api/legacy.ts", 4, 7],
    ["POST /api/legacy", "pages/api/legacy.ts", 4, 7],
  ]);
});
