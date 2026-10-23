// Next.js routes, read from files (no build): app router route handlers, pages/api and server actions. Each package whose
// package.json depends on `next` is an app. A file path becomes a URL as in nextjs-routes
// (github.com/tatethurston/nextjs-routes, MIT): (group) folders drop, [id] is :id, [...slug]
// and [[...slug]] are *, @slot and _private folders aren't routes.

import fs from "node:fs";
import path from "node:path";
import { codeOnly } from "../graph.mjs";
import { functionExtent, jsonc } from "./paths.mjs";

const HTTP = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const SRC = /\.(?:[cm]?[jt]sx?)$/;
const ignored = (f) => /(?:^|\/)(?:node_modules|\.next|dist|build|out)\//.test(f);

// A file's text from the index, else from disk: the code index lists source files only, so
// package.json and some configs are read from the repo.
const textOf = (g, f) => {
  const t = g.text(f);
  if (t != null) return t;
  try {
    return fs.readFileSync(path.join(g.repo, f), "utf8");
  } catch {
    return null;
  }
};

/** The folders of packages that depend on next ("" for the repo root): the root and every folder holding an indexed file. */
function appDirs(g) {
  if (g.__nextApps) return g.__nextApps;
  const dirs = new Set([""]);
  for (const f of g.files ?? []) {
    if (ignored(f)) continue;
    for (let d = path.posix.dirname(f); d !== "." && !dirs.has(d); d = path.posix.dirname(d)) dirs.add(d);
  }
  const out = [];
  for (const d of dirs) {
    try {
      const p = JSON.parse(textOf(g, d ? `${d}/package.json` : "package.json") ?? "null");
      if (p?.dependencies?.next || p?.devDependencies?.next) out.push(d);
    } catch {}
  }
  g.__nextApps = out.sort();
  return g.__nextApps;
}

