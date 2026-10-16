// Express route inventory: walk the router mount tree from the app entry so every
// route gets its full URL and the guards mounted above it, then give each route
// its handler extent (the full `router.post(...)` call). Ported from
// recover/extract.mjs sections 1-2.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { callExtent } from "./graph.mjs";
import { chainsOf, anonymousRouterChains, stringValue } from "./chains.mjs";

// A route path from a string or template literal: `/${page}` becomes /:page.
const routePathOf = (raw) => stringValue(raw) ?? raw.match(/^`([^`]*)`$/)?.[1]?.replace(/\$\{\s*(?:[\w$.]*\.)?([\w$]+)[^}]*\}/g, ":$1") ?? null;

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "all"]);

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
        const prefix = stringValue(c.args[0]?.raw ?? "") ?? "";
        const rest = c.args.slice(prefix ? 1 : 0);
        const pathArg = rest.length === 2 && rest[0].text.match(/^(\w+)\.(\w+)$/);
        const routeArg = rest.length === 2 && rest[1].text.match(/^(\w+)\.(\w+)$/);
        if (!prefix && pathArg && routeArg && pathArg[1] === routeArg[1]) {
          for (const e of loopEntries(src, c.line, pathArg[1], pathArg[2], routeArg[2])) out.push({ line: c.line, prefix: e.prefix, idents: [e.ident] });
          continue;
        }
        out.push({ line: c.line, prefix, idents: rest.map((a) => a.text).filter((t) => /^\w+$/.test(t)) });
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
          const dflt = imports[c.fn]?.name === "default" ? exportVar(target, "default") : null;
          const fnName = imports[c.fn] ? (imports[c.fn].name === "default" ? (dflt && dflt !== "*" ? dflt : c.fn) : imports[c.fn].name) : c.fn;
          const p = paramName(target, fnName, c.index);
          if (p && !(target === file && p === r)) walk(target, p, prefix, guards);
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
        .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.includes("node_modules/"));
    } catch {
      return g.files;
    }
  })();
  const routeNodes = [...g.nodes.values()].filter((n) => n.kind === "route" && !n.name.startsWith("USE "));
  // CodeGraph indexes `router.get(...)` and `app.get(...)` only. Add the rest from the
  // source: other router names, and chains (`router.route("/x").get(a).post(b)`).
  const known = new Set(routeNodes.map((n) => `${n.file}|${n.name}`));
  for (const f of sourceFiles) {
    if (!/\.[cm]?[jt]s$/.test(f) || f.includes("node_modules/") || /\.(test|spec)\./.test(f)) continue;
    const vars = [...new Set([...localRouters(f), ...appVars(f), ...paramVars(f)])];
    if (!vars.length) continue;
    for (const ch of chainsOf(g.text(f) ?? "", vars)) {
      let routePath = null;
      ch.calls.forEach((c, i) => {
        if (c.name === "route") return void (routePath = routePathOf(c.args[0]?.raw ?? ""));
        if (!METHODS.has(c.name)) return;
        const p = routePathOf(c.args[0]?.raw ?? "") ?? routePath;
        if (!p || !/^[/*]/.test(p)) return; // `app.get("env")` reads a setting
        const name = `${c.name.toUpperCase()} ${p}`;
        if (known.has(`${f}|${name}`)) return;
        known.add(`${f}|${name}`);
        const start = i === 0 ? ch.line : c.line;
        // A chain can put several methods on one line (`.post(add).get(list)`): keep
        // this call's own arguments, so its handlers aren't confused with its neighbours'.
        const n = { id: `veridic:route:${f}:${start}:${name}`, kind: "route", name, file: f, start, end: c.endLine, receiver: ch.root, extent: [start, c.endLine], handlerText: c.args.map((x) => x.raw).join(", ") };
        routeNodes.push(n);
        g.nodes.set(n.id, n);
      });
    }
  }
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
  for (const n of routeNodes) {
    const mount = mountFor(n.file, receiverOf(n)) ?? appParamMount(n);
    if (!mount) continue; // not reachable from the entry: a different app, or a factory-mounted router
    const [method, localPath] = n.name.split(" ");
    const fullPath = joinPath(mount.prefix, localPath);
    const src = g.text(n.file) ?? "";
    const [start, end] = n.extent ?? callExtent(src, n.start) ?? [n.start, n.end];

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
      ...(n.handlerText ? { handlerText: n.handlerText } : {}),
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
