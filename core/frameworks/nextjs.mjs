// Next.js routes, read from files (no build): app router route handlers. Each package whose
// package.json depends on `next` is an app. A file path becomes a URL as in nextjs-routes
// (github.com/tatethurston/nextjs-routes, MIT): (group) folders drop, [id] is :id, [...slug]
// and [[...slug]] are *, @slot and _private folders aren't routes.

import path from "node:path";
import { codeOnly } from "../graph.mjs";
import { functionExtent } from "./paths.mjs";

const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const SRC = /\.(?:[cm]?[jt]sx?)$/;
const ignored = (f) => /(?:^|\/)(?:node_modules|\.next|dist|build|out)\//.test(f);

/** The folders of packages that depend on next ("" for the repo root). */
function appDirs(g) {
  const out = [];
  for (const f of g.files ?? []) {
    if (!/(?:^|\/)package\.json$/.test(f) || ignored(f)) continue;
    try {
      const p = JSON.parse(g.text(f) ?? "{}");
      if (p.dependencies?.next || p.devDependencies?.next) out.push(path.posix.dirname(f) === "." ? "" : path.posix.dirname(f));
    } catch {}
  }
  return out;
}

/** `basePath` from the app's next.config, when it's a string literal. */
function basePathOf(g, dir) {
  for (const n of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
    const m = (g.text(dir ? `${dir}/${n}` : n) ?? "").match(/\bbasePath\s*:\s*["'`](\/[^"'`]*)["'`]/);
    if (m) return m[1].replace(/\/$/, "");
  }
  return "";
}

/**
 * The URL an app-router folder serves, from its segments under app/: null when a segment
 * makes it no route (@slot, _private).
 */
export function appPath(segments) {
  const out = [];
  for (const s of segments) {
    if (s.startsWith("@") || s.startsWith("_")) return null;
    if (/^\(.*\)$/.test(s)) continue;
    if (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(s)) out.push("*");
    else if (/^\[[^\]]+\]$/.test(s)) out.push(`:${s.slice(1, -1)}`);
    else out.push(s);
  }
  return `/${out.join("/")}`;
}

const lineOf = (src, i) => src.slice(0, i).split("\n").length;

/** The methods a route.ts exports, each with the lines its handler spans. */
function handlers(src) {
  const code = codeOnly(src);
  const out = [];
  const add = (method, extent) => { if (HTTP.includes(method) && extent && !out.some((h) => h.method === method)) out.push({ method, start: extent[0], end: extent[1] }); };
  // export async function GET(…) / export const POST = …
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Z]+)\s*\(/g)) add(m[1], functionExtent(src, m[1]));
  for (const m of code.matchAll(/\bexport\s+const\s+([A-Z]+)\s*(?::[^=]+)?=/g)) {
    if (!HTTP.includes(m[1])) continue;
    const line = lineOf(src, m.index);
    add(m[1], functionExtent(src, m[1]) ?? [line, line]);
  }
  // export { handler as GET, POST }
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g))
    for (const part of m[1].split(",")) {
      const [local, exported = local] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      if (HTTP.includes(exported)) add(exported, functionExtent(src, local) ?? [lineOf(src, m.index), lineOf(src, m.index)]);
    }
  // export const { GET, POST } = handlers   (Auth.js)
  for (const m of code.matchAll(/\bexport\s+const\s*\{([^}]*)\}\s*=/g)) {
    const line = lineOf(src, m.index);
    for (const name of m[1].split(",").map((x) => x.trim().split(/\s*:\s*/).pop())) add(name, [line, line]);
  }
  return out.sort((a, b) => a.start - b.start || a.method.localeCompare(b.method));
}

function nextRoutes(g) {
  const routes = [];
  for (const dir of appDirs(g)) {
    const base = basePathOf(g, dir);
    const prefix = dir ? `${dir}/` : "";
    for (const f of g.files ?? []) {
      if (!f.startsWith(prefix) || ignored(f) || !SRC.test(f)) continue;
      const rel = f.slice(prefix.length);
      const m = rel.match(/^(?:src\/)?app\/(?:(.*)\/)?route\.[cm]?[jt]sx?$/);
      if (!m) continue;
      const p = appPath(m[1] ? m[1].split("/") : []);
      if (p == null) continue;
      const url = (base + p).replace(/(.)\/$/, "$1") || "/";
      for (const h of handlers(g.text(f) ?? "")) routes.push({ id: `${h.method} ${url}`, method: h.method, path: url, file: f, start: h.start, end: h.end, guards: [] });
    }
  }
  return { routes };
}

export default { name: "nextjs", detect: (g) => appDirs(g).length > 0, routes: nextRoutes };
