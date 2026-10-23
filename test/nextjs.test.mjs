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

test("next: statuses from NextResponse, Response, notFound and redirect; request body fields", async () => {
  const { handlerFacts } = await import("../core/contract.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "app/api/items/[id]/route.ts": [
      'import { NextResponse } from "next/server";',
      'import { notFound, redirect } from "next/navigation";',
      "export async function POST(req: Request) {",
      "  const { name } = await req.json();",
      '  if (!name) return NextResponse.json({ error: "name" }, { status: 400 });',
      "  const form = await req.formData();",
      '  const email = form.get("email");',
      "  if (!email) notFound();",
      '  if (email === "x") redirect("/login");',
      "  if (name === email) return new Response(null, { status: 204 });",
      '  if (!form) return Response.json({ error: "x" }, { status: 422 });',
      "  return NextResponse.json({ ok: true });",
      "}",
    ].join("\n"),
  });
  const r = routeInventory(g).routes.find((x) => x.id === "POST /api/items/:id");
  const f = handlerFacts(g, r);
  done();
  assert.deepEqual([...new Set(f.statuses.map((s) => s.status))].sort(), [200, 204, 307, 400, 404, 422]);
  assert.ok(f.statuses.find((s) => s.status === 200).implicit, "a response with no status is an implicit 200");
  assert.deepEqual(f.fields.map((x) => x.field).sort(), ["email", "name"]);
});

test("next: a status a called helper answers with counts as returned", async () => {
  const { calledStatuses } = await import("../core/contract.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "app/api/x/route.ts": 'import { NextResponse } from "next/server";\nfunction forbidden() {\n  return NextResponse.json({ error: "no" }, { status: 403 });\n}\nexport async function GET() {\n  if (!ok()) return forbidden();\n  return NextResponse.json({});\n}\n',
  });
  const r = routeInventory(g).routes.find((x) => x.id === "GET /api/x");
  const st = calledStatuses(g, r).map((s) => s.status);
  done();
  assert.ok(st.includes(403));
});

const guardsOf = (g) => Object.fromEntries(routeInventory(g).routes.map((r) => [r.id, r.guards.map((x) => x.name)]));
const MW_REDIRECT = 'import { NextResponse } from "next/server";\nexport function middleware(req) {\n  if (!req.cookies.get("session")) return NextResponse.redirect(new URL("/login", req.url));\n  return NextResponse.next();\n}\n';

test("next: middleware.ts guards the routes its matcher covers, when it can turn a request away", () => {
  const routes = { "app/api/private/x/route.ts": H("GET"), "app/api/public/route.ts": H("GET"), "app/settings/actions.ts": '"use server";\nexport async function save() {}\n' };
  const run = (mw) => { const { g, done } = fakeRepo({ ...PKG, ...routes, "middleware.ts": mw }); const r = guardsOf(g); done(); return r; };
  const a = run(MW_REDIRECT + 'export const config = { matcher: ["/dashboard/:path*", "/api/private/:path*"] };\n');
  assert.deepEqual(a["GET /api/private/x"], ["middleware"]);
  assert.deepEqual(a["GET /api/public"], []);
  const b = run(MW_REDIRECT + 'export const config = { matcher: "/((?!api|_next/static|_next/image|favicon.ico).*)" };\n');
  assert.deepEqual(b["ACTION /settings/_action/save"], ["middleware"]);
  assert.deepEqual(b["GET /api/public"], []);
  const c = run(MW_REDIRECT);
  assert.ok(Object.values(c).every((x) => x.includes("middleware")), "no matcher: every route");
  const d = run('import { NextResponse } from "next/server";\nexport function middleware(req) {\n  const res = NextResponse.next();\n  res.headers.set("x-id", "1");\n  return res;\n}\n');
  assert.ok(Object.values(d).every((x) => x.length === 0), "a middleware that only sets a header guards nothing");
  const e = run('export { auth as middleware } from "@/auth";\nexport const config = { matcher: ["/api/private/:path*"] };\n');
  assert.deepEqual(e["GET /api/private/x"], ["middleware"], "Auth.js's auth as middleware");
});

