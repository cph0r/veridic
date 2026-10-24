// What a screen calls, the forms it shows, and the design tokens: the facts a UI spec needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { screenFacts, designTokens } from "../core/tokens.mjs";

const repoOf = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-ui-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  return { repo, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};

const ROUTES = [
  { id: "GET /api/orders", method: "GET", path: "/api/orders" },
  { id: "POST /api/orders", method: "POST", path: "/api/orders" },
  { id: "GET /api/orders/:id", method: "GET", path: "/api/orders/:id" },
];

test("ui: a page's calls (its own and its hooks'), and its form fields", () => {
  const r = repoOf({
    "src/hooks/useOrders.ts": 'export const useOrders = () => useQuery({ queryKey: ["orders"], queryFn: () => fetch("/api/orders").then((r) => r.json()) });\n',
    "src/pages/Checkout.tsx": [
      'import { useOrders } from "../hooks/useOrders";',
      'import { z } from "zod";',
      "const schema = z.object({ email: z.string().email(), note: z.string().optional() });",
      "export default function Checkout() {",
      "  const { register } = useForm({ resolver: zodResolver(schema) });",
      "  const orders = useOrders();",
      '  const save = () => fetch(`/api/orders`, { method: "POST" });',
      "  return (<form>",
      '    <input {...register("email")} type="email" />',
      '    <input {...register("note")} />',
      '    <input name="coupon" type="text" required />',
      '    <select name="size"><option>S</option></select>',
      "  </form>);",
      "}",
    ].join("\n"),
  });
  const f = screenFacts(r.repo, "src/pages/Checkout.tsx", { routes: ROUTES, url: "/checkout" });
  r.done();
  assert.equal(f.url, "/checkout");
  assert.deepEqual(f.calls.sort(), ["GET /api/orders", "POST /api/orders"]);
  assert.deepEqual(f.forms, [{ fields: [
    { name: "email", type: "email", required: true },
    { name: "note", type: "text", required: false },
    { name: "coupon", type: "text", required: true },
    { name: "size", type: "select", required: false },
  ] }]);
});

test("ui: design tokens from the Tailwind theme and CSS custom properties", () => {
  const r = repoOf({
    "tailwind.config.js": 'module.exports = { theme: { extend: { colors: { brand: "#0e7490", ink: { DEFAULT: "#111", soft: "#555" } }, fontFamily: { display: ["Inter", "sans-serif"] }, borderRadius: { card: "12px" } } } };\n',
    "src/index.css": ":root {\n  --brand-2: #14b8a6;\n  --font-body: 'Inter', sans-serif;\n  --space-4: 16px;\n  --radius-lg: 10px;\n}\n",
  });
  const t = designTokens(r.repo);
  r.done();
  assert.deepEqual(t.colors, { brand: "#0e7490", "ink.DEFAULT": "#111", "ink.soft": "#555", "--brand-2": "#14b8a6" });
  assert.deepEqual(t.fonts, { display: "Inter, sans-serif", "--font-body": "'Inter', sans-serif" });
  assert.deepEqual(t.spacing, { "--space-4": "16px" });
  assert.deepEqual(t.radii, { card: "12px", "--radius-lg": "10px" });
});

test("ui: a truncated or broken Tailwind config ends (no endless loop), keeping what it could read", { timeout: 5000 }, () => {
  for (const cfg of ['module.exports = { theme: { extend: { colors: { brand: "#0e7490", ink: { soft', 'module.exports = { theme: { colors: { brand: "#0e7490", x: "unterminated', "module.exports = { theme: { spacing: [1, 2"]) {
    const r = repoOf({ "tailwind.config.js": cfg });
    const t = designTokens(r.repo);
    r.done();
    assert.ok(t && typeof t.colors === "object");
  }
});

