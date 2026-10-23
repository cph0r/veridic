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