test("next: a sign-in check in the handler is a guard", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const files = {
    ...PKG,
    "app/api/a/route.ts": 'import { auth } from "@/auth";\nexport async function GET() {\n  const session = await auth();\n  if (!session) return NextResponse.json({ error: "no" }, { status: 401 });\n  return NextResponse.json({});\n}\n',
    "app/api/b/route.ts": 'export async function GET() {\n  const session = await getServerSession(authOptions);\n  if (!session) {\n    redirect("/login");\n  }\n  return Response.json({});\n}\n',
    "app/api/c/route.ts": 'export async function GET() {\n  const { userId } = await auth();\n  if (!userId) return new Response(null, { status: 401 });\n  return Response.json({});\n}\n',
    "app/api/d/route.ts": 'export async function GET() {\n  const { data: { user } } = await supabase.auth.getUser();\n  if (!user) return Response.json({}, { status: 401 });\n  return Response.json({});\n}\n',
    "app/api/f/route.ts": 'export async function POST() {\n  const {\n    error,\n    data: { user }\n  } = await supabase.auth.getUser();\n  if (error || !user) {\n    console.error(error);\n    throw new Error("Could not get user session.");\n  }\n  return Response.json({});\n}\n',
    "app/api/e/route.ts": 'export async function GET() {\n  const session = await auth();\n  return Response.json({ name: session?.user?.name });\n}\n',
  };
  const { g, done } = fakeRepo(files);
  const inv = routeInventory(g);
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  const gs = guardsOf(g);
  done();
  assert.deepEqual(gs["GET /api/a"], ["auth()"]);
  assert.deepEqual(gs["GET /api/b"], ["getServerSession()"]);
  assert.deepEqual(gs["GET /api/c"], ["auth()"]);
  assert.deepEqual(gs["GET /api/d"], ["supabase.auth.getUser()"]);
  assert.deepEqual(gs["POST /api/f"], ["supabase.auth.getUser()"], "an exit later in the if block counts");
  assert.deepEqual(gs["GET /api/e"], [], "reading the session without turning anyone away is no guard");
  for (const k of ["a", "b", "c", "d"]) assert.equal(m[`GET /api/${k}`].access, "auth", k);
  assert.equal(m["GET /api/e"].access, "public");
});

test("next: a record looked up by the session's user id is scoped", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "app/api/posts/[id]/route.ts": 'export async function DELETE(req, { params }) {\n  const session = await auth();\n  if (!session) return new Response(null, { status: 401 });\n  await db.post.deleteMany({ where: { id: params.id, authorId: session.user.id } });\n  return new Response(null, { status: 204 });\n}\n',
    "app/api/notes/[id]/route.ts": 'export async function DELETE(req, { params }) {\n  const session = await auth();\n  if (!session) return new Response(null, { status: 401 });\n  await db.note.delete({ where: { id: params.id } });\n  return new Response(null, { status: 204 });\n}\n',
    // The caller's account, as a wrapper puts it on the request (inbox-zero's request.auth / request.apiAuth).
    "app/api/rules/[id]/route.ts": 'export async function DELETE(request, { params }) {\n  const session = await auth();\n  if (!session) return new Response(null, { status: 401 });\n  const { emailAccountId } = request.apiAuth;\n  await db.rule.deleteMany({ where: { id: params.id, emailAccountId } });\n  return new Response(null, { status: 204 });\n}\n',
  });
  const m = Object.fromEntries(accessMatrix(g, routeInventory(g)).map((x) => [x.route, x]));
  done();
  assert.equal(m["DELETE /api/posts/:id"].scoped, "yes");
  assert.deepEqual(m["DELETE /api/posts/:id"].flags, []);
  assert.ok(m["DELETE /api/notes/:id"].flags.includes("id-param-without-caller-scope"));
  assert.equal(m["DELETE /api/rules/:id"].scoped, "yes");
});

test("next: middleware that protects only some paths guards only those", () => {
  const routes = { "app/dashboard/actions.ts": '"use server";\nexport async function save() {}\n', "app/(login)/actions.ts": '"use server";\nexport async function signIn() {}\n', "app/api/x/route.ts": H("GET") };
  const run = (mw) => { const { g, done } = fakeRepo({ ...PKG, ...routes, "middleware.ts": mw }); const r = guardsOf(g); done(); return r; };
  const starts = run('const protectedRoutes = "/dashboard";\nexport async function middleware(request) {\n  const { pathname } = request.nextUrl;\n  const isProtectedRoute = pathname.startsWith(protectedRoutes);\n  if (isProtectedRoute && !request.cookies.get("session")) {\n    return NextResponse.redirect(new URL("/sign-in", request.url));\n  }\n  return NextResponse.next();\n}\nexport const config = { matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"] };\n');
  assert.deepEqual(starts["ACTION /dashboard/_action/save"], ["middleware"]);
  assert.deepEqual(starts["ACTION /_action/signIn"], [], "sign-in isn't behind the dashboard check");
  const clerkProtected = run('const isProtectedRoute = createRouteMatcher(["/dashboard(.*)"]);\nexport default clerkMiddleware(async (auth, req) => {\n  if (isProtectedRoute(req)) await auth.protect();\n});\n');
  assert.deepEqual(clerkProtected["ACTION /dashboard/_action/save"], ["middleware"]);
  assert.deepEqual(clerkProtected["GET /api/x"], []);
  const clerkPublic = run('const isPublicRoute = createRouteMatcher(["/", "/sign-in(.*)"]);\nexport default clerkMiddleware(async (auth, req) => {\n  if (!isPublicRoute(req)) await auth.protect();\n});\n');
  assert.deepEqual(clerkPublic["GET /api/x"], ["middleware"]);
  assert.deepEqual(clerkPublic["ACTION /_action/signIn"], [], "\"/\" is public");
});

