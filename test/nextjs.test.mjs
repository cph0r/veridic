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
    "pages/api/alias.ts": 'export default function handler(req, res) {\n  const { method } = req;\n  if (method === "GET") return res.json([]);\n  if (method === "PUT") return res.json({});\n}\n',
    "pages/api/wrapped.ts": 'async function handler(req, res) {\n  res.json({});\n}\n\nexport default withAuth(handler);\n',
    "pages/api/_middleware.ts": "export default function m() {}\n",
    "pages/about.tsx": "export default function About() { return null; }\n",
  });
  const rs = routeInventory(g).routes.filter((r) => r.framework === "nextjs");
  done();
  assert.deepEqual(rs.map((r) => r.id).sort(), ["ALL /api/ping", "ALL /api/wrapped", "DELETE /api/users/:id", "GET /api/alias", "GET /api/users/:id", "POST /api/login", "POST /api/orders", "PUT /api/alias", "PUT /api/login"]);
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
