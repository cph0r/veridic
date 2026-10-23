// Inputs from the whole-branch review of the Next.js adapter: each one a way a route could be
// read as signed-in or scoped when it isn't, or lost, or slow. Guards fail closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { routeInventory } from "../core/routes.mjs";
import { accessMatrix } from "../core/access.mjs";
import { routeEffects } from "../core/effects.mjs";
import { fakeRepo } from "./fake.mjs";

const PKG = { "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }), "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }) };
const matrix = (files) => {
  const { g, done } = fakeRepo({ ...PKG, ...files });
  const inv = routeInventory(g);
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  done();
  return { m, ids: inv.routes.map((r) => r.id).sort() };
};

test("review: a lookup helper that returns null for a missing record isn't a sign-in check", () => {
  const { m } = matrix({
    "lib/users.ts": "export async function findUser(id) {\n  const user = await prisma.user.findUnique({ where: { id } });\n  if (!user) return null;\n  return user;\n}\n",
    "app/api/users/[id]/route.ts": 'import { findUser } from "@/lib/users";\nexport async function DELETE(req, { params }) {\n  const target = await findUser(params.id);\n  if (!target) return Response.json({}, { status: 404 });\n  await prisma.user.delete({ where: { id: params.id } });\n  return Response.json({});\n}\n',
  });
  assert.equal(m["DELETE /api/users/:id"].access, "public");
});

test("review: a 401 an error mapper sends from a catch block isn't a sign-in check", () => {
  const { m } = matrix({
    "lib/errors.ts": 'export function errorResponse(e) {\n  if (e.code === "UNAUTHENTICATED") return Response.json({}, { status: 401 });\n  return Response.json({}, { status: 500 });\n}\nexport function withErrors(handler) {\n  return async (req) => {\n    try { return await handler(req); } catch (e) { return errorResponse(e); }\n  };\n}\n',
    "app/api/admin/wipe/route.ts": 'import { withErrors } from "@/lib/errors";\nexport const POST = withErrors(async (req) => {\n  await db.delete(usersTable);\n  return Response.json({});\n});\n',
  });
  assert.equal(m["POST /api/admin/wipe"].access, "public");
});

test("review: loading the current user by the session's id doesn't scope the URL's id", () => {
  const { m } = matrix({
    "lib/auth.ts": [
      "export function withAuth(handler) {",
      "  return async (req, ctx) => {",
      "    const session = await getServerSession(authOptions);",
      "    if (!session) return Response.json({}, { status: 401 });",
      "    const user = await prisma.user.findUnique({ where: { id: session.user.id } });",
      "    return handler(req, ctx, user);",
      "  };",
      "}",
      "export async function getCurrentUser() {",
      "  const session = await getServerSession(authOptions);",
      "  if (!session) return null;",
      "  return prisma.user.findUnique({ where: { id: session.user.id } });",
      "}",
    ].join("\n"),
    "app/api/posts/[id]/route.ts": 'import { withAuth } from "@/lib/auth";\nexport const DELETE = withAuth(async (req, { params }) => {\n  await prisma.post.delete({ where: { id: params.id } });\n  return Response.json({});\n});\n',
    "app/api/notes/[id]/route.ts": 'import { getCurrentUser } from "@/lib/auth";\nexport async function DELETE(req, { params }) {\n  const user = await getCurrentUser();\n  if (!user) return Response.json({}, { status: 401 });\n  await prisma.note.delete({ where: { id: params.id } });\n  return Response.json({});\n}\n',
  });
  for (const id of ["DELETE /api/posts/:id", "DELETE /api/notes/:id"]) {
    assert.equal(m[id].access, "auth", id);
    assert.ok(m[id].flags.includes("id-param-without-caller-scope"), `${id}: ${m[id].flags}`);
  }
});

test("review: the caller's id only scopes when the query uses it", () => {
  const { m } = matrix({
    "app/api/docs/[id]/route.ts": 'export async function DELETE(req, { params }) {\n  const session = await auth();\n  if (!session) return Response.json({}, { status: 401 });\n  console.log("delete by", session.user.id);\n  await db.doc.delete({ where: { id: params.id } });\n  return Response.json({});\n}\n',
    "app/api/mine/[id]/route.ts": 'export async function DELETE(req, { params }) {\n  const session = await auth();\n  if (!session) return Response.json({}, { status: 401 });\n  await db.doc.deleteMany({ where: { id: params.id, ownerId: session.user.id } });\n  return Response.json({});\n}\n',
  });
  assert.ok(m["DELETE /api/docs/:id"].flags.includes("id-param-without-caller-scope"));
  assert.deepEqual(m["DELETE /api/mine/:id"].flags, []);
});

