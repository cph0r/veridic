// Express route inventory: walk the router mount tree from the app entry so every
// route gets its full URL and the guards mounted above it, then give each route
// its handler extent (the full `router.post(...)` call). Ported from
// recover/extract.mjs sections 1-2.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { callExtent, isTestFile, matchParen } from "../graph.mjs";
import { chainsOf, anonymousRouterChains, stringValue } from "../chains.mjs";
import { jsonc, joinPath, dedupe } from "./paths.mjs";

// A route path from a string or template literal: `/${page}` becomes /:page.
const routePathOf = (raw) => {
  const lit = (r) => stringValue(r) ?? r.match(/^`([^`]*)`$/)?.[1]?.replace(/\$\{\s*(?:[\w$.]*\.)?([\w$]+)[^}]*\}/g, ":$1") ?? null;
  // `startPath ?? `${base}/start``: an optional override with a default.
  return lit(raw) ?? (/\?\?/.test(raw) ? lit(raw.slice(raw.lastIndexOf("??") + 2).trim()) : null);
};

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

function expressRoutes(g, { entry } = {}) {
  // A relative import's file, among the files the index knows.
  const resolveRel = (from, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/\.[cm]?js$/, "");
    return [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"].map((e) => base + e)].find((x) => g.text(x) != null) ?? null;
  };
  // The paths a constant holds: "…", ["…", "…"] (as const), or OTHER.map((p) => p.replace(/re/, "s")),
  // in this file or imported from another.
  const constPaths = (file, name, depth = 0) => {
    if (depth > 3) return null;
    const src = g.text(file) ?? "";
    const m = src.match(new RegExp(`\\b(?:export\\s+)?const\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*([^;\\n]+)`));
    if (!m) {
      const im = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].find((x) => x[1].split(",").some((p) => p.trim().split(/\s+as\s+/).pop() === name));
      const target = im && resolveRel(file, im[2]);
      if (!target) return null;
      const local = im[1].split(",").map((p) => p.trim().split(/\s+as\s+/)).find((p) => (p[1] ?? p[0]) === name)?.[0] ?? name;
      return constPaths(target, local, depth + 1);
    }
    const v = m[1].trim().replace(/\s+as\s+const\s*$/, "").replace(/;$/, "");
    const one = stringValue(v);
    if (one != null) return [one];
    if (/^\[[\s\S]*\]$/.test(v)) { const xs = [...v.matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]); return xs.length ? xs : null; }
    const mm = v.match(/^([\w$]+)\.map\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*\2\.replace\(\s*\/((?:\\\/|[^/])+)\/(\w*)\s*,\s*["'`]([^"'`]*)["'`]\s*\)\s*\)$/);
    if (mm) return constPaths(file, mm[1], depth + 1)?.map((p) => p.replace(new RegExp(mm[3], mm[4]), mm[5])) ?? null;
    return null;
  };
  const exists = (rel) => fs.existsSync(path.join(g.repo, rel)) && fs.statSync(path.join(g.repo, rel)).isFile();
  const withExt = (base) => {
    base = base.replace(/\.[cm]?js$/, "");
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, "index.ts"), path.join(base, "index.js")]) if (exists(c)) return c;
    return null;
  };
  // TypeScript path aliases (`"@/*": ["src/*"]`) from the nearest tsconfig.json or jsconfig.json.
  const aliasCache = new Map();
  const aliasesFor = (fromFile) => {
    for (let dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
      if (aliasCache.has(dir)) return aliasCache.get(dir);
      for (const name of ["tsconfig.json", "jsconfig.json"]) {
        const rel = dir === "." ? name : path.join(dir, name);
        if (!exists(rel)) continue;
        let cfg = {};
        try {
          cfg = JSON.parse(jsonc(fs.readFileSync(path.join(g.repo, rel), "utf8")));
        } catch {}
        const co = cfg.compilerOptions ?? {};
        const baseUrl = path.join(dir, co.baseUrl ?? ".");
        const list = Object.entries(co.paths ?? {}).map(([k, v]) => ({ prefix: k.replace(/\*$/, ""), wild: k.endsWith("*"), to: v.map((t) => path.join(baseUrl, t.replace(/\*$/, ""))) }));
        aliasCache.set(dir, list);
        return list;
      }
      if (dir === "." || dir === "/" || dir === "") {
        aliasCache.set(dir, []);
        return [];
      }
    }
  };
  const resolveImport = (fromFile, spec) => {
    if (spec.startsWith(".")) return withExt(path.join(path.dirname(fromFile), spec));
    for (const a of aliasesFor(fromFile)) {
      if (!(a.wild ? spec.startsWith(a.prefix) : spec === a.prefix)) continue;
      for (const t of a.to) {
        const hit = withExt(a.wild ? path.join(t, spec.slice(a.prefix.length)) : t);
        if (hit) return hit;
      }
    }
    return null;
  };

  // local name -> { file, name } where name is the exported binding ("default" or a named export)
  const importsOf = (file) => {
    const map = {};
    const src = g.text(file) ?? "";
    for (const m of src.matchAll(/import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/g)) {
      const target = resolveImport(file, m[2]);
      if (target) map[m[1]] = { file: target, name: "default" };
    }
    // CommonJS: `const x = require("./x")`, `const { a, b: c } = require("./x")`.
    for (const m of src.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const target = resolveImport(file, m[2]);
      if (target) map[m[1]] = { file: target, name: "default" };
    }
    for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const target = resolveImport(file, m[2]);
      if (!target) continue;
      for (const part of m[1].split(",")) {
        const [orig, local = orig] = part.trim().split(/\s*:\s*/).map((x) => x.trim());
        if (local && /^\w+$/.test(local)) map[local] = { file: target, name: orig };
      }
    }
    for (const m of src.matchAll(/import\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
      const target = resolveImport(file, m[2]);
      if (!target) continue;
      for (const part of m[1].split(",")) {
        const [orig, local = orig] = part.trim().split(/\s+as\s+/).map((x) => x.trim());
        if (local && /^\w+$/.test(local)) map[local] = { file: target, name: orig };
      }
    }
    return map;
  };
  // The variable a module exports as `name`: `export default router` -> "router".
  const exportVar = (file, name) => {
    const src = g.text(file) ?? "";
    if (name !== "default") return name;
    return src.match(/export\s+default\s+(\w+)\s*;?\s*$/m)?.[1] ?? src.match(/module\.exports\s*=\s*(\w+)\s*;?\s*$/m)?.[1] ?? "*";
  };

  // `.use(...)` calls on v, followed through method chains (`Router().use(a).use("/p", b)`).
  // v = null or "*" takes every `.use(` in the file. A route list mounted in a loop
  // (`[{ path, route }].forEach((r) => router.use(r.path, r.route))`) is expanded.
  const usesOf = (file, v) => {
    const src = g.text(file) ?? "";
    const any = !v || v === "*";
    // A local router mounted inside this file (`Router().use("/api", api)`) is walked from that
    // mount, with its prefix; taking its uses here too would mount its children without it.
    const mountedHere = new Set([...src.matchAll(/\.\s*use\s*\(([^)]*)\)/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())));
    const roots = any ? [...new Set([...src.matchAll(/([\w$]+)\s*\.\s*use\s*\(/g)].map((m) => m[1]).concat([...localRouters(file)], appVars(file)))].filter((r) => !(localRouters(file).has(r) && mountedHere.has(r))) : [v];
    const chains = [...chainsOf(src, roots), ...(any ? anonymousRouterChains(src) : [])];
    const out = [];
    const seen = new Set();
    for (const ch of chains) {
      for (const c of ch.calls) {
        if (c.name !== "use") continue;
        const key = `${c.line}:${c.args.map((a) => a.text).join(",")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const first = c.args[0]?.raw ?? "";
        const prefix = (/^["'`]/.test(first) ? routePathOf(first) : null) ?? "";
        const rest = c.args.slice(/^["'`]/.test(first) ? 1 : 0);
        // A folder mounted file by file: use(`/${f}`, require(`./${f}`)) inside readdirSync(...).
        const tplVar = first.match(/^`\/\$\{\s*([\w$]+)\s*\}`$/)?.[1];
        const tplReq = tplVar && rest.find((a) => new RegExp(`require\\(\\s*\`\\.\\/\\$\\{\\s*${tplVar}\\s*\\}\\s*\``).test(a.raw));
        if (tplReq) {
          const dir = path.posix.dirname(file);
          const mountedElsewhere = new Set([...src.matchAll(/require\(\s*["']\.\/([\w.-]+)["']\s*\)/g)].map((m) => m[1].replace(/\.[cm]?[jt]s$/, "")));
          for (const f of sourceFiles.filter((x) => path.posix.dirname(x) === dir && x !== file && !/(^|\/)index\.[cm]?[jt]s$/.test(x))) {
            const base = path.posix.basename(f).replace(/\.[cm]?[jt]s$/, "");
            if (!mountedElsewhere.has(base)) out.push({ line: c.line, prefix: `/${base}`, idents: [], mounts: [{ file: f }] });
          }
          continue;
        }
        const pathArg = rest.length === 2 && rest[0].text.match(/^(\w+)\.(\w+)$/);
        const routeArg = rest.length === 2 && rest[1].text.match(/^(\w+)\.(\w+)$/);
        if (!prefix && pathArg && routeArg && pathArg[1] === routeArg[1]) {
          for (const e of loopEntries(src, c.line, pathArg[1], pathArg[2], routeArg[2])) out.push({ line: c.line, prefix: e.prefix, idents: [e.ident] });
          continue;
        }
        // Routers handed over as `require("./x")` or built by a call, `inventoryRouter(path)`.
        const mounts = [];
        for (const a of rest) {
          const req = a.raw.match(/^require\(\s*["'](\.[^"']+)["']\s*\)(?:\.(\w+))?$/);
          if (req) mounts.push({ spec: req[1], name: req[2] ?? "default" });
          else {
            const call = a.text.match(/^(?:await\s+)?([\w$]+)\s*\(/);
            if (call && !/^(require|express|json|urlencoded|static)$/.test(call[1])) mounts.push({ factory: call[1] });
          }
        }
        out.push({ line: c.line, prefix, idents: rest.map((a) => a.text).filter((t) => /^\w+$/.test(t)), mounts });
      }
    }
    return out;
  };
  // Entries of `LIST.forEach((item) => …)` where LIST = [{ <pathKey>: "/x", <routeKey>: ident }, …].
  const loopEntries = (src, line, item, pathKey, routeKey) => {
    // The loop this `.use(` sits in: the last `LIST.forEach((item)` before its line.
    const upTo = src.split("\n").slice(0, line).join("\n");
    const list = [...upTo.matchAll(new RegExp(`(\\w+)\\s*\\.\\s*forEach\\s*\\(\\s*\\(?\\s*${item}\\b`, "g"))].pop()?.[1];
    if (!list) return [];
    const at = src.search(new RegExp(`\\b${list}\\s*=\\s*\\[`));
    if (at < 0) return [];
    const body = src.slice(at, src.indexOf("];", at) + 1);
    return [...body.matchAll(/\{([^{}]*)\}/g)]
      .map((o) => ({ prefix: o[1].match(new RegExp(`\\b${pathKey}\\s*:\\s*["'\`]([^"'\`]+)["'\`]`))?.[1], ident: o[1].match(new RegExp(`\\b${routeKey}\\s*:\\s*(\\w+)`))?.[1] }))
      .filter((e) => e.prefix && e.ident);
  };

  // Routers created in a file: `const workspace = Router()` / `express.Router(...)`.
  const localRouters = (file) =>
    new Set([...(g.text(file) ?? "").matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g)].map((m) => m[1]));
  // Whether middleware named `id` in `file` can turn a request away: a 4xx response, a throw,
  // or an error handed to next(). Its body runs to the next top-level declaration.
  const rejects = (file, id) => {
    const src = g.text(file) ?? "";
    const at = src.search(new RegExp(`(?:function\\s+${id}\\b|\\b(?:const|let|var)\\s+${id}\\b)`));
    if (at < 0) return true; // can't see it: keep it, as before
    const rest = src.slice(at + 1);
    const end = rest.search(/\n(?:export\s|function\s|const\s|let\s|class\s)/);
    const body = rest.slice(0, end < 0 ? undefined : end);
    return /\b(?:status|sendStatus)\s*\(\s*4\d\d|\bthrow\b|\bnext\s*\(\s*(?:new\b|err|e\b|error|createError)|\bres\s*\.\s*redirect\s*\(/.test(body);
  };
  // `app`, `router` or `server` handed in as a function parameter: `(app) => …`, `({ app }) => …`.
  const paramVars = (file) => {
    const src = g.text(file) ?? "";
    return ["app", "router", "server"].filter((v) => new RegExp(`(?:function\\s*\\w*\\s*\\(|\\(|,)\\s*(?:\\{[^}]*\\b${v}\\b[^}]*\\}|${v}\\b)[^)]*\\)\\s*(?::[^={]+)?(?:=>|\\{)`).test(src));
  };
  // The app variables an entry file creates: `const app = express()`.
  const appVars = (file) => [...(g.text(file) ?? "").matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*express\s*\(/g)].map((m) => m[1]);
  // Name of parameter #i of function `fn` defined in `file` (function declaration or arrow).
  const paramName = (file, fn, i) => {
    const src = g.text(file) ?? "";
    const m =
      src.match(new RegExp(`function\\s+${fn}\\s*\\(([^)]*)\\)`)) ??
      src.match(new RegExp(`\\b${fn}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(([^)]*)\\)\\s*(?::[^=]+)?=?>?`));
    if (!m) return null;
    return m[1].split(",").map((p) => p.trim().replace(/[:=?].*$/s, "").trim())[i] ?? null;
  };
  // Where a name is really defined, following barrel re-exports (`export { x } from "./x"`, `export * from`).
  const resolveExport = (file, name, depth = 0) => {
    const src = g.text(file) ?? "";
    if (depth > 3 || new RegExp(`(?:function\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\b)`).test(src)) return file;
    for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*["'](\.[^"']+)["']/g)) {
      const parts = m[1].split(",").map((x) => x.trim().split(/\s+as\s+/));
      const hit = parts.find((p) => (p[1] ?? p[0]) === name);
      const target = hit && resolveImport(file, m[2]);
      if (target) return resolveExport(target, hit[0], depth + 1);
    }
    for (const m of src.matchAll(/export\s*\*\s*from\s*["'](\.[^"']+)["']/g)) {
      const target = resolveImport(file, m[1]);
      const found = target && resolveExport(target, name, depth + 1);
      if (found && new RegExp(`(?:function\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\b)`).test(g.text(found) ?? "")) return found;
    }
    return file;
  };
  // Mount the router a factory returns: `createAuthRouter(name)` imported, re-exported or local.
  const factoryTarget = (file, fn, imports) => {
    const imp = imports[fn];
    if (!imp) return { target: file, name: fn };
    const name = imp.name === "default" ? exportVar(imp.file, "default") : imp.name;
    return { target: name === "*" ? imp.file : resolveExport(imp.file, name), name };
  };
  // A variable holding a factory's router: `authRouter = createLocalAuthRouter(p)` (every assignment).
  const factoryAssigned = (file, id) => [...new Set([...(g.text(file) ?? "").matchAll(new RegExp(`\\b${id}\\s*(?::[^=;]+)?=\\s*(?:await\\s+)?([\\w$]+)\\s*\\(`, "g"))].map((m) => m[1]).filter((f) => !/^(Router|express|require)$/.test(f)))];
  // The router a factory function returns: `function inventoryRouter(p) { const router = Router(); …; return router; }`.
  const returnedRouter = (file, fn) => {
    const src = g.text(file) ?? "";
    // fn "*" (an unnamed default export) or a name: find that function, then what it returns.
    const named = /^[\w$]+$/.test(fn) ? `function\\s+${fn}\\b|\\b${fn}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\()|` : "";
    const at = src.search(new RegExp(`(?:${named}export\\s+default\\s+(?:async\\s+)?(?:function|\\())`));
    if (at < 0) return null;
    return src.slice(at).match(/\breturn\s+([\w$]+)\s*;?/)?.[1] ?? null;
  };
  // Registrars called through an object: `const routes = { auth, users }; for (k in routes) routes[k](router)`.
  const objectRegistrars = (file, v) => {
    const src = g.text(file) ?? "";
    const out = [];
    for (const m of src.matchAll(new RegExp(`\\b([\\w$]+)\\s*\\[[^\\]]+\\]\\s*\\(([^()]*)\\)`, "g"))) {
      const args = m[2].split(",").map((x) => x.trim());
      const index = args.indexOf(v);
      if (index < 0) continue;
      const obj = src.match(new RegExp(`\\b(?:const|let|var)\\s+${m[1]}\\b[\\s\\S]{0,300}?=\\s*\\{([^{}]*)\\}`))?.[1];
      for (const part of obj?.split(",") ?? []) {
        const id = part.split(":").pop().trim();
        if (/^[\w$]+$/.test(id)) out.push({ fn: id, index });
      }
    }
    return out;
  };
  // A call's arguments split at top-level commas: `(router, { base: "/x", f: (a, b) => a })`.
  const topLevelArgs = (inner) => {
    const out = [];
    let depth = 0, cur = "", q = null;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (q) { cur += ch; if (ch === q && inner[i - 1] !== "\\") q = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { q = ch; cur += ch; continue; }
      if ("([{".includes(ch)) depth++;
      if (")]}".includes(ch)) depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  // The string values a helper call hands over, by the name its paths use: the
  // properties of an object literal (`{ base: "/admin/jobs" }` -> base), or a string
  // argument by its parameter's name.
  const handedValues = (target, fnName, c, caller) => {
    const subs = {};
    const src = g.text(caller) ?? "";
    // A string literal, or a constant in the calling file that holds one (`const BASE = "/x"`).
    const valueOf = (expr) => {
      const lit = stringValue(expr);
      if (lit != null) return lit;
      if (!/^[\w$]+$/.test(expr)) return null;
      const m = src.match(new RegExp(`\\b(?:const|let|var)\\s+${expr.replace(/\$/g, "\\$")}\\s*(?::[^=;]+)?=\\s*(["'\`])([^"'\`$]*)\\1`));
      return m ? m[2] : null;
    };
    c.args.forEach((a, i) => {
      if (i === c.index) return;
      if (a.startsWith("{")) for (const m of a.matchAll(/([\w$]+)\s*:\s*([^,}\n]+)/g)) { const v = valueOf(m[2].trim()); if (v != null) subs[m[1]] = v; }
      else { const v = valueOf(a); const p = v != null && paramName(target, fnName, i); if (p) subs[p] = v; }
    });
    return subs;
  };
  // Calls that hand the app or router to another function: `registerAuthRoutes(app)`.
  const registrarCalls = (file, v) => {
    if (!v || v === "*") return [];
    const out = [];
    const src = g.text(file) ?? "";
    for (const m of src.matchAll(/\b(\w+)\s*\(/g)) {
      if (/^(use|get|post|put|patch|delete|all|listen|if|while|for|switch|return|function)$/.test(m[1])) continue;
      const open = m.index + m[0].length - 1;
      const close = matchParen(src, open);
      if (close < 0) continue;
      const args = topLevelArgs(src.slice(open + 1, close));
      const i = args.indexOf(v);
      if (i >= 0) out.push({ fn: m[1], index: i, args });
    }
    return out;
  };

  // Mounts are keyed by file and router variable: one file may define several
  // routers mounted at different prefixes.
  const makeWalk = () => {
    const mounts = new Map(); // "file#var" -> { file, prefix, guards: [{name, at}] }
    const pathGuards = [];
    const seen = new Set();
    const walk = (file, v, prefix, guards, subs = null) => {
      const key = `${file}#${v ?? "*"}${subs ? `#${JSON.stringify(subs)}` : ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      mounts.set(key, { file, v: v ?? "*", prefix, guards, ...(subs ? { subs } : {}) });
      const imports = importsOf(file);
      const locals = localRouters(file);
      for (const use of usesOf(file, v)) {
        const at = `${file}:${use.line}`;
        if (use.mounts?.length) {
          const mw = use.idents.map((name) => ({ name, at }));
          for (const m of use.mounts) {
            const full = joinPath(prefix, use.prefix);
            if (m.file) walk(m.file, exportVar(m.file, "default"), full, [...guards, ...mw]);
            else if (m.spec) {
              const target = resolveImport(file, m.spec);
              if (target) walk(target, exportVar(target, m.name), full, [...guards, ...mw]);
            } else if (m.factory) {
              const { target, name } = factoryTarget(file, m.factory, imports);
              walk(target, returnedRouter(target, name) ?? "*", full, [...guards, ...mw]);
            }
          }
          if (use.mounts.some((m) => m.file || m.spec || m.factory)) continue;
        }
        // Which arguments are routers: a local router, or an import from a file that defines a
        // router or routes. `app.use(cors, auth, router, notFound)` mounts only `router`.
        // A variable assigned from a router factory is a router too.
        const full0 = joinPath(prefix, use.prefix);
        const assigned = use.idents.filter((id) => !imports[id] && !locals.has(id)).map((id) => [id, factoryAssigned(file, id)]).filter(([, fns]) => fns.length);
        for (const [, fns] of assigned) for (const fn of fns) {
          const { target, name } = factoryTarget(file, fn, imports);
          walk(target, returnedRouter(target, name) ?? "*", full0, guards);
        }
        const candidates = use.idents.filter((id) => imports[id] || (locals.has(id) && id !== v));
        const routerLike = (id) => locals.has(id) || routeFiles.has(imports[id]?.file) || localRouters(imports[id]?.file ?? "").size > 0;
        let routers = candidates.filter(routerLike);
        // When none is plainly a router, the last argument is taken for one, unless it is
        // middleware: `workspace.use(requireAuth, requireWorkspace)` mounts no router, it
        // guards everything the router mounts after it.
        const middleware = (id) => {
          if (/^(?:require|ensure|verify|check|validate|authenticate|authori[sz]e|protect|guard|is[A-Z]|has[A-Z]|can[A-Z])/.test(id)) return true;
          const src = g.text(imports[id]?.file ?? file) ?? "";
          return new RegExp(`(?:function\\s+${id}\\s*\\(\\s*req\\b|\\b${id}\\b\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\s*)?\\(\\s*req\\b)`).test(src);
        };
        if (!routers.length && candidates.length && !middleware(candidates.at(-1))) routers = [candidates.at(-1)];
        const mw = use.idents.filter((id) => !routers.includes(id)).map((name) => ({ name, at }));
        const full = joinPath(prefix, use.prefix);
        for (const routerIdent of routers) {
          if (imports[routerIdent]) {
            const imp = imports[routerIdent];
            walk(imp.file, exportVar(imp.file, imp.name), full, [...guards, ...mw]);
          } else walk(file, routerIdent, full, [...guards, ...mw]); // a router defined in this file
        }
        // Middleware with no router: `router.use(requireJwtAuth)` guards everything under this mount,
        // if it can turn a request away. One that only loads the session and calls next() isn't a guard.
        // A catch-all (`notFound`, an error handler) answers what no route did: it guards nothing.
        const guarding = mw.filter((x) => !/not_?found|error|fallback|catch_?all|404/i.test(x.name) && rejects(imports[x.name]?.file ?? file, x.name));
        if (!routers.length && guarding.length) pathGuards.push({ prefix: full, guards: guarding, at });
      }
      // Registration functions: the app/router passed to an imported (or local) function.
      const receivers = v && v !== "*" ? [v] : appVars(file);
      for (const r of receivers) {
        for (const c of [...registrarCalls(file, r), ...objectRegistrars(file, r)]) {
          const target = imports[c.fn]?.file ?? file;
          const dflt = imports[c.fn]?.name === "default" ? exportVar(target, "default") : null;
          const fnName = imports[c.fn] ? (imports[c.fn].name === "default" ? (dflt && dflt !== "*" ? dflt : c.fn) : imports[c.fn].name) : c.fn;
          const p = paramName(target, fnName, c.index);
          const subs = c.args ? handedValues(target, fnName, c, file) : {};
          if (p && !(target === file && p === r)) walk(target, p, prefix, guards, Object.keys(subs).length ? subs : null);
        }
      }
    };
    return { mounts, pathGuards, walk };
  };

  // Source files from git, not the index: CodeGraph skips some real source (any folder
  // named `build`, for one), and a route there is still a route.
  const sourceFiles = (() => {
    try {
      return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: g.repo, encoding: "utf8", maxBuffer: 64 << 20 })
        .split("\n")
        .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.includes("node_modules/") && !isTestFile(f));
    } catch {
      return g.files;
    }
  })();
  // A route a test declares (a throwaway app in a test) isn't one of the app's routes.
  const routeNodes = [...g.nodes.values()].filter((n) => n.kind === "route" && !n.name.startsWith("USE ") && !isTestFile(n.file));
  // CodeGraph indexes `router.get(...)` and `app.get(...)` only. Add the rest from the
  // source: other router names, and chains (`router.route("/x").get(a).post(b)`).
  const known = new Set(routeNodes.map((n) => `${n.file}|${n.name}`));
  for (const f of sourceFiles) {
    if (!/\.[cm]?[jt]s$/.test(f) || f.includes("node_modules/") || /\.(test|spec)\./.test(f)) continue;
    // Plus any receiver CodeGraph already found routes on in this file (an `app` from elsewhere).
    const indexed = routeNodes.filter((n) => n.file === f).map((n) => (g.lines(f)[n.start - 1] ?? "").match(/([\w$]+)\s*\.\s*(?:get|post|put|patch|delete|head|options|all|route)\s*\(/)?.[1]).filter(Boolean);
    const vars = [...new Set([...localRouters(f), ...appVars(f), ...paramVars(f), ...indexed])];
    if (!vars.length) continue;
    for (const ch of chainsOf(g.text(f) ?? "", vars)) {
      let routePath = null;
      ch.calls.forEach((c, i) => {
        if (c.name === "route") return void (routePath = routePathOf(c.args[0]?.raw ?? ""));
        if (!METHODS.has(c.name)) return;
        const raw = (c.args[0]?.raw ?? "").trim();
        // A path held in a constant: a string, an array (`router.post(ROUTES, …)`), maybe imported.
        const paths = [routePathOf(raw) ?? routePath ?? null];
        // Only when the call has no path of its own (not in a `.route("/x")` chain) can its first argument be one.
        const fromConst = !paths[0] && /^[A-Za-z_$][\w$]*$/.test(raw) ? constPaths(f, raw) : null;
        if (fromConst) paths.splice(0, 1, ...fromConst);
        for (const p of paths) {
          if (!p || !/^[/*]|^:[\w$]+\//.test(p)) continue; // `app.get("env")` reads a setting; `${base}/x` is a path
          const name = `${c.name.toUpperCase()} ${p}`;
          if (known.has(`${f}|${name}`)) continue;
          known.add(`${f}|${name}`);
          const start = i === 0 ? ch.line : c.line;
          // A chain can put several methods on one line (`.post(add).get(list)`): keep
          // this call's own arguments, so its handlers aren't confused with its neighbours'.
          const args = c.args.map((x) => x.raw);
          if (fromConst && args.length) args[0] = JSON.stringify(p); // a path constant isn't middleware
          const n = { id: `veridic:route:${f}:${start}:${name}`, kind: "route", name, file: f, start, end: c.endLine, receiver: ch.root, extent: [start, c.endLine], handlerText: args.join(", ") };
          routeNodes.push(n);
          g.nodes.set(n.id, n);
        }
      });
    }
  }
  const routeFiles = new Set(routeNodes.map((n) => n.file));
  const receiverOf = (n) => n.receiver ?? g.lines(n.file)[n.start - 1]?.match(/(\w+)\s*\.\s*(?:get|post|put|patch|delete|head|options|all|route)\s*\(/)?.[1];
  const lookup = (mounts, file, v) => mounts.get(`${file}#${v}`) ?? mounts.get(`${file}#*`) ?? [...mounts.values()].find((m) => m.file === file);

  // Entry: the candidate app file whose mount tree reaches the most routes. Other
  // candidates are merged in for routes the best one doesn't reach (several apps).
  // Only apps that run or are used count: a code fragment kept as data (sample
  // snippets, fixtures) creates or configures an app but is never started or imported.
  const pkg = (() => {
    try {
      return fs.readFileSync(path.join(g.repo, "package.json"), "utf8");
    } catch {
      return "";
    }
  })();
  const sources = sourceFiles.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !/\.(test|spec)\./.test(f) && !f.includes("node_modules/"));
  const live = (file) => {
    const text = g.text(file) ?? "";
    if (/\.listen\s*\(|createServer\s*\(/.test(text)) return true;
    const stem = file.replace(/\.[cm]?[jt]sx?$/, "");
    if (pkg.includes(stem) || pkg.includes(path.basename(file))) return true;
    const name = path.basename(stem) === "index" ? path.basename(path.dirname(stem)) : path.basename(stem);
    const ref = new RegExp(`["'\`][^"'\`]*\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.[cm]?[jt]s)?["'\`]`);
    return sources.some((f) => f !== file && ref.test(g.text(f) ?? ""));
  };
  const all = entry ? [entry] : entryCandidates(g);
  const running = all.filter(live);
  const candidates = running.length ? running : all;
  const walks = candidates
    .map((c) => {
      const w = makeWalk();
      w.walk(c, null, "", []);
      return { entry: c, ...w, reached: routeNodes.filter((n) => lookup(w.mounts, n.file, receiverOf(n))).length };
    })
    .sort((a, b) => b.reached - a.reached);
  // A candidate another candidate mounts (`app.use("/v1", routes)`) is a router, not an
  // app: walking it on its own would mount its children without the prefix above it.
  const mountedBy = (w) => walks.some((o) => o !== w && [...o.mounts.values()].some((m) => m.file === w.entry && o.entry !== w.entry));
  const apps = walks.filter((w) => !mountedBy(w));
  walks.splice(0, walks.length, ...(apps.length ? apps : walks));
  const mounts = new Map();
  const pathGuards = [];
  for (const w of walks) {
    for (const [k, m] of w.mounts) if (!mounts.has(k)) mounts.set(k, m); // the best entry's mounts win
    pathGuards.push(...w.pathGuards);
  }
  // Files no entry reached that mount imported routers on an app handed in as a parameter
  // (`mountApi(_express) { return _express.use("/api", apiRouter) }`): walk them from there.
  const reachedFiles = new Set([...mounts.values()].map((m) => m.file));
  for (const f of sourceFiles) {
    if (reachedFiles.has(f) || /\.(test|spec)\.|__tests__/.test(f)) continue;
    const src = g.text(f) ?? "";
    const receivers = [...new Set([...src.matchAll(/([\w$]+)\s*\.\s*use\s*\(/g)].map((m) => m[1]))].filter((r) => new RegExp(`[(,]\\s*${r.replace(/\$/g, "\\$")}\\s*[:,)]`).test(src));
    if (!receivers.length) continue;
    const imports = Object.values(importsOf(f)).map((i) => i.file);
    if (!imports.some((t) => routeFiles.has(t) && !reachedFiles.has(t))) continue;
    const w = makeWalk();
    w.walk(f, "*", "", []);
    for (const [k, m] of w.mounts) if (!mounts.has(k) && m.file !== f) mounts.set(k, m);
    pathGuards.push(...w.pathGuards);
  }
  entry = walks[0]?.entry;
  const mountFor = (file, v) => lookup(mounts, file, v);
  // `module.exports = (app) => { app.get("/x") }` or `({ app }) => …`: the app itself is
  // handed in, and an app's own routes carry their full path, so they mount at the root.
  const appParamMount = (n) => {
    const v = receiverOf(n);
    if (!v || !/^(app|server|application)$/.test(v)) return null;
    const src = g.text(n.file) ?? "";
    if (appVars(n.file).includes(v)) return null; // the file builds its own app: an entry, walked already
    const param = new RegExp(`(?:function\\s*\\w*\\s*\\(|\\(|,)\\s*(?:\\{[^}]*\\b${v}\\b[^}]*\\}|${v}\\b)[^)]*\\)\\s*(?::[^={]+)?(?:=>|\\{)`);
    return param.test(src) ? { file: n.file, prefix: "", guards: [] } : null;
  };

  const routes = [];
  // A helper mounted with values (`mountJobRoutes(router, { base })`) is one mount per
  // call; its routes repeat under each, with `:base` replaced by the value handed over.
  const mountsOf = (file, v) => [...mounts.values()].filter((m) => m.file === file && (m.v === v || m.v === "*"));
  const placed = routeNodes.flatMap((n) => {
    const ms = mountsOf(n.file, receiverOf(n));
    if (ms.some((m) => m.subs)) return ms.map((mount) => ({ n, mount }));
    const mount = mountFor(n.file, receiverOf(n)) ?? appParamMount(n);
    return mount ? [{ n, mount }] : []; // else not reachable from the entry: a different app, or a factory-mounted router
  });
  for (const { n, mount } of placed) {
    const [method, rawPath] = n.name.split(" ");
    // Only names the path took from `${…}` are values; a route's own `:id` stays.
    const fromTemplate = mount.subs ? new Set([...(n.handlerText ?? g.lines(n.file).slice(n.start - 1, n.end ?? n.start).join("\n")).matchAll(/\$\{\s*(?:[\w$.]*\.)?([\w$]+)/g)].map((m) => m[1])) : null;
    const localPath = mount.subs ? rawPath.replace(/:([\w$]+)/g, (m, k) => (k in mount.subs && fromTemplate.has(k) ? mount.subs[k].replace(/^\/+|\/+$/g, "") : m)) : rawPath;
    const fullPath = joinPath(mount.prefix, localPath);
    const src = g.text(n.file) ?? "";
    const [start, end] = n.extent ?? callExtent(src, n.start) ?? [n.start, n.end];

    const guards = [
      ...mount.guards,
      ...pathGuards.filter((pg) => pg.prefix === "/" || fullPath === pg.prefix || fullPath.startsWith(`${pg.prefix}/`)).flatMap((pg) => pg.guards),
    ];
    // Inline guards: router.get("/x", requireAuth, async (req, res) => ...)
    const head = g.lines(n.file).slice(start - 1, start + 3).join(" ");
    const inline = head.match(/["'`][^"'`]+["'`]\s*,\s*((?:\w+\s*,\s*)+)(?:async|\(|function)/);
    if (inline) for (const name of inline[1].split(",").map((s) => s.trim()).filter(Boolean)) guards.push({ name, at: `${n.file}:${start}` });

    routes.push({
      id: `${method} ${fullPath}`,
      method,
      path: fullPath,
      file: n.file,
      start,
      end,
      node: n.id,
      guards: dedupe(guards, (x) => x.name),
      ...(n.handlerText ? { handlerText: n.handlerText } : {}),
    });
  }
  // Middleware the app uses that serves its own pages by the Host header (apps on their own
  // subdomains): `app.use(appsHostHandler)`, where the handler reads req.hostname and answers.
  for (const f of sourceFiles) {
    if (!/\.[cm]?[jt]s$/.test(f) || f.includes("node_modules/") || /\.(test|spec)\./.test(f)) continue;
    const src = g.text(f) ?? "";
    for (const v of appVars(f))
      for (const u of src.matchAll(new RegExp(`\\b${v}\\.use\\(\\s*([A-Za-z_$][\\w$]*)\\s*\\)`, "g"))) {
        const name = u[1];
        const im = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)].find((x) => x[1].split(",").some((p) => p.trim().split(/\s+as\s+/).pop() === name));
        const file = im ? resolveRel(f, im[2]) : f;
        const text = file && g.text(file);
        if (!text) continue;
        // Only a function: `const h = (req, res, next) => …` or `function h(req, res, next)`, not a Router.
        const d = new RegExp(`\\bfunction\\s+${name}\\s*\\(|\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[\\w$]+\\s*=>)`).exec(text);
        if (!d) continue;
        const open = text.indexOf("{", d.index);
        let depth = 0, i = open;
        for (; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) break; }
        const body = text.slice(d.index, i + 1);
        if (!/\breq\.(?:hostname|subdomains)\b|\breq\.headers\.host\b|headers\[\s*["']host["']\s*\]/.test(body) || !/\bres\.(?:send|sendFile|end|render|write)\s*\(|\b[\w$]+\(\s*res\s*,/.test(body)) continue;
        // It serves pages itself: CORS or tenant middleware sets a header or rejects, then passes on.
        if (/\bnext\s*\(\s*\)\s*;?\s*\}\s*;?\s*$/.test(body.replace(/\/\/[^\n]*/g, ""))) continue;
        const line = (k) => text.slice(0, k).split("\n").length;
        routes.push({ id: "ALL /*", method: "ALL", path: "/*", file, start: line(d.index), end: line(i), guards: [], host: true });
      }
  }
  // A helper mounted twice at one prefix gives the same route twice: keep one.
  const once = new Set();
  for (let i = routes.length - 1; i >= 0; i--) { const k = `${routes[i].id}|${routes[i].file}|${routes[i].start}`; if (once.has(k)) routes.splice(i, 1); else once.add(k); }
  routes.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);

  const reachable = new Set([...mounts.values()].map((m) => m.file));
  // Route nodes in files the walk never reached. Frontend route tables (.tsx)
  // are not server routes; the rest are usually factory-mounted routers.
  const unmounted = [...new Set(routeNodes.filter((n) => !reachable.has(n.file) && !/\.[jt]sx$/.test(n.file)).map((n) => n.file))];
  return {
    entry,
    mounts: Object.fromEntries([...mounts].map(([k, m]) => [k, { prefix: m.prefix || "/", guards: m.guards.map((x) => x.name) }])),
    routes,
    unmounted_route_files: unmounted,
  };
}

/** Files that may be an app entry: they mount routes (`USE` nodes) or create an app (`express()`). */
const entryCandidates = (g) => {
  const out = new Set();
  for (const n of g.nodes.values()) if (n.kind === "route" && n.name.startsWith("USE ") && !/\.(test|spec)\./.test(n.file)) out.add(n.file);
  for (const f of g.files) if (/\.[cm]?[jt]s$/.test(f) && !/\.(test|spec)\./.test(f) && !f.includes("node_modules/") && /\bexpress\s*\(\s*\)/.test(g.text(f) ?? "")) out.add(f);
  return [...out];
};

// How an Express handler answers and reads its request (the contract check reads handlers with these).
export const idioms = {
  // Explicit statuses: res.status(404), res.sendStatus(204), and helpers that take the response and a status: sendError(res, 404, …)
  status: [/\.(?:status|sendStatus)\(\s*(\d{3})\s*\)/g, /\w+\(\s*res\s*,\s*(\d{3})\b/g],
  // An answer with no status: 200.
  implicit: /\bres\s*\.\s*(?:json|send|write|end)\s*\(/,
  // [pattern, status] answers that carry a fixed status, implicit (res.redirect is a 302).
  fixed: [[/\bres\s*\.\s*redirect\s*\(/, 302, true]],
  // Expressions that hold the request body, and lines that make another name for it.
  body: ["req\\.body"],
  bodyAlias: /(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*\(?\s*req\.body\b/,
};

// Express runs on every repo: it finds nothing where there is no Express app.
export default { name: "express", detect: () => true, routes: expressRoutes, idioms };