/** `basePath` from the app's next.config, when it's a string literal. */
function basePathOf(g, dir) {
  for (const n of ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]) {
    const m = (textOf(g, dir ? `${dir}/${n}` : n) ?? "").match(/\bbasePath\s*:\s*["'`](\/[^"'`]*)["'`]/);
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

/**
 * A pages/api file's handler: the default export's function (named, anonymous, or the
 * function a wrapper is given: `export default withAuth(handler)`), its lines and its text.
 */
function pagesHandler(src) {
  const code = codeOnly(src);
  // An anonymous default function or arrow gets a placeholder name; lines don't move.
  const named = src
    .replace(/\bexport\s+default\s+(async\s+)?function\s*\(/, (m, a) => `export default ${a ?? ""}function __default(`)
    .replace(/\bexport\s+default\s+(async\s+)?(?=\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/, (m, a) => `const __default = ${a ?? ""}`);
  let name = code.match(/\bexport\s+default\s+(?:async\s+)?function\s+([\w$]+)/)?.[1];
  if (!name && named !== src) name = "__default";
  if (!name) {
    const e = code.match(/\bexport\s+default\s+([\w$.]+)\s*(?:\(\s*([\w$]+)\s*[,)])?/);
    if (!e) return null;
    name = e[2] ?? e[1]; // withAuth(handler) -> handler
  }
  let ext = functionExtent(named, name);
  if (!ext) {
    // Handed to a library (`export default NextAuth(authOptions)`): the route is that line.
    const at = code.search(/\bexport\s+default\b/);
    if (at < 0) return null;
    const line = src.slice(0, at).split("\n").length;
    return { start: line, end: line, body: "" };
  }
  const lines = src.split("\n").slice(ext[0] - 1, ext[1]).join("\n");
  return { start: ext[0], end: ext[1], body: lines };
}

/**
 * The methods a pages/api handler answers: those an early exit lets through
 * (`if (req.method !== "POST") return …`), else those it compares (`req.method === "GET"`,
 * `case "POST":` in a switch on the method), else every method (ALL).
 */
function pagesMethods(body) {
  const code = codeOnly(body.replace(/["']([A-Z]+)["']/g, (m, x) => `__${x}__`)); // keep the method names through blanking
  const alias = code.match(/\{\s*method\s*\}\s*=\s*req\b/) ? "(?:req\\.method|\\bmethod)" : "req\\.method";
  const M = "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)";
  const neg = code.match(new RegExp(`if\\s*\\(\\s*${alias}\\s*!==?\\s*__${M}__((?:\\s*&&\\s*${alias}\\s*!==?\\s*__${M}__)*)\\s*\\)`));
  if (neg) return [...neg[0].matchAll(new RegExp(`__${M}__`, "g"))].map((m) => m[1]);
  const pos = new Set([...code.matchAll(new RegExp(`${alias}\\s*===?\\s*__${M}__`, "g"))].map((m) => m[1]));
  if (new RegExp(`switch\\s*\\(\\s*${alias}\\s*\\)`).test(code)) for (const m of code.matchAll(new RegExp(`case\\s+__${M}__\\s*:`, "g"))) pos.add(m[1]);
  return pos.size ? [...pos] : ["ALL"];
}

/** The file a module specifier names, from `from` in app `dir`: relative, or a tsconfig/jsconfig path alias (`@/x`). */
function resolveSpec(g, dir, from, spec) {
  const bases = [];
  if (spec.startsWith(".")) bases.push(path.posix.join(path.posix.dirname(from), spec));
  else
    for (const n of ["tsconfig.json", "jsconfig.json"]) {
      let cfg = null;
      try {
        cfg = JSON.parse(jsonc(textOf(g, dir ? `${dir}/${n}` : n) ?? "null"));
      } catch {}
      const o = cfg?.compilerOptions ?? {};
      for (const [k, targets] of Object.entries(o.paths ?? {})) {
        const pre = k.replace(/\*$/, "");
        if (!spec.startsWith(pre)) continue;
        for (const t of targets) bases.push(path.posix.join(dir, o.baseUrl ?? ".", t.replace(/\*$/, "") + spec.slice(pre.length)));
      }
    }
  for (const b of bases)
    for (const e of ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx", "/index.js"]) {
      const f = path.posix.normalize(b + e);
      if (/\.[cm]?[jt]sx?$/.test(f) && textOf(g, f) != null) return f;
    }
  return null;
}

/** The lines a statement spans, from its first character to the `;` or line end that closes it. */
function statementLines(src, code, at) {
  let depth = 0, i = at;
  for (; i < code.length; i++) {
    const c = code[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (depth <= 0 && (c === ";" || (c === "\n" && i > at && /[)\]}]\s*$/.test(code.slice(at, i))))) break;
  }
  const line = (k) => src.slice(0, k).split("\n").length;
  return { start: line(at), end: line(Math.min(i, code.length - 1)) };
}

/**
 * Server actions in a file: every exported async function when the file starts with
 * "use server", and any function whose body starts with it. [{ name, start, end }]
 */
function actionsIn(src) {
  if (!/["']use server["']/.test(src)) return [];
  const out = [];
  const add = (name) => {
    const ext = functionExtent(src, name);
    if (ext && !out.some((a) => a.name === name)) out.push({ name, start: ext[0], end: ext[1] });
  };
  // A "use server" file: every exported function is an action, a wrapped one
  // (`export const signIn = validatedAction(schema, async () => …)`) spanning its statement.
  if (/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*["']use server["']/.test(src)) {
    const code = codeOnly(src);
    for (const m of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([\w$]+)/g)) add(m[1]);
    for (const m of code.matchAll(/\bexport\s+const\s+([\w$]+)\s*(?::[^=]+)?=\s*/g)) {
      const direct = /^(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/.test(code.slice(m.index + m[0].length));
      if (direct) add(m[1]);
      else if (!out.some((a) => a.name === m[1])) out.push({ name: m[1], ...statementLines(src, code, m.index) });
    }
  }
  for (const m of src.matchAll(/(?:\bfunction\s+([\w$]+)\s*\([^)]*\)\s*(?::[^{]+)?|\b(?:const|let)\s+([\w$]+)\s*=\s*async\s*\([^)]*\)\s*(?::[^=]+)?=>\s*)\{\s*["']use server["']/g)) add(m[1] ?? m[2]);
  return out.sort((a, b) => a.start - b.start);
}

function nextRoutes(g) {
  const routes = [];
  for (const dir of appDirs(g)) {
    const base = basePathOf(g, dir);
    const prefix = dir ? `${dir}/` : "";
    for (const f of g.files ?? []) {
      if (!f.startsWith(prefix) || ignored(f) || !SRC.test(f)) continue;
      const rel = f.slice(prefix.length);
      const api = rel.match(/^(?:src\/)?pages\/(api(?:\/.*)?)\.[cm]?[jt]sx?$/);
      if (api) {
        const segs = api[1].split("/");
        if (segs.at(-1) === "index") segs.pop();
        if (segs.some((s) => s.startsWith("_"))) continue;
        const url = (base + appPath(segs)).replace(/(.)\/$/, "$1") || "/";
        // `export { default } from "@/ee/…"`: the handler is in the file it re-exports.
        let file = f;
        const re = (textOf(g, f) ?? "").match(/\bexport\s*\{\s*default\s*\}\s*from\s*["']([^"']+)["']/);
        if (re) file = resolveSpec(g, dir, f, re[1]) ?? f;
        let h = pagesHandler(textOf(g, file) ?? "");
        if (!h && re) { const line = (textOf(g, f) ?? "").slice(0, re.index).split("\n").length; h = { start: line, end: line, body: "" }; } // re-exports a file that isn't there
        if (h) for (const method of pagesMethods(h.body)) routes.push({ id: `${method} ${url}`, method, path: url, file, start: h.start, end: h.end, guards: [] });
        continue;
      }
      const m = rel.match(/^(?:src\/)?app\/(?:(.*)\/)?route\.[cm]?[jt]sx?$/);
      if (!m) {
        // Server actions: routes too (a form posts to them), named after the page folder they
        // sit in under app/, else after their file: /settings/_action/updateName.
        const acts = actionsIn(textOf(g, f) ?? "");
        if (!acts.length) continue;
        const under = rel.match(/^(?:src\/)?app\/(?:(.*)\/)?[^/]+$/);
        const folder = under ? appPath(under[1] ? under[1].split("/") : []) : null;
        for (const a of acts) {
          const url = folder != null ? `${folder === "/" ? "" : folder}/_action/${a.name}` : `/_action/${path.posix.basename(rel).replace(/\.[^.]+$/, "")}/${a.name}`;
          routes.push({ id: `ACTION ${url}`, method: "ACTION", path: url, file: f, start: a.start, end: a.end, guards: [] });
        }
        continue;
      }
      const p = appPath(m[1] ? m[1].split("/") : []);
      if (p == null) continue;
      const url = (base + p).replace(/(.)\/$/, "$1") || "/";
      for (const h of handlers(textOf(g, f) ?? "")) routes.push({ id: `${h.method} ${url}`, method: h.method, path: url, file: f, start: h.start, end: h.end, guards: [] });
    }
  }
  return { routes };
}

export default { name: "nextjs", detect: (g) => appDirs(g).length > 0, routes: nextRoutes };