test("next: a handler wrapped in a function that checks sign-in is guarded; one that only catches errors isn't", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "utils/middleware.ts": [
      "function withMiddleware<T extends NextRequest>(handler: Handler<T>, middleware?: Mw) {",
      "  return async (req) => {",
      "    if (middleware) { const r = await middleware(req); if (r instanceof Response) return r; }",
      "    try { return await handler(req); } catch (e) {",
      '      if (e instanceof SafeError) return NextResponse.json({ error: "Authorization required" }, { status: 401 });',
      "      return NextResponse.json({ error: String(e) }, { status: 500 });",
      "    }",
      "  };",
      "}",
      "async function authMiddleware(req) {",
      "  const session = await auth();",
      '  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });',
      "  return req;",
      "}",
      "export function withError(handler) {",
      "  return withMiddleware(handler, undefined);",
      "}",
      "async function validateApiKey(req) {",
      '  const key = req.headers.get("x-api-key");',
      '  if (!(await findKey(key))) throw new SafeError("Invalid API key");',
      "  return key;",
      "}",
      "export function withApiKey(handler) {",
      "  return withError(async (req) => {",
      "    await validateApiKey(req);",
      "    return handler(req);",
      "  });",
      "}",
      "export function withAuth(scope: string, handler: Handler): Handler;",
      "export function withAuth(handler: Handler): Handler;",
      "export function withAuth(scopeOrHandler, handler?) {",
      "  return withMiddleware(handler ?? scopeOrHandler, authMiddleware);",
      "}",
    ].join("\n"),
    "app/api/user/route.ts": 'import { withAuth, withError } from "@/utils/middleware";\nexport const GET = withAuth(async (req) => {\n  return NextResponse.json({ id: req.auth.userId });\n});\nexport const POST = withError(async (req) => {\n  return NextResponse.json({});\n});\n',
    "app/api/v1/route.ts": 'import { withApiKey } from "@/utils/middleware";\nexport const GET = withApiKey(async (req) => NextResponse.json([]));\n',
    "app/api/ops/route.ts": 'import { withAuth } from "@/utils/middleware";\nconst inspect = withAuth(async (req) => {\n  return NextResponse.json({});\n});\nexport const GET = inspect;\nexport { inspect as POST };\n',
  });
  const inv = routeInventory(g);
  const gs = Object.fromEntries(inv.routes.map((r) => [r.id, r.guards.map((x) => x.name)]));
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x.access]));
  const spans = Object.fromEntries(inv.routes.map((r) => [r.id, [r.start, r.end]]));
  done();
  assert.deepEqual(gs["GET /api/user"], ["withAuth"]);
  assert.deepEqual(spans["GET /api/user"], [2, 4], "a wrapped handler spans its whole statement");
  for (const id of ["GET /api/ops", "POST /api/ops"]) {
    assert.deepEqual(gs[id], ["withAuth"], `${id}: an alias of a wrapped handler keeps its guard`);
    assert.deepEqual(spans[id], [2, 4], `${id}: and its body`);
  }
  assert.deepEqual(gs["POST /api/user"], []);
  assert.deepEqual(gs["GET /api/v1"], ["withApiKey"], "a credential check that throws, turned into a 401 elsewhere");
  assert.equal(m["GET /api/user"], "auth");
  assert.equal(m["POST /api/user"], "public");
});