test("review: middleware that lets some paths through guards only the rest; a redirect elsewhere isn't sign-in", () => {
  const routes = { "app/api/public/ping/route.ts": "export async function GET() { return Response.json({}); }\n", "app/api/users/route.ts": "export async function DELETE() { return Response.json({}); }\n", "app/en/actions.ts": '"use server";\nexport async function save() {}\n' };
  const allow = matrix({
    ...routes,
    "middleware.ts": 'export function middleware(req) {\n  const { pathname } = req.nextUrl;\n  if (pathname.startsWith("/api/public")) return NextResponse.next();\n  if (!req.cookies.get("session")) return NextResponse.redirect(new URL("/login", req.url));\n  return NextResponse.next();\n}\nexport const config = { matcher: ["/api/:path*"] };\n',
  }).m;
  assert.equal(allow["GET /api/public/ping"].access, "public");
  assert.equal(allow["DELETE /api/users"].access, "auth");
  const locale = matrix({
    ...routes,
    "middleware.ts": 'export function middleware(req) {\n  const { pathname } = req.nextUrl;\n  if (!pathname.startsWith("/en")) return NextResponse.redirect(new URL(`/en${pathname}`, req.url));\n  return NextResponse.next();\n}\n',
  }).m;
  for (const r of Object.values(locale)) assert.equal(r.access, "public", r.route);
});

test("review: NextAuth's middleware re-export and Next 16's proxy.ts guard what they match", () => {
  const routes = { "app/dashboard/actions.ts": '"use server";\nexport async function save() {}\n', "app/api/x/route.ts": "export async function GET() { return Response.json({}); }\n" };
  const v4 = matrix({ ...routes, "middleware.ts": 'export { default } from "next-auth/middleware";\nexport const config = { matcher: ["/dashboard/:path*"] };\n' }).m;
  assert.equal(v4["ACTION /dashboard/_action/save"].access, "auth");
  assert.equal(v4["GET /api/x"].access, "public");
  const proxy = matrix({ ...routes, "proxy.ts": 'export function proxy(req) {\n  if (!req.cookies.get("session")) return NextResponse.redirect(new URL("/sign-in", req.url));\n}\nexport const config = { matcher: ["/dashboard/:path*"] };\n' }).m;
  assert.equal(proxy["ACTION /dashboard/_action/save"].access, "auth");
});

test("review: Express effects are unchanged by the Next.js patterns", () => {
  const src = 'app.post("/a", async (req, res) => {\n  await knex.from("users").where({ id }).delete();\n  await supabase.auth.admin.deleteUser(id);\n  analytics.capture({ event: "x" });\n  response.data.destroy();\n});\n';
  const { g, done } = fakeRepo({ "server.js": src });
  const kinds = (framework) => routeEffects(g, { id: `POST /a ${framework}`, file: "server.js", start: 1, end: 6, framework }).map((e) => `${e.kind}@${e.at.split(":").pop()}`).sort();
  const express = kinds(undefined), next = kinds("nextjs");
  done();
  assert.deepEqual(express, ["destructive@5", "moves_money@4"], "as on main");
  assert.deepEqual(next, ["destructive@2", "destructive@3"]);
});

test("review: a handler whose body can't be parsed, or that has type parameters, is still a route", () => {
  const { ids } = matrix({
    "app/api/a/route.ts": 'export async function GET(req) {\n  const s = req.url.replace(/\\{/g, "");\n  return Response.json({ s });\n}\nexport async function POST() {\n  return Response.json({});\n}\n',
    "app/api/b/route.ts": "export async function GET<T extends { a: string }>(req) {\n  return Response.json({});\n}\n",
  });
  assert.deepEqual(ids, ["GET /api/a", "GET /api/b", "POST /api/a"]);
});

test("review: server actions exported by name or as the default", () => {
  const { ids } = matrix({ "app/items/actions.ts": '"use server";\nasync function create() {}\nasync function rename() {}\nexport { create, rename as renameItem };\nexport default async function remove() {\n  await db.delete(t);\n}\n' });
  assert.deepEqual(ids, ["ACTION /items/_action/create", "ACTION /items/_action/remove", "ACTION /items/_action/renameItem"]);
});

test("review: Auth.js v5's auth(handler) route form is guarded", () => {
  const { m } = matrix({
    "auth.ts": 'export const { handlers, auth, signIn } = NextAuth({ providers: [] });\n',
    "app/api/me/route.ts": 'import { auth } from "@/auth";\nexport const GET = auth(function GET(req) {\n  if (!req.auth) return Response.json({}, { status: 401 });\n  return Response.json(req.auth.user);\n});\n',
  });
  assert.equal(m["GET /api/me"].access, "auth");
});

test("review: following helpers stays fast on a big helper module", () => {
  const n = 200;
  const helpers = Array.from({ length: n }, (_, i) => `export async function h${i}(req) {\n  return [${Array.from({ length: 15 }, (_, j) => `h${(i + j + 1) % n}`).join(", ")}];\n}`).join("\n");
  const body = Array.from({ length: n }, (_, i) => `  const v${i} = await h${i}(req);\n  if (!v${i}) return Response.json({}, { status: 400 });`).join("\n");
  const t = Date.now();
  matrix({ "lib/h.ts": helpers, "app/api/x/route.ts": `import { ${Array.from({ length: n }, (_, i) => `h${i}`).join(", ")} } from "@/lib/h";\nexport async function POST(req) {\n${body}\n  return Response.json({});\n}\n` });
  assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`);
});
