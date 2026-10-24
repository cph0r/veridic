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
