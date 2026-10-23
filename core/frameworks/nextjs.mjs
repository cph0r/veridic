// Next.js routes, read from files (no build): app router route handlers, pages/api and server actions. Each package whose
// package.json depends on `next` is an app. A file path becomes a URL as in nextjs-routes
// (github.com/tatethurston/nextjs-routes, MIT): (group) folders drop, [id] is :id, [...slug]
// and [[...slug]] are *, @slot and _private folders aren't routes.

import fs from "node:fs";
import path from "node:path";
import { codeOnly } from "../graph.mjs";
import { functionExtent, functionSpan, jsonc } from "./paths.mjs";
import { idioms as expressIdioms } from "./express.mjs";

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
/** A local name's handler: its function, or `const name = withAuth(async …)` as a whole statement with its wrapper. */
function localHandler(src, name, code = codeOnly(src)) {
  const fn = functionExtent(src, name);
  if (fn) return { extent: fn };
  const c = new RegExp(`\\bconst\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*([\\w$]+)\\s*\\(`).exec(code);
  if (!c || /^(?:async|function)$/.test(c[1])) return null;
  const st = statementLines(src, code, c.index);
  return st ? { extent: [st.start, st.end], wrapper: c[1] } : null;
}

function handlers(src) {
  const code = codeOnly(src);
  const out = [];
  const add = (method, extent, wrapper) => {
    if (!HTTP.includes(method) || !extent || out.some((h) => h.method === method)) return;
    out.push({ method, start: extent[0], end: extent[1], ...(wrapper ? { wrapper } : {}) });
  };
  const local = (name) => localHandler(src, name, code);
  // export async function GET(…) / export const POST = …
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Z]+)\s*\(/g)) add(m[1], functionExtent(src, m[1]));
  for (const m of code.matchAll(/\bexport\s+const\s+([A-Z]+)\s*(?::[^=]+)?=\s*(?:([\w$]+)\s*\(|([\w$]+)\s*;?\s*$)?/gm)) {
    if (!HTTP.includes(m[1])) continue;
    const line = lineOf(src, m.index);
    // export const POST = inspect;   (an alias of a local handler)
    const alias = m[3] && local(m[3]);
    if (alias) { add(m[1], alias.extent, alias.wrapper); continue; }
    const wrapped = m[2] && !/^(?:async|function)$/.test(m[2]);
    // export const GET = withAuth(async (req) => …): the handler is the whole statement.
    const st = wrapped ? statementLines(src, code, m.index) : null;
    add(m[1], st ? [st.start, st.end] : functionExtent(src, m[1]) ?? [line, line]);
    if (wrapped) out.find((h) => h.method === m[1]).wrapper = m[2];
  }
  // export { handler as GET, POST }
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}(?!\s*from)/g))
    for (const part of m[1].split(",")) {
      const [name, exported = name] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
      const l = HTTP.includes(exported) ? local(name) : null;
      if (HTTP.includes(exported)) add(exported, l?.extent ?? [lineOf(src, m.index), lineOf(src, m.index)], l?.wrapper);
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
  let wrapper;
  if (!name) {
    const e = code.match(/\bexport\s+default\s+([\w$.]+)\s*(?:\(\s*([\w$]+)\s*[,)])?/);
    if (!e) return null;
    name = e[2] ?? e[1]; // withAuth(handler) -> handler
    if (e[2] || new RegExp(`^${e[1].replace(/[.$]/g, "\\$&")}\\s*\\(`).test(code.slice(e.index).replace(/^export\s+default\s+/, ""))) wrapper = e[1];
  }
  let ext = functionExtent(named, name);
  if (!ext) {
    // Handed to a library (`export default NextAuth(authOptions)`) or a wrapper given the
    // handler inline (`export default withTeamApi(async (…) => …)`): the whole statement.
    const at = code.search(/\bexport\s+default\b/);
    if (at < 0) return null;
    const st = statementLines(src, code, at);
    const lines = src.split("\n").slice(st.start - 1, st.end).join("\n");
    return { start: st.start, end: st.end, body: wrapper ? lines : "", wrapper };
  }
  const lines = src.split("\n").slice(ext[0] - 1, ext[1]).join("\n");
  return { start: ext[0], end: ext[1], body: lines, wrapper: wrapper !== name ? wrapper : undefined };
}

/**
 * The methods a pages/api handler answers: those an early exit lets through
 * (`if (req.method !== "POST") return …`), else those it compares (`req.method === "GET"`,
 * `case "POST":` in a switch on the method), else every method (ALL).
 */