test("next: actions wrapped in a sign-in check are guarded (a wrapper function, or a safe-action client)", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "lib/auth/middleware.ts": 'export function validatedAction(schema, action) {\n  return async (prev, formData) => action(schema.parse(formData), formData);\n}\nexport function validatedActionWithUser<S extends z.ZodType<any, any>, T>(schema: S, action: Fn<S, T>) {\n  return async (prev, formData) => {\n    const user = await getUser();\n    if (!user) {\n      throw new Error("User is not authenticated");\n    }\n    return action(schema.parse(formData), formData, user);\n  };\n}\n',
    "lib/safe-action.ts": 'export const actionClient = createSafeActionClient().use(async ({ next }) => {\n  const session = await auth();\n  if (!session?.user) throw new SafeError("Unauthorized");\n  return next({ ctx: { userId: session.user.id } });\n});\n',
    "app/(login)/actions.ts": '"use server";\nimport { validatedAction, validatedActionWithUser } from "@/lib/auth/middleware";\nexport const signIn = validatedAction(signInSchema, async (data) => {\n  return { ok: true };\n});\nexport const deleteAccount = validatedActionWithUser(deleteSchema, async (data, _, user) => {\n  await db.delete(users);\n});\n',
    "app/mail/actions.ts": '"use server";\nimport { actionClient } from "@/lib/safe-action";\nexport const archive = actionClient.metadata({ name: "archive" }).action(async ({ ctx }) => {\n  await archiveThread(ctx.userId);\n});\n',
  });
  const gs = guardsOf(g);
  done();
  assert.deepEqual(gs["ACTION /_action/signIn"], []);
  assert.deepEqual(gs["ACTION /_action/deleteAccount"], ["validatedActionWithUser"]);
  assert.deepEqual(gs["ACTION /mail/_action/archive"], ["actionClient"]);
});

test("next: a pages/api handler that dispatches by method takes each method's own handler and its guard", async () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "lib/team.ts": [
      "export function withTeamApi(handler) {",
      "  return async (req, res) => {",
      "    const session = await getServerSession(req, res, authOptions);",
      '    if (!session) return res.status(401).end("Unauthorized");',
      "    return handler(req, res, session);",
      "  };",
      "}",
    ].join("\n"),
    "pages/api/teams/[teamId]/branding.ts": [
      'import { withTeamApi } from "@/lib/team";',
      "const getHandler = withTeamApi(async (req, res) => {",
      "  res.json({});",
      "});",
      "async function putHandler(req, res) {",
      "  res.json({});",
      "}",
      "export default async function handle(req, res) {",
      '  if (req.method === "GET") {',
      "    return getHandler(req, res);",
      "  }",
      "  switch (req.method) {",
      '    case "PUT": return putHandler(req, res);',
      "  }",
      '  res.setHeader("Allow", ["GET", "PUT"]);',
      "  return res.status(405).end();",
      "}",
    ].join("\n"),
  });
  const inv = routeInventory(g);
  const r = Object.fromEntries(inv.routes.map((x) => [x.id, x]));
  done();
  assert.deepEqual(Object.keys(r).sort(), ["GET /api/teams/:teamId/branding", "PUT /api/teams/:teamId/branding"]);
  assert.deepEqual([r["GET /api/teams/:teamId/branding"].start, r["GET /api/teams/:teamId/branding"].end], [2, 4]);
  assert.deepEqual(r["GET /api/teams/:teamId/branding"].guards.map((x) => x.name), ["withTeamApi"]);
  assert.deepEqual([r["PUT /api/teams/:teamId/branding"].start, r["PUT /api/teams/:teamId/branding"].end], [5, 7]);
  assert.deepEqual(r["PUT /api/teams/:teamId/branding"].guards, []);
});

