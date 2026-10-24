// What a UI spec needs from the code: a screen's URL, the API routes it calls (itself and
// through what it imports), its form fields; and the app's design tokens (colours, fonts,
// spacing, radii) from the Tailwind theme and CSS custom properties.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { importResolver } from "./resolve.mjs";

const read = (repo, f) => { try { return fs.readFileSync(path.join(repo, f), "utf8"); } catch { return ""; } };
const filesOf = (repo) => { try { return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter((f) => f && !/node_modules\//.test(f)); } catch { return []; } };

/** A path as written (`/api/orders/${id}`) against a route path (`/api/orders/:id`). */
const sameRoute = (url, routePath) => {
  const a = url.replace(/\$\{[^}]*\}/g, ":p").replace(/[?#].*$/, "").split("/").filter(Boolean), b = String(routePath).split("/").filter(Boolean);
  return a.length === b.length && a.every((x, i) => x === b[i] || x.startsWith(":") || b[i].startsWith(":"));
};

/**
 * -> { file, url, calls: [route id], forms: [{ fields: [{ name, type, required }] }] }
 * `routes`: [{ id, method, path }]; `url`: the screen's URL when the router says.
 */
export function screenFacts(repo, file, { routes = [], url = null, linked = null } = {}) {
  const resolve = importResolver(repo, { workspaces: true });
  const seen = new Set([file]);
  let frontier = [file];
  for (let d = 0; d < 2; d++) {
    const next = [];
    for (const f of frontier)
      for (const m of read(repo, f).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g)) {
        const hit = resolve(f, m[1]);
        if (hit && !seen.has(hit) && /\.[jt]sx?$/.test(hit)) seen.add(hit), next.push(hit);
      }
    frontier = next;
  }
  const calls = new Set();
  for (const f of seen) {
    const src = read(repo, f);
    // fetch("/x", { method: "POST" }), axios.post("/x"), api.get(`/x/${id}`)
    for (const m of src.matchAll(/\bfetch\(\s*(["'`])([^"'`]*)\1\s*(?:,\s*\{([^}]*)\})?/g)) {
      const method = (m[3]?.match(/method:\s*["'](\w+)["']/)?.[1] ?? "GET").toUpperCase();
      for (const r of routes) if (r.method === method && sameRoute(m[2], r.path)) calls.add(r.id);
    }
    for (const m of src.matchAll(/\b[\w$]+\.(get|post|put|patch|delete)\(\s*(["'`])(\/[^"'`]*)\2/g))
      for (const r of routes) if (r.method === m[1].toUpperCase() && sameRoute(m[3], r.path)) calls.add(r.id);
  }
  // And what core/ui.mjs linked these files to (API clients, generated hooks, API_BASE URLs).
  // A file linked to many routes is a shared API client, not something this screen calls.
  if (linked) for (const f of seen) { const ids = linked.get(f) ?? []; if (f === file || ids.length <= 6) for (const id of ids) calls.add(id); }
  // Form fields: react-hook-form's register("x") (required per its zod schema), and named inputs.
  const src = read(repo, file);
  const zodField = new Map();
  for (const m of src.matchAll(/\b(\w+)\s*:\s*z\.([\w.()'"`,\s]*?)(?=,\s*\w+\s*:|\s*\}\s*\))/g)) zodField.set(m[1], !/\.optional\(|\.nullish\(|\.default\(/.test(m[2]));
  const fields = [];
  const add = (f) => { if (!fields.some((x) => x.name === f.name)) fields.push(f); };
  for (const m of src.matchAll(/<(input|textarea|select)\b([^>]*)>/g)) {
    const attrs = m[2];
    const name = attrs.match(/register\(\s*["'`](\w+)["'`]/)?.[1] ?? attrs.match(/\bname\s*=\s*["'`](\w+)["'`]/)?.[1];
    if (!name) continue;
    const type = m[1] === "input" ? attrs.match(/\btype\s*=\s*["'`](\w+)["'`]/)?.[1] ?? "text" : m[1];
    const required = zodField.has(name) ? zodField.get(name) : /\brequired\b/.test(attrs) || /register\([^)]*required\s*:\s*true/.test(attrs);
    add({ name, type, required });
  }
  return { file, url, calls: [...calls], forms: fields.length ? [{ fields }] : [] };
}

// A small reader for literal JS objects ({ a: "x", b: { c: "y" }, d: ["p", "q"] }): no evaluation.
function parseLiteral(s, i = 0) {
  const ws = () => { while (/\s/.test(s[i] ?? "")) i++; };
  const value = () => {
    ws();
    if (s[i] === "{") {
      const o = {}; i++;
      for (;;) {
        ws();
        if (s[i] === "}") { i++; return o; }
        const k = s.slice(i).match(/^(?:["'`]([^"'`]+)["'`]|([\w$-]+))\s*:/);
        if (!k) { while (i < s.length && s[i] !== "," && s[i] !== "}") i++; if (s[i] === ",") i++; continue; }
        i += k[0].length;
        o[k[1] ?? k[2]] = value();
        ws(); if (s[i] === ",") i++;
      }
    }
    if (s[i] === "[") {
      const a = []; i++;
      for (;;) { ws(); if (s[i] === "]") { i++; return a; } a.push(value()); ws(); if (s[i] === ",") i++; else if (s[i] !== "]") { i++; } }
    }
    const q = s[i];
    if (q === '"' || q === "'" || q === "`") { const j = s.indexOf(q, i + 1); const v = s.slice(i + 1, j); i = j + 1; return v; }
    const raw = s.slice(i).match(/^[^,}\]]*/)[0]; i += raw.length; return { expr: raw.trim() };
  };
  return value();
}
const flatten = (o, pre = "", out = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    const key = pre ? `${pre}.${k}` : k;
    if (Array.isArray(v)) out[key] = v.filter((x) => typeof x === "string").join(", ");
    else if (v && typeof v === "object" && !("expr" in v)) flatten(v, key, out);
    else if (typeof v === "string") out[key] = v;
  }
  return out;
};

/** -> { colors, fonts, spacing, radii }: name -> value. */
export function designTokens(repo) {
  const out = { colors: {}, fonts: {}, spacing: {}, radii: {} };
  const files = filesOf(repo);
  for (const f of files.filter((x) => /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/.test(x))) {
    const src = read(repo, f);
    const theme = src.match(/\btheme\s*:\s*\{/);
    if (!theme) continue;
    const t = parseLiteral(src, theme.index + theme[0].length - 1);
    const scope = { ...(t.extend ?? {}), ...Object.fromEntries(Object.entries(t).filter(([k]) => k !== "extend")) };
    Object.assign(out.colors, flatten(scope.colors));
    Object.assign(out.fonts, flatten(scope.fontFamily));
    Object.assign(out.spacing, flatten(scope.spacing));
    Object.assign(out.radii, flatten(scope.borderRadius));
  }
  const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\()/i;
  for (const f of files.filter((x) => /\.(?:css|scss)$/.test(x)).slice(0, 200)) {
    const src = read(repo, f);
    for (const block of src.matchAll(/:root\s*\{([^}]*)\}/g))
      for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        const [name, value] = [m[1], m[2].trim()];
        if (/font/i.test(name)) out.fonts[name] = value;
        else if (/radius|rounded/i.test(name)) out.radii[name] = value;
        else if (/space|spacing|gap|gutter/i.test(name)) out.spacing[name] = value;
        else if (COLOR.test(value)) out.colors[name] = value;
      }
  }
  return out;
}