function pagesMethods(body) {
  const code = codeOnly(body.replace(/["']([A-Z]+)["']/g, (m, x) => `__${x}__`)); // keep the method names through blanking
  const alias = /\{[^=;]*\bmethod\b[^=;]*\}\s*=\s*req\b/.test(code) ? "(?:req\\.method|\\bmethod)" : "req\\.method";
  const M = "(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)";
  // An early exit bounds the methods only when it turns the request away (a 4xx, often
  // 405 / METHOD_NOT_ALLOWED); a negated check that does the work instead is a branch.
  for (const neg of code.matchAll(new RegExp(`if\\s*\\(\\s*${alias}\\s*!==?\\s*__${M}__((?:\\s*&&\\s*${alias}\\s*!==?\\s*__${M}__)*)\\s*\\)`, "g"))) {
    const after = code.slice(neg.index + neg[0].length);
    let body = after.split(/\n|;/)[0];
    if (after.trimStart().startsWith("{")) { // the block, to its matching brace
      const open = after.indexOf("{");
      let depth = 0, i = open;
      for (; i < after.length; i++) { if (after[i] === "{") depth++; else if (after[i] === "}" && --depth === 0) break; }
      body = after.slice(open, i + 1);
    }
    const st = body.search(/status\s*\(\s*(?:4\d\d|[\w.]*METHOD_NOT_ALLOWED|[\w.]*MethodNotAllowed)\b/);
    if (st >= 0 && !/\bif\s*\(/.test(body.slice(0, st)) && /\breturn\b|\.end\s*\(/.test(body)) { // the branch's own answer, not a nested check
      // Methods handled in their own blocks before the exit get through too.
      const before = [...code.slice(0, neg.index).matchAll(new RegExp(`${alias}\\s*===?\\s*__${M}__`, "g"))].map((m) => m[1]);
      return [...new Set([...before, ...[...neg[0].matchAll(new RegExp(`__${M}__`, "g"))].map((m) => m[1])])];
    }
  }
  const pos = new Set([...code.matchAll(new RegExp(`${alias}\\s*===?\\s*__${M}__`, "g"))].map((m) => m[1]));
  if (new RegExp(`switch\\s*\\(\\s*${alias}\\s*\\)`).test(code)) for (const m of code.matchAll(new RegExp(`case\\s+__${M}__\\s*:`, "g"))) pos.add(m[1]);
  // After the last method check, a handler that goes on to serve the request (`return
  // tusServer.handle(req, res)`) answers every method, not only the ones it singled out.
  if (pos.size && servesTheRest(code, alias, M)) return ["ALL"];
  return pos.size ? [...pos] : ["ALL"];
}

/** Whether a handler returns something other than a rejection after its last method check. */
function servesTheRest(code, alias, M) {
  let end = -1;
  for (const m of code.matchAll(new RegExp(`(?:if\\s*\\(\\s*${alias}\\s*===?\\s*__${M}__[^)]*\\)|switch\\s*\\(\\s*${alias}\\s*\\))\\s*`, "g"))) {
    let i = m.index + m[0].length;
    if (code[i] === "{") { let d = 0; for (; i < code.length; i++) { if (code[i] === "{") d++; else if (code[i] === "}" && --d === 0) break; } }
    else i = code.indexOf(";", i);
    if (i > end) end = i;
  }
  if (end < 0) return false;
  const rest = code.slice(end + 1);
  return /\breturn\b\s*[^;\s}]/.test(rest) && !/status\s*\(\s*4\d\d|status\s*:\s*4\d\d|METHOD_NOT_ALLOWED|MethodNotAllowed|Not Allowed/i.test(rest);
}

/**
 * A pages/api handler that hands each method to its own function: `if (req.method === "GET")
 * return getHandler(req, res)` or `case "PUT": return putHandler(…)`. Method -> local name.
 */
function pagesDispatch(body) {
  const code = codeOnly(body.replace(/["']([A-Z]+)["']/g, (m, x) => `__${x}__`));
  const alias = /\{[^=;]*\bmethod\b[^=;]*\}\s*=\s*req\b/.test(code) ? "(?:req\\.method|\\bmethod)" : "req\\.method";
  const call = "\\{?\\s*return\\s+(?:await\\s+)?([\\w$]+)\\s*\\(";
  const out = {};
  for (const m of code.matchAll(new RegExp(`${alias}\\s*===?\\s*__([A-Z]+)__\\s*\\)\\s*${call}`, "g"))) out[m[1]] ??= m[2];
  for (const m of code.matchAll(new RegExp(`case\\s+__([A-Z]+)__\\s*:\\s*${call}`, "g"))) out[m[1]] ??= m[2];
  return out;
}

/**
 * Each method's own code in a pages/api handler, as lines of its body (1-based): the block of
 * `if (req.method === "GET") { … }`, or a `case "PUT":` up to the next case or the switch's end.
 */
function pagesBlocks(body) {
  const code = codeOnly(body.replace(/["']([A-Z]+)["']/g, (m, x) => `__${x}__`)); // lines don't move
  const alias = /\{[^=;]*\bmethod\b[^=;]*\}\s*=\s*req\b/.test(code) ? "(?:req\\.method|\\bmethod)" : "req\\.method";
  const lineAt = (i) => code.slice(0, i).split("\n").length;
  const close = (open) => { let d = 0; for (let i = open; i < code.length; i++) { if (code[i] === "{") d++; else if (code[i] === "}" && --d === 0) return i; } return -1; };
  const out = {};
  for (const m of code.matchAll(new RegExp(`if\\s*\\(\\s*${alias}\\s*===?\\s*__([A-Z]+)__\\s*\\)\\s*\\{`, "g"))) {
    const end = close(m.index + m[0].length - 1);
    if (end > 0) out[m[1]] ??= [lineAt(m.index), lineAt(end)];
  }
  for (const sw of code.matchAll(new RegExp(`switch\\s*\\(\\s*${alias}\\s*\\)\\s*\\{`, "g"))) {
    const open = sw.index + sw[0].length - 1, end = close(open);
    if (end < 0) continue;
    const inner = code.slice(open, end);
    const cases = [...inner.matchAll(/\b(?:case\s+__([A-Z]+)__|default)\s*:/g)];
    cases.forEach((c, i) => {
      if (!c[1]) return;
      // Fall-through cases (`case "GET": case "HEAD":`) share the next case's code.
      let j = i; while (j + 1 < cases.length && /^\s*$/.test(inner.slice(cases[j].index + cases[j][0].length, cases[j + 1].index))) j++;
      const stop = j + 1 < cases.length ? lineAt(open + cases[j + 1].index) - 1 : lineAt(end) - 1;
      out[c[1]] ??= [lineAt(open + c.index), Math.max(stop, lineAt(open + c.index))];
    });
  }
  return out;
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

/**
 * An object literal's top-level entries, from its text between the braces: each key as written
 * (`"DELETE": f`, `GET,` shorthand, `async PATCH(…) {}`), and whether it spreads another object.
 */
function topLevelKeys(raw) {
  const parts = [];
  let depth = 0, cur = "", quote = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) { cur += c; if (c === quote && raw[i - 1] !== "\\") quote = null; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  const entries = parts.map((x) => x.replace(/^\s*(?:\/\/[^\n]*\n\s*)*/, "").trim()).filter(Boolean);
  return {
    spread: entries.some((x) => x.startsWith("...")),
    keys: entries.map((x) => x.match(/^(?:async\s+)?["']?([\w$]+)["']?\s*(?:[:(]|$)/)?.[1]).filter(Boolean),
  };
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
      else if (!out.some((a) => a.name === m[1])) out.push({ name: m[1], ...statementLines(src, code, m.index), wrapper: code.slice(m.index + m[0].length).match(/^([A-Za-z_$][\w$]*)/)?.[1] });
    }
  }
  for (const m of src.matchAll(/(?:\bfunction\s+([\w$]+)\s*\([^)]*\)\s*(?::[^{]+)?|\b(?:const|let)\s+([\w$]+)\s*=\s*async\s*\([^)]*\)\s*(?::[^=]+)?=>\s*)\{\s*["']use server["']/g)) add(m[1] ?? m[2]);
  return out.sort((a, b) => a.start - b.start);
}

// ---- guards ----

/** A Next.js matcher (path-to-regexp, with raw regex groups) as a RegExp on a URL path. */
export function matcherRegex(p) {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "(") { // a raw regex group, copied to its matching paren
      let depth = 0, j = i;
      for (; j < p.length; j++) { if (p[j] === "(") depth++; else if (p[j] === ")" && --depth === 0) break; }
      out += p.slice(i, j + 1);
      i = j;
      continue;
    }
    const named = p.slice(i).match(/^\/:([\w$]+)([*+?]?)/);
    if (named) {
      out += named[2] === "*" ? "(?:/.*)?" : named[2] === "+" ? "(?:/.+)" : named[2] === "?" ? "(?:/[^/]+)?" : "/[^/]+";
      i += named[0].length - 1;
      continue;
    }
    out += /[.*+?^${}|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`^${out}$`);
}

/**
 * The app's middleware.ts as a guard: { at, covers(url) } when it can turn a request away (a
 * redirect, a 401/403, Clerk's protect(), Auth.js's `auth` as middleware), else null.
 */
function middlewareGuard(g, dir) {
  for (const n of ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js"]) {
    const f = dir ? `${dir}/${n}` : n;
    const t = textOf(g, f);
    if (t == null) continue;
    const rejects = /\b(?:NextResponse|Response)\s*\.\s*redirect\s*\(|\bredirect\s*\(|\bstatus\s*:\s*40[13]\b|\.protect\s*\(|\bexport\s+default\s+(?:auth|withAuth)\b/.test(codeOnly(t)) || /\bas\s+middleware\b/.test(t);
    if (!rejects) return null;
    const m = t.match(/\bmatcher\s*:\s*(\[[\s\S]*?\]|["'`][^"'`]*["'`])/);
    const pats = m ? [...m[1].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]) : [];
    const re = (p) => { try { return matcherRegex(p); } catch { return null; } };
    const res = pats.map(re).filter(Boolean);
    // The paths it turns away inside, when it says: pathname.startsWith(X) / === X (X a literal,
    // a constant or each of a constant array), Clerk's createRouteMatcher([...]) (negated: public).
    const consts = new Map();
    for (const c of t.matchAll(/\bconst\s+([\w$]+)\s*(?::[^=]+)?=\s*(\[[^\]]*\]|["'`][^"'`]*["'`])/g)) consts.set(c[1], [...c[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]));
    const lits = (e) => (/^["'`]/.test(e.trim()) ? [e.trim().slice(1, -1)] : consts.get(e.trim()) ?? []);
    const include = [], exclude = [];
    for (const x of t.matchAll(/\bpathname\s*\.\s*startsWith\s*\(\s*([^)]+?)\s*\)/g)) for (const v of lits(x[1])) include.push((u) => u.startsWith(v));
    for (const x of t.matchAll(/\b([\w$]+)\s*\.\s*some\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*pathname\s*\.\s*startsWith\s*\(\s*\2\s*\)/g)) for (const v of consts.get(x[1]) ?? []) include.push((u) => u.startsWith(v));
    for (const x of t.matchAll(/\bpathname\s*===?\s*(["'`][^"'`]*["'`]|[\w$]+)/g)) for (const v of lits(x[1])) include.push((u) => u === v);
    for (const x of t.matchAll(/\bconst\s+([\w$]+)\s*=\s*createRouteMatcher\s*\(\s*\[([^\]]*)\]/g)) {
      const fits = [...x[2].matchAll(/["'`]([^"'`]*)["'`]/g)].map((y) => re(y[1])).filter(Boolean).map((r) => (u) => r.test(u));
      (new RegExp(`!\\s*${x[1]}\\s*\\(`).test(t) ? exclude : include).push(...fits);
    }
    return { at: `${f}:1`, covers: (url) => (!pats.length || res.some((r) => r.test(url))) && (!include.length || include.some((ok) => ok(url))) && !exclude.some((ok) => ok(url)) };
  }
  return null;
}

// Sign-in checks in a handler: the call, the names it binds, and an early exit when they're missing.
const SIGN_IN = [
  [/\b(?:const|let)\s+(\{[^=]*\}|[\w$]+)\s*=\s*(?:await\s+)?auth\s*\(\s*\)/g, "auth()"],
  [/\b(?:const|let)\s+(\{[^=]*\}|[\w$]+)\s*=\s*(?:await\s+)?getServerSession\s*\(/g, "getServerSession()"],
  [/\b(?:const|let)\s+(\{[^=]*\}|[\w$]+)\s*=\s*(?:await\s+)?currentUser\s*\(\s*\)/g, "currentUser()"],
  [/\b(?:const|let)\s+(\{[^=]*\}|[\w$]+)\s*=\s*(?:await\s+)?[\w$.]*\bauth\s*\.\s*getUser\s*\(/g, "supabase.auth.getUser()"],
];
/** The sign-in checks in a handler's text that turn a caller away: [{ name, line }] (line within the text). */
function signInGuards(text) {
  const out = [];
  for (const [re, name] of SIGN_IN)
    for (const m of text.matchAll(re)) {
      const vars = m[1].startsWith("{") ? [...m[1].matchAll(/[\w$]+/g)].map((x) => x[0]).filter((v) => /^(?:session|user|userId)$/.test(v)) : [m[1]];
      if (exitsIfMissing(text.slice(m.index + m[0].length), vars) && !out.some((o) => o.name === name)) out.push({ name, line: text.slice(0, m.index).split("\n").length });
    }
  return out;
}

/** Whether, after a value is fetched, an if on it being missing leaves: return, throw, redirect, notFound. */
function exitsIfMissing(after, vars) {
  return vars.some((v) => [...after.matchAll(new RegExp(`\\bif\\s*\\([^)]*!\\s*${v.replace(/\$/g, "\\$")}\\b[^)]*\\)\\s*`, "g"))].some((m) => {
    const rest = after.slice(m.index + m[0].length);
    let block = rest.split(/;|\n/)[0];
    if (rest.startsWith("{")) { let d = 0, i = 0; for (; i < rest.length; i++) { if (rest[i] === "{") d++; else if (rest[i] === "}" && --d === 0) break; } block = rest.slice(0, i + 1); }
    return /\breturn\b|\bthrow\b|\bredirect\s*\(|\bnotFound\s*\(|\bunauthorized\s*\(/.test(block);
  }));
}

/**
 * Sign-in checks through the app's own helpers: `const auth = await getAuthenticatedAdmin(teamId)`
 * followed by an exit when it's missing, where the helper (followed 3 deep) checks sign-in.
 * Scoping too, when the helper looks up the caller's membership of the URL's ids.
 */
function helperGuards(g, dir, file, text, params) {
  const out = [];
  for (const m of text.matchAll(/\b(?:const|let)\s+([\w$]+)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    const fn = m[2];
    if (/^(?:auth|getServerSession|currentUser|require|fetch|String|Number|Boolean|parseInt)$/.test(fn) || out.some((o) => o.name === `${fn}()`)) continue;
    if (!exitsIfMissing(text.slice(m.index + m[0].length), [m[1]]) || !checksSignIn(g, dir, file, fn)) continue;
    out.push({ name: `${fn}()`, line: text.slice(0, m.index).split("\n").length, kind: "auth", ...(scopesCaller(g, dir, file, fn, params) ? { scope: "caller" } : {}) });
  }
  return out;
}

/** The body of the function `name` in `src`, skipping TypeScript overload signatures (no body). */
function definitionBody(src, name) {
  const re = new RegExp(`(?:\\bfunction\\s+${name}\\s*[(<]|\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=)`, "g");
  const code = codeOnly(src);
  for (const m of code.matchAll(re)) {
    // A const holds a function only when its value is one: `= async (…) =>`, `= function`.
    if (!m[0].startsWith("function") && !/^\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[\w$]+\s*=>)/.test(code.slice(m.index + m[0].length))) continue;
    const tail = src.slice(m.index);
    const sp = functionSpan(tail, name, { generics: true });
    if (sp && tail.slice(sp.open, sp.open + 1) === "{") return tail.slice(sp.open, sp.close + 1);
  }
  return null;
}

/** Where `name` comes from in `file`: that file when defined there, else the file it's imported from. */
function definitionOf(g, dir, file, name) {
  const src = textOf(g, file) ?? "";
  const body = definitionBody(src, name) ?? constStatement(src, name);
  if (body) return { file, body };
  const imp = [...src.matchAll(/\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].find((m) => m[1].split(",").some((x) => x.trim().split(/\s+as\s+/).pop() === name));
  const target = imp && resolveSpec(g, dir, file, imp[2]);
  if (!target) return null;
  const local = imp[1].split(",").map((x) => x.trim().split(/\s+as\s+/)).find((x) => (x[1] ?? x[0]) === name)?.[0] ?? name;
  const t = textOf(g, target) ?? "";
  const b = definitionBody(t, local) ?? constStatement(t, local);
  return b ? { file: target, body: b } : null;
}

/** The text of `const name = …` (a client built by a chain, `createSafeActionClient().use(…)`), or null. */
function constStatement(src, name) {
  const code = codeOnly(src);
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=`).exec(code);
  if (!m) return null;
  const { start, end } = statementLines(src, code, m.index);
  return src.split("\n").slice(start - 1, end).join("\n");
}

// Turning a caller away: a 401/403 answer, a redirect to a sign-in page, an Unauthorized error.
const REJECT = /\bstatus\s*:\s*40[13]\b|\.status\s*\(\s*40[13]\s*\)|\bunauthori[sz]ed\s*\(|\bnew\s+Unauthori[sz]ed\w*\s*\(/i;
// An if on a missing user/session that leaves: if (!user) { throw … } / if (!session?.user) throw …
const MISSING_USER = /\bif\s*\(\s*!\s*(?:user|session|userId|currentUser|ctx\.user)\b[^)]*\)\s*(?:\{[^}]*?)?\b(?:throw|return|redirect\s*\()/;
const CREDENTIAL_CHECK = /^(?:validate|verify|assert|require|authenticate|check)\w*(?:ApiKey|Auth|Token|Session|User|Secret|Signature|Key)\w*$/i;
const REJECT_REDIRECT = /\bredirect\s*\(\s*(?:new\s+URL\s*\(\s*)?["'`][^"'`]*(?:login|sign-?in|auth)/i;

/** Text with every catch block blanked (same length, lines kept). */
function withoutCatch(text) {
  const code = codeOnly(text);
  let out = text;
  for (const m of code.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    let d = 0, i = m.index + m[0].length - 1;
    for (; i < code.length; i++) { if (code[i] === "{") d++; else if (code[i] === "}" && --d === 0) break; }
    out = out.slice(0, m.index) + out.slice(m.index, i + 1).replace(/[^\n]/g, " ") + out.slice(i + 1);
  }
  return out;
}

/** Whether the function `name`, used in `file`, turns a caller away, itself or through the functions it hands the request to. */
function checksSignIn(g, dir, file, name, depth = 3, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const def = definitionOf(g, dir, file, name);
  if (!def) return false;
  // A credential check by name that throws (validateApiKey, verifyToken, requireUser…): the
  // thrown error becomes the 401 somewhere else.
  if (CREDENTIAL_CHECK.test(name) && /\bthrow\b/.test(codeOnly(def.body))) return true;
  // A 401 in a catch block translates a thrown error; it doesn't check sign-in.
  const body = withoutCatch(def.body);
  if (REJECT.test(codeOnly(body)) || REJECT_REDIRECT.test(body) || signInGuards(body).length || MISSING_USER.test(codeOnly(body))) return true;
  if (depth <= 1) return false;
  const names = new Set([...codeOnly(def.body).matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]).filter((n) => n !== name && /[a-z]/.test(n) && !/^(?:return|const|let|await|async|function|if|else|new|typeof|undefined|null|true|false|this)$/.test(n)));
  return [...names].some((n) => checksSignIn(g, dir, def.file, n, depth - 1, seen));
}

/** A user id: the caller's, as code that looks one up names it. */
const USER_ID = /\buserId\b|\buser_id\b|\buser\??\.id\b/;
const USER_COLUMN = /\b\w+\.user_?[iI]d\b|\buser_id\b/;
const LOOKUP = /\b(?:where|findUnique|findFirst|findMany|eq|match)\b/;

/**
 * Whether wrapper `name` (followed into what it calls, 3 deep) looks up a record by the
 * caller's user id together with one of the URL's ids: a membership check
 * (`userTeam.findUnique({ where: { userId_teamId: { userId, teamId } } })`) scopes the route;
 * so does one that loads the caller's own record from another table (`getTeamForUser()`).
 */
function scopesCaller(g, dir, file, name, params, depth = 3, seen = new Set()) {
  const key = `${file}#${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const def = definitionOf(g, dir, file, name);
  if (!def) return false;
  const code = codeOnly(def.body);
  for (const st of code.split(";")) {
    if (!LOOKUP.test(st)) continue;
    // With ids in the URL: a lookup pairing the caller with one of them. Without: the caller's own
    // record from another table, keyed by its user-id column (the wrapper hands it to the handler).
    if (params.length ? USER_ID.test(st.replace(/\buserId_\w+/g, "")) && params.some((p) => new RegExp(`\\b${p}\\b`).test(st)) : USER_COLUMN.test(st)) return true;
  }
  if (depth <= 1) return false;
  const names = new Set([...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]).filter((n) => n !== name && !/^(?:if|for|while|switch|return|function|catch|typeof)$/.test(n)));
  return [...names].some((n) => scopesCaller(g, dir, def.file, n, params, depth - 1, seen));
}

/** The guard a wrapper is, when it checks sign-in; marked as scoping when it checks membership of the URL's ids. */
function wrapperGuard(g, dir, file, name, line, urlPath) {
  if (!name || !checksSignIn(g, dir, file, name)) return [];
  const params = [...urlPath.matchAll(/:(\w+)/g)].map((m) => m[1]);
  return [{ name, at: `${file}:${line}`, kind: "auth", ...(scopesCaller(g, dir, file, name, params) ? { scope: "caller" } : {}) }];
}

/** The function a pages handler ends by handing the request to: `return (await) name(req, res, …)` as its last statement. */
function handedOn(body) {
  return codeOnly(body).match(/\breturn\s+(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\s*,\s*res\b[^;]*?\)\s*;?\s*\}\s*;?\s*$/)?.[1] ?? null;
}

/** Where a pages handler's delegate lives: `{ file, h }` with its lines and body, local, a default import or a named one. */
function delegate(g, dir, file, name) {
  const src = textOf(g, file) ?? "";
  const lines = (t, ext) => ({ start: ext[0], end: ext[1], body: t.split("\n").slice(ext[0] - 1, ext[1]).join("\n") });
  const here = functionExtent(src, name);
  if (here) return { file, h: lines(src, here) };
  const def = src.match(new RegExp(`\\bimport\\s+${name.replace(/\$/g, "\\$")}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*["']([^"']+)["']`));
  const named = [...src.matchAll(/\bimport\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].find((m) => m[1].split(",").some((x) => x.trim().split(/\s+as\s+/).pop() === name));
  const target = def ? resolveSpec(g, dir, file, def[1]) : named ? resolveSpec(g, dir, file, named[2]) : null;
  if (!target) return null;
  const t = textOf(g, target) ?? "";
  if (def) { const h = pagesHandler(t); return h ? { file: target, h } : null; }
  const local = named[1].split(",").map((x) => x.trim().split(/\s+as\s+/)).find((x) => (x[1] ?? x[0]) === name)?.[0] ?? name;
  const ext = functionExtent(t, local);
  return ext ? { file: target, h: lines(t, ext) } : null;
}

/** Guards on each route: its app's middleware for the URLs it covers, and the handler's sign-in checks. */
function addGuards(g, routes) {
  const dirs = appDirs(g);
  const mws = new Map(dirs.map((d) => [d, middlewareGuard(g, d)]));
  const appOf = (file) => dirs.filter((d) => d === "" || file.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0] ?? "";
  for (const r of routes) {
    const mw = mws.get(appOf(r.file));
    if (mw) {
      // An action is covered as the page that posts to it; one outside app/ only when every URL is.
      const url = r.method === "ACTION" ? (/^\/_action\/[^/]+\/[^/]+$/.test(r.path) ? null : r.path.replace(/\/_action\/[^/]+$/, "") || "/") : r.path;
      if (url != null ? mw.covers(url) : mw.covers("/") && mw.covers("/__any__")) r.guards.push({ name: "middleware", at: mw.at });
    }
    const lines = (textOf(g, r.file) ?? "").split("\n");
    const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    for (const [a, b] of [...(r.context ? [r.context] : []), [r.start, r.end]]) {
      const text = lines.slice(a - 1, b).join("\n");
      for (const s of signInGuards(text)) r.guards.push({ name: s.name, at: `${r.file}:${a + s.line - 1}` });
      for (const h of helperGuards(g, appOf(r.file), r.file, text, params))
        if (!r.guards.some((x) => x.name === h.name)) r.guards.push({ name: h.name, at: `${r.file}:${a + h.line - 1}`, kind: h.kind, ...(h.scope ? { scope: h.scope } : {}) });
    }
  }
  return routes;
}

function nextRoutes(g) {
  const routes = [];
  for (const dir of appDirs(g)) {
    const base = basePathOf(g, dir);
    const prefix = dir ? `${dir}/` : "";
    const nested = appDirs(g).filter((d) => d !== dir && (dir === "" || d.startsWith(`${dir}/`)));
    for (const f of g.files ?? []) {
      if (!f.startsWith(prefix) || ignored(f) || !SRC.test(f)) continue;
      if (nested.some((d) => f.startsWith(`${d}/`))) continue; // a nested app's file is that app's
      const rel = f.slice(prefix.length);
      const api = rel.match(/^(?:src\/)?pages\/(api(?:\/.*)?)\.[cm]?[jt]sx?$/);
      if (api) {
        const segs = api[1].split("/");
        if (segs.at(-1) === "index") segs.pop();
        if (segs.some((s) => s.startsWith("_"))) continue;
        const url = (base + appPath(segs)).replace(/(.)\/$/, "$1") || "/";
        // `export { default } from "@/ee/…"` / `export { handler as default } from "…"`: the
        // handler is in the file it re-exports.
        let file = f;
        const own = textOf(g, f) ?? "";
        const re = own.match(/\bexport\s*\{\s*(?:default|([\w$]+)\s+as\s+default)\s*\}\s*from\s*["']([^"']+)["']/);
        if (re) file = resolveSpec(g, dir, f, re[2]) ?? f;
        let h = null;
        if (re?.[1] && file !== f) {
          const ext = functionExtent(textOf(g, file) ?? "", re[1]);
          if (ext) h = { start: ext[0], end: ext[1], body: (textOf(g, file) ?? "").split("\n").slice(ext[0] - 1, ext[1]).join("\n") };
        }
        // A verb map (`export default defaultHandler({ GET: …, POST: … })`) answers its verbs.
        const ownCode = codeOnly(own);
        const vm = ownCode.match(/\bexport\s+default\s+[\w$.]+\s*\(\s*\{/);
        if (!re && vm) {
          const obj = ownCode.slice(vm.index + vm[0].length - 1);
          let depth = 0, end = 0;
          for (; end < obj.length; end++) { if (obj[end] === "{") depth++; else if (obj[end] === "}" && --depth === 0) break; }
          // Keys as written (quoted "DELETE", shorthand GET, method shorthand async PATCH(…)); a
          // spread (...base) may bring more verbs, so it doesn't narrow.
          const raw = own.slice(vm.index + vm[0].length - 1).slice(1, end);
          const { keys, spread } = topLevelKeys(raw);
          const verbs = spread ? [] : keys.filter((k) => HTTP.includes(k));
          if (verbs.length) {
            const ext = statementLines(own, ownCode, vm.index);
            for (const method of [...new Set(verbs)]) routes.push({ id: `${method} ${url}`, method, path: url, file: f, start: ext.start, end: ext.end, guards: [] });
            continue;
          }
        }
        h ??= pagesHandler(textOf(g, file) ?? "");
        if (!h && re) { const line = (textOf(g, f) ?? "").slice(0, re.index).split("\n").length; h = { start: line, end: line, body: "" }; } // re-exports a file that isn't there
        // A handler that only hands the request on (`return await publishFAQRoute(req, res)`):
        // the route's code is that function, here or in the file it's imported from.
        const del = h?.body && codeOnly(h.body).match(/\)\s*(?::[^{=]+)?(?:=>\s*)?\{\s*(?:return\s+)?(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(\s*req\s*,\s*res\s*\)\s*;?\s*\}\s*;?\s*$/);
        if (del && !h.wrapper) {
          const d = delegate(g, dir, file, del[1]);
          if (d) ({ file, h } = d);
        }
        if (h) {
          const to = pagesDispatch(h.body), blocks = pagesBlocks(h.body), text = textOf(g, file) ?? "", last = handedOn(h.body);
          for (const method of pagesMethods(h.body)) {
            // The function this method is handed to: its own (`case "PUT": return handleUpdate(…)`),
            // or the one the handler ends by handing every request to (`return postHandler(req, res)`).
            const name = to[method] ?? last;
            let own = name && localHandler(text, name), ownFile = file;
            if (!own && name) {
              const d = delegate(g, dir, file, name);
              if (d) (own = { extent: [d.h.start, d.h.end], wrapper: d.h.wrapper }), (ownFile = d.file);
            }
            if (own) {
              // In the same file, the handler's own checks (sign-in, membership) run first: context.
              const context = ownFile === file && (own.extent[1] < h.start || own.extent[0] > h.end) ? { context: [h.start, h.end] } : {};
              routes.push({ id: `${method} ${url}`, method, path: url, file: ownFile, start: own.extent[0], end: own.extent[1], ...context, guards: wrapperGuard(g, dir, ownFile, own.wrapper, own.extent[0], url) });
              continue;
            }
            // A method's own block; what the handler does before any block (sign-in, the
            // caller's id) is its context, read for guards and scoping.
            const block = blocks[method]?.map((n) => h.start + n - 1);
            const first = Math.min(...Object.values(blocks).map(([a]) => h.start + a - 1));
            const context = block && first > h.start ? { context: [h.start, first - 1] } : {};
            routes.push({ id: `${method} ${url}`, method, path: url, file, start: block?.[0] ?? h.start, end: block?.[1] ?? h.end, ...context, guards: wrapperGuard(g, dir, file, h.wrapper, h.start, url) });
          }
        }
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
          const guards = wrapperGuard(g, dir, f, a.wrapper, a.start, url);
          routes.push({ id: `ACTION ${url}`, method: "ACTION", path: url, file: f, start: a.start, end: a.end, guards });
        }
        continue;
      }
      const p = appPath(m[1] ? m[1].split("/") : []);
      if (p == null) continue;
      const url = (base + p).replace(/(.)\/$/, "$1") || "/";
      // `export * from "../other/route"` / `export { GET } from "…"`: the handlers are there.
      let file = f;
      const reAll = (textOf(g, f) ?? "").match(/\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/);
      if (reAll && !handlers(textOf(g, f) ?? "").length) file = resolveSpec(g, dir, f, reAll[1]) ?? f;
      for (const h of handlers(textOf(g, file) ?? "")) {
        const guards = wrapperGuard(g, dir, file, h.wrapper, h.start, url);
        routes.push({ id: `${h.method} ${url}`, method: h.method, path: url, file, start: h.start, end: h.end, guards });
      }
    }
  }
  return { routes: addGuards(g, routes) };
}

// How a Next.js handler answers and reads its request: pages/api handlers use Express's forms;
// route handlers and actions answer with Response / NextResponse, notFound() and redirect().
export const idioms = {
  status: [...expressIdioms.status, /\bstatus\s*:\s*(\d{3})\b/g],
  implicit: /\bres\s*\.\s*(?:json|send|write|end)\s*\(|\b(?:NextResponse|Response)\s*\.\s*json\s*\(|\bnew\s+(?:Next)?Response\s*\(/,
  fixed: [[/\bres\s*\.\s*redirect\s*\(/, 302, true], [/(?<!res\s*\.\s*)\bredirect\s*\(/, 307, true], [/\bnotFound\s*\(\s*\)/, 404, false]],
  body: ["req\\.body"],
  bodyAlias: /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*\(?\s*(?:req\.body\b|await\s+(?:req|request)\s*\.\s*json\s*\(\s*\))/,
  // Fields read straight from a parsed body or a form: `const { name } = await req.json()`, `form.get("email")`.
  // The signed-in caller's identity, used in a query, scopes a record to them.
  // The caller's id: the session's user, or the account a sign-in wrapper put on the request.
  caller: /\bsession\??\.user\??\.id\b|\buser\??\.id\b|\b(?:req|request)\.(?:auth|apiAuth)\b/,
  // Guards that require sign-in, by name.
  authGuard: /^(?:middleware|auth\(\)|getServerSession\(\)|currentUser\(\)|supabase\.auth\.getUser\(\))$/,
  bodyFields: [/\{([^}]*)\}\s*(?::[^=]+)?=\s*await\s+(?:req|request)\s*\.\s*json\s*\(/, /\.get\(\s*["']([\w-]+)["']\s*\)/g],
};

export default { name: "nextjs", detect: (g) => appDirs(g).length > 0, routes: nextRoutes, idioms };