test("next: a wrapper that looks up the caller's membership of the URL's id scopes the route; one that only checks sign-in doesn't", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "lib/team.ts": [
      "async function resolveTeam(session, teamId) {",
      '  if (!session?.user) return { status: 401, message: "Unauthorized" };',
      "  const userId = session.user.id;",
      "  const membership = await prisma.userTeam.findUnique({ where: { userId_teamId: { userId, teamId } } });",
      '  if (!membership) return { status: 401, message: "Unauthorized" };',
      "  return { teamId };",
      "}",
      "export function withTeamApi(handler) {",
      "  return async (req, res) => {",
      "    const session = await getServerSession(req, res, authOptions);",
      "    const result = await resolveTeam(session, req.query.teamId);",
      "    if (result.status) return res.status(result.status).json({ error: result.message });",
      "    return handler({ ...result, req, res });",
      "  };",
      "}",
      "export function withSession(handler) {",
      "  return async (req, res) => {",
      "    const session = await getServerSession(req, res, authOptions);",
      '    if (!session) return res.status(401).end("Unauthorized");',
      "    return handler(req, res, session);",
      "  };",
      "}",
    ].join("\n"),
    "pages/api/teams/[teamId]/brands.ts": 'import { withTeamApi } from "@/lib/team";\nexport default withTeamApi(async ({ teamId, req, res }) => {\n  await prisma.brand.delete({ where: { teamId } });\n  res.json({});\n});\n',
    "app/api/teams/[teamId]/route.ts": 'import { withTeamApi, withSession } from "@/lib/team";\nexport const DELETE = withTeamApi(async (req) => NextResponse.json({}));\nexport const PATCH = withSession(async (req, { params }) => NextResponse.json({}));\n',
  });
  const inv = routeInventory(g);
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  done();
  assert.equal(m["DELETE /api/teams/:teamId"].scoped, "yes");
  assert.deepEqual(m["DELETE /api/teams/:teamId"].flags, []);
  assert.equal(m["ALL /api/teams/:teamId/brands"].access, "auth", "pages: export default withX(handler) is guarded");
  assert.deepEqual(m["ALL /api/teams/:teamId/brands"].flags, []);
  assert.deepEqual(m["PATCH /api/teams/:teamId"].flags, ["id-param-without-caller-scope"]);
});

test("effects: Supabase writes and deletes", async () => {
  const { routeEffects } = await import("../core/effects.mjs");
  const src = [
    "export async function POST(req) {",
    '  await supabase.from("posts").insert({ title });', // 2
    "  await supabase",
    '    .from("posts")',
    "    .update({ title })", // 5
    '    .eq("id", id);',
    '  await supabase.from("tags").upsert([{ name }]);', // 7
    '  await supabase.from("posts").delete().eq("id", id);', // 8
    '  const { data } = await supabase.from("posts").select("*");',
    "  const copy = list.insert([x]);", // no .from(: not Supabase
    "  map.delete(key);", // nor this
    "  cookieStore.set({ name, value, ...options });", // a cookie, not data
    "  cookies().set({ name, value });",
    "  await supabase",
    '    .from("posts")',
    "    .delete()", // 16
    '    .eq("id", id);',
    "}",
  ].join("\n");
  const { g, done } = fakeRepo({ "app/api/posts/route.ts": src });
  const found = routeEffects(g, { id: "POST /api/posts", file: "app/api/posts/route.ts", start: 1, end: 18 });
  done();
  const at = (kind) => found.filter((e) => e.kind === kind).map((e) => Number(e.at.split(":").pop()));
  assert.deepEqual(at("write"), [2, 5, 7]);
  assert.deepEqual(at("destructive"), [8, 16]);
});

test("effects: Supabase account changes and emails", async () => {
  const { routeEffects } = await import("../core/effects.mjs");
  const src = [
    "export async function updateName(formData) {",
    "  await supabase.auth.updateUser({ data: { full_name } });", // 2 write
    "  await supabase.auth.signUp({ email, password });", // 3 write
    "  await supabase.auth.resetPasswordForEmail(email);", // 4 notifies
    "  await supabase.auth.signInWithOtp({ email });", // 5 notifies
    "  await supabaseAdmin.auth.admin.deleteUser(id);", // 6 destructive
    "  await supabase.auth.getUser();",
    "  await supabase.auth.signInWithPassword({ email, password });",
    "}",
  ].join("\n");
  const { g, done } = fakeRepo({ "utils/auth.ts": src });
  const found = routeEffects(g, { id: "ACTION /_action/auth/updateName", file: "utils/auth.ts", start: 1, end: 9 });
  done();
  const at = (kind) => found.filter((e) => e.kind === kind).map((e) => Number(e.at.split(":").pop()));
  assert.deepEqual(at("write"), [2, 3]);
  assert.deepEqual(at("notifies"), [4, 5]);
  assert.deepEqual(at("destructive"), [6]);
});

