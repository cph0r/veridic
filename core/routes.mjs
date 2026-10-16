// Express route inventory: walk the router mount tree from the app entry so every
// route gets its full URL and the guards mounted above it, then give each route
// its handler extent (the full `router.post(...)` call). Ported from
// recover/extract.mjs sections 1-2.

import fs from "node:fs";
import path from "node:path";
import { callExtent } from "./graph.mjs";

export const joinPath = (a, b) => `${a}/${b}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1") || "/";

/** Normalized route id for matching: params become {}. */
export const normRoute = (id) => id.replace(/\{[^}]+\}|:\w+/g, "{}");

/** "POST /api/x" or "post /api/x" -> { method, path } */
export const parseRouteId = (s) => {
  const m = s.trim().match(/^(get|post|put|patch|delete|head|options|all)\s+(\/\S*)$/i);
  return m ? { method: m[1].toUpperCase(), path: m[2] } : null;
};

export function routeInventory(g, { entry } = {}) {
  const exists = (rel) => fs.existsSync(path.join(g.repo, rel)) && fs.statSync(path.join(g.repo, rel)).isFile();
  const resolveImport = (fromFile, spec) => {
    if (!spec.startsWith(".")) return null;
    const base = path.join(path.dirname(fromFile), spec).replace(/\.js$/, "");
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.js")]) {
      if (exists(c)) return c;
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
    if (name !== "default") return name;
    return (g.text(file) ?? "").match(/export\s+default\s+(\w+)\s*;?/)?.[1] ?? "*";
  };

  // `<v>.use(...)` calls, including multi-line ones. v = null matches any receiver.
  const usesOf = (file, v) => {
    const src = g.text(file) ?? "";
    const out = [];
    const re = v && v !== "*" ? new RegExp(`\\b${v}\\.use\\(`, "g") : /\b\w+\.use\(/g;
    for (const m of src.matchAll(re)) {
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < src.length && depth > 0) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") depth--;
        i++;
      }
      const body = src.slice(m.index + m[0].length, i - 1);
      const line = src.slice(0, m.index).split("\n").length;
      const prefix = body.match(/^\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
      const idents = body
        .replace(/^\s*["'`][^"'`]+["'`]\s*,?/, "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\w+$/.test(s));
      out.push({ line, prefix, idents });
    }
    return out;
  };

  // Routers created in a file: `const workspace = Router()` / `express.Router(...)`.
  const localRouters = (file) =>
    new Set([...(g.text(file) ?? "").matchAll(/\b(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:express\s*\.\s*)?Router\s*\(/g)].map((m) => m[1]));
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
  // Calls that hand the app or router to another function: `registerAuthRoutes(app)`.
  const registrarCalls = (file, v) => {
    if (!v || v === "*") return [];
    const out = [];
    for (const m of (g.text(file) ?? "").matchAll(/\b(\w+)\s*\(([^()]*)\)/g)) {
      const args = m[2].split(",").map((a) => a.trim());
      const i = args.indexOf(v);
      if (i >= 0 && !/^(use|get|post|put|patch|delete|all|listen|if|while|for|switch|return)$/.test(m[1])) out.push({ fn: m[1], index: i });
    }
    return out;
  };

  // Mounts are keyed by file and router variable: one file may define several
  // routers mounted at different prefixes.
  const makeWalk = () => {
    const mounts = new Map(); // "file#var" -> { file, prefix, guards: [{name, at}] }
    const pathGuards = [];
    const seen = new Set();
    const walk = (file, v, prefix, guards) => {
      const key = `${file}#${v ?? "*"}`;
      if (seen.has(key)) return;
      seen.add(key);
      mounts.set(key, { file, prefix, guards });
      const imports = importsOf(file);
      const locals = localRouters(file);
      for (const use of usesOf(file, v)) {
        const routerIdent = [...use.idents].reverse().find((id) => imports[id] || (locals.has(id) && id !== v));
        const at = `${file}:${use.line}`;
        const mw = use.idents.filter((id) => id !== routerIdent).map((name) => ({ name, at }));
        const full = joinPath(prefix, use.prefix);
        if (routerIdent && imports[routerIdent]) {
          const imp = imports[routerIdent];
          walk(imp.file, exportVar(imp.file, imp.name), full, [...guards, ...mw]);
        } else if (routerIdent) walk(file, routerIdent, full, [...guards, ...mw]); // a router defined in this file
        else if (use.prefix && mw.length) pathGuards.push({ prefix: full, guards: mw, at });
      }
      // Registration functions: the app/router passed to an imported (or local) function.
      const receivers = v && v !== "*" ? [v] : appVars(file);
      for (const r of receivers) {
        for (const c of registrarCalls(file, r)) {
          const target = imports[c.fn]?.file ?? file;
          const fnName = imports[c.fn] ? (imports[c.fn].name === "default" ? c.fn : imports[c.fn].name) : c.fn;
          const p = paramName(target, fnName, c.index);
          if (p && !(target === file && p === r)) walk(target, p, prefix, guards);
        }
      }
    };
    return { mounts, pathGuards, walk };
  };

  const routeNodes = [...g.nodes.values()].filter((n) => n.kind === "route" && !n.name.startsWith("USE "));
  // CodeGraph indexes routes only on receivers named `router` or `app`. Add the
  // rest (`ordersRouter.get("/x", …)`) on routers and apps a file declares.
  const known = new Set(routeNodes.map((n) => `${n.file}:${n.start}`));
  for (const f of g.files) {
    if (!/\.[cm]?[jt]s$/.test(f) || f.includes("node_modules/") || /\.(test|spec)\./.test(f)) continue;
    const vars = [...localRouters(f), ...appVars(f)];
    if (!vars.length) continue;
    const src = g.text(f) ?? "";
    const re = new RegExp(`\\b(${vars.join("|")})\\s*\\.\\s*(get|post|put|patch|delete|head|options|all)\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g");
    for (const m of src.matchAll(re)) {
      const line = src.slice(0, m.index).split("\n").length;
      if (known.has(`${f}:${line}`)) continue;
      const n = { id: `plumb:route:${f}:${line}`, kind: "route", name: `${m[2].toUpperCase()} ${m[3]}`, file: f, start: line, end: line };
      routeNodes.push(n);
      g.nodes.set(n.id, n);
    }
  }
  const receiverOf = (n) => g.lines(n.file)[n.start - 1]?.match(/(\w+)\s*\.\s*(?:get|post|put|patch|delete|head|options|all|route)\s*\(/)?.[1];
  const lookup = (mounts, file, v) => mounts.get(`${file}#${v}`) ?? mounts.get(`${file}#*`) ?? [...mounts.values()].find((m) => m.file === file);

  // Entry: the candidate app file whose mount tree reaches the most routes. Other
  // candidates are merged in for routes the best one doesn't reach (several apps).
  const candidates = entry ? [entry] : entryCandidates(g);
  const walks = candidates
    .map((c) => {
      const w = makeWalk();
      w.walk(c, null, "", []);
      return { entry: c, ...w, reached: routeNodes.filter((n) => lookup(w.mounts, n.file, receiverOf(n))).length };
    })
    .sort((a, b) => b.reached - a.reached);
  const mounts = new Map();
  const pathGuards = [];
  for (const w of walks) {
    for (const [k, m] of w.mounts) if (!mounts.has(k)) mounts.set(k, m); // the best entry's mounts win
    pathGuards.push(...w.pathGuards);
  }
  entry = walks[0]?.entry;
  const mountFor = (file, v) => lookup(mounts, file, v);

  const routes = [];
  for (const n of routeNodes) {
    const mount = mountFor(n.file, receiverOf(n));
    if (!mount) continue; // not reachable from the entry: a different app, or a factory-mounted router
    const [method, localPath] = n.name.split(" ");
    const fullPath = joinPath(mount.prefix, localPath);
    const src = g.text(n.file) ?? "";
    const [start, end] = callExtent(src, n.start) ?? [n.start, n.end];

    const guards = [
      ...mount.guards,
      ...pathGuards.filter((pg) => fullPath === pg.prefix || fullPath.startsWith(`${pg.prefix}/`)).flatMap((pg) => pg.guards),
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
    });
  }
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

export function dedupe(xs, key) {
  return [...new Map(xs.map((x) => [key(x), x])).values()];
}