// A screen's calls are real calls, each with the method it uses: an address shown as text
// isn't one, and a URL builder calls only the method its caller passes.
test("ui: an API address shown as text is no call; calls carry their own method (generated clients, fetch, client.get)", async () => {
  const { linkUi } = await import("../core/ui.mjs");
  const R = (m, p) => ({ id: `${m} ${p}`, method: m, path: p, file: "server/routes.ts" });
  const routes = [R("POST", "/api/contact"), R("GET", "/api/auth/google"), R("GET", "/api/auth/logout"), R("GET", "/api/apps/mcp"), R("POST", "/api/apps/mcp"), R("DELETE", "/api/apps/mcp"), R("GET", "/api/apps"), R("DELETE", "/api/apps/:id"), R("GET", "/api/me"), R("PATCH", "/api/me"), R("DELETE", "/api/me"), R("DELETE", "/api/workspaces/:workspaceId/apps/:appRef")];
  const r = repoOf({
    "server/routes.ts": "export const routes = [];\n",
    "web/src/lib/api.ts": [
      "export const getGetMeUrl = () => `/api/me`;",
      "export const getMe = async (options?: Parameters<typeof customFetch>[1]): Promise<Me> => {\n\n  return customFetch<Me>(getGetMeUrl(),\n  {\n    ...options,\n    method: 'GET'\n  }\n);}",
      "export const getGetMeQueryKey = () => {\n    return [\n    `/api/me`\n    ] as const;\n    }",
      "export const useGetMe = () => useQuery({ queryFn: () => getMe() });",
      "export const getDeleteMeUrl = () => `/api/me`;",
      "export const deleteMe = async () => api.delete<void>(getDeleteMeUrl());",
      "export const useDeleteMe = () => useMutation({ mutationFn: () => deleteMe() });",
    ].join("\n"),
    "web/src/components/StructuredData.tsx": 'const SITE_URL = "https://example.dev";\nexport function StructuredData() {\n  return <script>{JSON.stringify({ url: `${SITE_URL}/api/apps/mcp` })}</script>;\n}\n',
    "web/src/pages/Careers.tsx": 'import { StructuredData } from "../components/StructuredData";\nconst SITE_URL = "https://example.dev";\nexport default function Careers() {\n  return <div><StructuredData /><p>Connect at {`${SITE_URL}/api/apps/mcp`}</p></div>;\n}\n',
    "web/src/pages/Account.tsx": 'import { useGetMe } from "../lib/api";\nexport default function Account() {\n  const me = useGetMe();\n  return <p>{me.name}</p>;\n}\n',
    "web/src/pages/Apps.tsx": [
      'import { api } from "../lib/client";',
      "export const mcpUrl = () => `${window.location.origin}/api/apps/mcp`;",
      "export default function Apps() {",
      "  const remove = (id) => fetch(`/api/apps/${id}`, { method: \"DELETE\" });",
      '  const list = () => api.get("/api/apps");',
      "  const url = `/api/me`;",
      '  const leave = () => fetch(url, { method: "DELETE" });',
      "  return <p>{mcpUrl()}</p>;",
      "}",
    ].join("\n"),
    "web/src/lib/client.ts": "export const api = { get: (u) => fetch(u) };\n",
    "web/src/features/Contact.tsx": 'export default function Contact() {\n  const send = (body) => fetch("/api/contact", { method: "POST", body });\n  return <form onSubmit={send} />;\n}\n',
    "web/src/pages/Home.tsx": 'import Contact from "../features/Contact";\nexport default function Home() {\n  return <Contact />;\n}\n',
    "web/src/pages/Login.tsx": 'export default function Login({ next }) {\n  const href = next ? `/api/auth/google?next=${next}` : "/api/auth/google";\n  const out = () => window.location.assign("/api/auth/logout");\n  return <a href={href} onClick={out}>Sign in</a>;\n}\n',
  });
  // As screens.mjs builds it: API client files (every route they hold) are left out.
  const linked = new Map(linkUi(r.repo, routes, [], { methods: true }).files.filter((u) => u.kind !== "client").map((u) => [u.file, u.routes]));
  const calls = (f) => [...screenFacts(r.repo, f, { routes, linked }).calls].sort();
  const got = Object.fromEntries(["web/src/pages/Careers.tsx", "web/src/components/StructuredData.tsx", "web/src/pages/Account.tsx", "web/src/pages/Apps.tsx", "web/src/pages/Home.tsx", "web/src/pages/Login.tsx"].map((f) => [f.replace(/.*\//, ""), calls(f)]));
  // The default linking (parts, metrics) is unchanged.
  const plain = new Map(linkUi(r.repo, routes, []).files.map((u) => [u.file, u.routes]));
  r.done();
  assert.deepEqual(got, {
    "Careers.tsx": [],
    "StructuredData.tsx": [],
    "Account.tsx": ["GET /api/me"],
    "Apps.tsx": ["DELETE /api/apps/:id", "DELETE /api/me", "GET /api/apps"],
    "Home.tsx": ["POST /api/contact"],
    "Login.tsx": ["GET /api/auth/google", "GET /api/auth/logout"],
  });
  assert.ok((plain.get("web/src/pages/Careers.tsx") ?? []).includes("DELETE /api/apps/mcp"), "parts keep today's linking");
});

test("ui: a URL on its declaration's first line belongs to that declaration, not the one before", async () => {
  const { linkUi } = await import("../core/ui.mjs");
  const R = (m, p) => ({ id: `${m} ${p}`, method: m, path: p, file: "server/routes.ts" });
  const r = repoOf({
    "server/routes.ts": "export const routes = [];\n",
    "web/src/lib/api.ts": "export const useOrders = () => fetch(ordersUrl());\nexport const usersUrl = () => `/api/users`;\nexport const ordersUrl = () => `/api/orders`;\n",
    "web/src/pages/Orders.tsx": 'import { useOrders } from "../lib/api";\nexport default function Orders() {\n  useOrders();\n  return <p />;\n}\n',
  });
  const files = new Map(linkUi(r.repo, [R("GET", "/api/orders"), R("GET", "/api/users")], []).files.map((u) => [u.file, u.routes]));
  r.done();
  assert.deepEqual([...files.get("web/src/pages/Orders.tsx")], ["GET /api/orders"]);
});