test("next: a wrapper that hands the action the caller's own record scopes it", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "lib/queries.ts": [
      "export async function getTeamForUser() {",
      "  const user = await getUser();",
      "  if (!user) return null;",
      "  return db.query.teamMembers.findFirst({ where: eq(teamMembers.userId, user.id) });",
      "}",
    ].join("\n"),
    "lib/middleware.ts": [
      'import { getTeamForUser } from "@/lib/queries";',
      "export function withTeam(action) {",
      "  return async (formData) => {",
      "    const user = await getUser();",
      '    if (!user) redirect("/sign-in");',
      "    const team = await getTeamForUser();",
      "    return action(formData, team);",
      "  };",
      "}",
      "export function withUser(action) {",
      "  return async (formData) => {",
      "    const user = await getUser();",
      '    if (!user) redirect("/sign-in");',
      "    return action(formData, user);",
      "  };",
      "}",
    ].join("\n"),
    "lib/actions.ts": [
      '"use server";',
      'import { withTeam, withUser } from "@/lib/middleware";',
      "export const checkoutAction = withTeam(async (formData, team) => {",
      '  await createCheckoutSession({ team, priceId: formData.get("priceId") });',
      "});",
      "export const refundAction = withUser(async (formData) => {",
      '  await stripe.refunds.create({ charge: formData.get("chargeId") });',
      "});",
    ].join("\n"),
  });
  const inv = routeInventory(g);
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  done();
  assert.equal(m["ACTION /_action/actions/checkoutAction"].scoped, "yes");
  assert.equal(m["ACTION /_action/actions/refundAction"].scoped, "no", "signing in alone doesn't scope the ids the action is given");
});

test("next: a pages/api handler's method blocks are each method's own code", async () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "pages/api/domains.ts": [
      "export default async function handle(req, res) {", // 1
      "  const session = await getServerSession(req, res, authOptions);",
      '  if (!session) return res.status(401).end("Unauthorized");',
      "  const userId = session.user.id;",
      '  if (req.method === "GET") {', // 5
      "    const all = await prisma.domain.findMany();",
      "    return res.json(all);",
      '  } else if (req.method === "POST") {', // 5
      "    await prisma.domain.create({ data: req.body });",
      "    return res.status(201).json({});",
      "  }", // 8
      "  switch (req.method) {",
      '    case "DELETE":', // 10
      "      await prisma.domain.deleteMany({});",
      "      return res.status(204).end();",
      '    case "PUT":', // 13
      "      return res.json({});",
      "  }", // 15
      "  return res.status(405).end();",
      "}",
    ].join("\n"),
  });
  const { accessMatrix } = await import("../core/access.mjs");
  const inv = routeInventory(g);
  const span = Object.fromEntries(inv.routes.map((r) => [r.method, [r.start, r.end]]));
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route.split(" ")[0], x]));
  done();
  assert.deepEqual(span, { GET: [5, 8], POST: [8, 11], DELETE: [13, 15], PUT: [16, 17] });
  for (const k of ["GET", "POST", "DELETE", "PUT"]) {
    assert.equal(m[k].access, "auth", `${k}: the sign-in check above the blocks still guards it`);
    assert.deepEqual(m[k].guards, ["getServerSession()"]);
  }
});

test("effects: an analytics capture isn't a payment capture", async () => {
  const { routeEffects } = await import("../core/effects.mjs");
  const src = [
    "export async function POST(req) {",
    '  analytics.capture("Document Added", { id });',
    '  posthog.capture({ event: "x" });',
    "  await capture(paymentId);", // 4: a payment capture
    "  await razorpay.payments.capture(id, amount);", // 5
    "}",
  ].join("\n");
  const { g, done } = fakeRepo({ "app/api/x/route.ts": src });
  const found = routeEffects(g, { id: "POST /api/x", file: "app/api/x/route.ts", start: 1, end: 6 });
  done();
  assert.deepEqual(found.filter((e) => e.kind === "moves_money").map((e) => Number(e.at.split(":").pop())), [4, 5]);
});

test("reach: a Next.js route never runs a React component, whatever the index links by name", async () => {
  const { reached } = await import("../core/reach.mjs");
  const files = {
    "pages/api/teams.ts": "export default async function handle(req, res) {\n  await helper();\n  return res.json({});\n}\n",
    "lib/helper.ts": "export function helper() {\n  return 1;\n}\n",
    "components/upload.tsx": "export function Upload() {\n  return <div />;\n}\n",
  };
  const { g, done } = fakeRepo(files);
  const helper = { id: "h", name: "helper", kind: "function", file: "lib/helper.ts", start: 1, end: 3 };
  const upload = { id: "u", name: "Upload", kind: "function", file: "components/upload.tsx", start: 1, end: 3 };
  g.usesInRange = (f) => (f === "pages/api/teams.ts" ? [{ target: helper }, { target: upload }] : []);
  const names = (framework) => reached(g, { id: `GET /api/teams ${framework}`, file: "pages/api/teams.ts", start: 1, end: 4, framework }).map((r) => r.name);
  const next = names("nextjs"), express = names("express");
  done();
  assert.deepEqual(next.slice(1), ["helper"]);
  assert.deepEqual(express.slice(1), ["helper", "Upload"], "Express routes walk as before");
});

test("next: pages/api methods handled before an early 405 count, and a handler that serves the rest answers ALL", () => {
  const { g, done } = fakeRepo({
    ...PKG,
    "pages/api/verify.ts": [
      "export default async function handler(req, res) {",
      '  if (req.method === "GET") {',
      "    return res.json({ ok: true });",
      "  }",
      '  if (req.method !== "POST") {',
      '    res.setHeader("Allow", ["GET", "POST"]);',
      "    return res.status(405).end();",
      "  }",
      "  return res.json({});",
      "}",
    ].join("\n"),
    "pages/api/tus.ts": [
      "export default function handler(req, res) {",
      '  if (req.method === "OPTIONS") {',
      "    return res.status(204).end();",
      "  }",
      "  return tusServer.handle(req, res);",
      "}",
    ].join("\n"),
    "pages/api/items.ts": [
      "export default async function handler(req, res) {",
      '  if (req.method === "GET") {',
      "    return res.json([]);",
      "  }",
      '  if (req.method === "POST") {',
      "    return res.status(201).json({});",
      "  }",
      "  return res.status(405).end();",
      "}",
    ].join("\n"),
  });
  const ids = routeInventory(g).routes.map((r) => r.id).sort();
  done();
  assert.deepEqual(ids, ["ALL /api/tus", "GET /api/items", "GET /api/verify", "POST /api/items", "POST /api/verify"]);
});

test("next: a helper that checks sign-in and membership, left when it returns nothing, guards and scopes the route", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "app/api/teams/[teamId]/saml/route.ts": [
      "async function getAuthenticatedAdmin(teamId) {",
      "  const session = await getServerSession(authOptions);",
      "  if (!session) return null;",
      "  const userId = session.user.id;",
      "  const access = await prisma.userTeam.findUnique({ where: { userId_teamId: { userId, teamId } } });",
      '  if (!access || access.role !== "ADMIN") return null;',
      "  return { userId };",
      "}",
      "export async function DELETE(req, { params }) {",
      "  const { teamId } = await params;",
      "  const auth = await getAuthenticatedAdmin(teamId);",
      "  if (!auth) {",
      '    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });',
      "  }",
      "  await jackson.deleteConnections({ teamId });",
      "  return NextResponse.json({});",
      "}",
      "export async function PATCH(req, { params }) {",
      "  const { teamId } = await params;",
      "  const cfg = await loadConfig(teamId);", // not a sign-in check
      "  if (!cfg) return NextResponse.json({}, { status: 404 });",
      "  return NextResponse.json({});",
      "}",
    ].join("\n"),
  });
  const inv = routeInventory(g);
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  done();
  assert.equal(m["DELETE /api/teams/:teamId/saml"].access, "auth");
  assert.deepEqual(m["DELETE /api/teams/:teamId/saml"].guards, ["getAuthenticatedAdmin()"]);
  assert.deepEqual(m["DELETE /api/teams/:teamId/saml"].flags, []);
  assert.equal(m["PATCH /api/teams/:teamId/saml"].access, "public");
});

test("next: a pages/api handler that only hands the request to another function takes that function's code", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "ee/faqs-route.ts": [
      "export default async function handle(req, res) {",
      '  if (req.method === "POST") {',
      "    const session = await getServerSession(req, res, authOptions);",
      "    if (!session) return res.status(401).end();",
      "    await prisma.faq.create({ data: req.body });",
      "    return res.status(201).json({});",
      "  }",
      "  return res.status(405).end();",
      "}",
    ].join("\n"),
    "pages/api/teams/[teamId]/faqs.ts": 'import publishFAQRoute from "@/ee/faqs-route";\nexport default async function handler(req, res) {\n  return await publishFAQRoute(req, res);\n}\n',
  });
  const inv = routeInventory(g);
  const r = inv.routes;
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  done();
  assert.deepEqual(r.map((x) => [x.id, x.file]), [["POST /api/teams/:teamId/faqs", "ee/faqs-route.ts"]]);
  assert.equal(m["POST /api/teams/:teamId/faqs"].access, "auth");
});

test("next: a pages/api handler that checks, then hands each method on, keeps its checks and takes the method's code", async () => {
  const { accessMatrix } = await import("../core/access.mjs");
  const { g, done } = fakeRepo({
    ...PKG,
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }),
    "lib/team.ts": "export function withTeamApi(handler) {\n  return async (req, res) => {\n    const session = await getServerSession(req, res, authOptions);\n    if (!session) return res.status(401).end();\n    const m = await prisma.userTeam.findUnique({ where: { userId_teamId: { userId: session.user.id, teamId: req.query.teamId } } });\n    if (!m) return res.status(401).end();\n    return handler({ req, res, teamId: req.query.teamId });\n  };\n}\n",
    "lib/bulk.ts": "export async function handleBulkLinkImport(req, res, opts) {\n  const session = await getServerSession(req, res, authOptions);\n  if (!session) return res.status(401).end();\n  await prisma.link.createMany({ data: [] });\n  return res.json({});\n}\n",
    // (a) a 405 for the rest, then a wrapped local handler
    "pages/api/teams/[teamId]/brands/[brandId]/default.ts": [
      'import { withTeamApi } from "@/lib/team";',
      "const postHandler = withTeamApi(async ({ req, res, teamId }) => {",
      "  await prisma.brand.updateMany({ where: { id: req.query.brandId, teamId }, data: {} });",
      "  return res.json({});",
      "});",
      "export default async function handle(req, res) {",
      '  if (req.method !== "POST") {',
      "    return res.status(405).end();",
      "  }",
      "  return postHandler(req, res);",
      "}",
    ].join("\n"),
    // (b) sign-in and membership in the dispatcher, then per-method functions
    "pages/api/teams/[teamId]/slack.ts": [
      "export default async function handler(req, res) {", // 1
      "  const session = await getServerSession(req, res, authOptions);",
      "  if (!session) return res.status(401).end();",
      "  const teamId = req.query.teamId;",
      "  const userTeam = await prisma.userTeam.findUnique({ where: { userId_teamId: { userId: session.user.id, teamId } } });",
      "  if (!userTeam) return res.status(403).end();",
      "  switch (req.method) {",
      '    case "PUT":',
      "      return handleUpdate(req, res, teamId);",
      "    default:",
      "      return res.status(405).end();",
      "  }",
      "}", // 13
      "async function handleUpdate(req, res, teamId) {", // 14
      "  await prisma.integration.update({ where: { teamId }, data: req.body });",
      "  return res.json({});",
      "}",
    ].join("\n"),
    // (c) handed, with options, to a function in another file
    "pages/api/teams/[teamId]/links/bulk.ts": 'import { handleBulkLinkImport } from "@/lib/bulk";\nexport default async function handle(req, res) {\n  const { teamId } = req.query;\n  return handleBulkLinkImport(req, res, { teamId });\n}\n',
  });
  const inv = routeInventory(g);
  const r = Object.fromEntries(inv.routes.map((x) => [x.id, x]));
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  done();
  const brand = "POST /api/teams/:teamId/brands/:brandId/default", slack = "PUT /api/teams/:teamId/slack", bulk = "ALL /api/teams/:teamId/links/bulk";
  assert.deepEqual([r[brand].start, r[brand].end], [2, 5]);
  assert.deepEqual(m[brand].guards, ["withTeamApi"]);
  assert.equal(m[brand].scoped, "yes");
  assert.deepEqual([r[slack].start, r[slack].end], [14, 17]);
  assert.equal(m[slack].access, "auth", "the dispatcher's sign-in check still guards it");
  assert.equal(m[slack].scoped, "yes");
  assert.equal(r[bulk].file, "lib/bulk.ts");
  assert.equal(m[bulk].access, "auth");
});

test("effects: closing a stream and a multi-line $(…).remove() aren't deletes", async () => {
  const { routeEffects } = await import("../core/effects.mjs");
  const src = [
    "export async function GET(req) {",
    "  if (signal?.aborted) response.data.destroy();",
    "  $(",
    "    [",
    '      ".gmail_quote",',
    "    ].join(\", \"),",
    "  ).remove();",
    "  await record.destroy();", // 8: a real delete (Sequelize)
    "}",
  ].join("\n");
  const { g, done } = fakeRepo({ "app/api/x/route.ts": src });
  const found = routeEffects(g, { id: "GET /api/x", file: "app/api/x/route.ts", start: 1, end: 9 });
  done();
  assert.deepEqual(found.filter((e) => e.kind === "destructive").map((e) => Number(e.at.split(":").pop())), [8]);
});
