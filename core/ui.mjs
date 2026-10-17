// UI linking: which screens call which routes, so each page and component joins
// the module whose API it uses.
//
// A URL in the UI code (`fetch("/api/orders/" + id)`, `${API_BASE}/invite/${code}`,
// an orval-generated `getListOrdersUrl()`) is matched to the route it calls. Then the
// link follows the code: a function that builds a URL calls that route; a function
// that calls that function does too, through imports (named, default, `* as ns`,
// re-exports, workspace packages), up to the hooks, components and pages.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { importResolver } from "./resolve.mjs";

const SRC = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.next|\.nuxt|\.codegraph|\.veridic|vendor|public\/build)\//;
const TEST = /(^|\/)(__tests__|tests?|e2e|cypress|playwright|__mocks__|mocks?|stories)\/|\.(test|spec|stories|d)\.[cm]?[jt]sx?$/;
const P = "\u0001";
const PREFIX = /^(?:api|v\d+|rest|admin|public|owner|internal|private|app)$/i; // a value filled in at runtime: `${id}`, "' + id + '"

/** Route-shaped strings in a file: [{ segs, based, at }] where based means "starts from a base URL". */
function urlLiterals(text) {
  const out = [];
  const re = /`(?:\\[\s\S]|\$\{(?:[^{}]|\{[^{}]*\})*\}|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g;
  let m;
  while ((m = re.exec(text))) {
    // A link to one of the UI's own pages (href, to, navigate, router.push) isn't an API call.
    if (/(?:\bhref|\bto|\bpath|\bnavigate|\bpush|\breplace|\bsetLocation|\bredirect|\bRedirect|\bLink|\blocation(?:\.href)?|\bpathname|\broute)\s*[:=(]\s*\{?\s*$/.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    let s = m[0].slice(1, -1).replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, P);
    if (!s.includes("/") || s.length > 300 || /\s/.test(s.replace(/\$\{[^}]*\}/g, ""))) continue;
    s = s.split(/[?#]/)[0];
    const abs = s.match(/^(?:https?:)?\/\/[^/]+(\/.*)?$/);
    if (abs) s = abs[1] ?? "/";
    const based = s.startsWith(P);
    if (!based && !s.startsWith("/")) continue;
    // "'/api/orders/' + id": the value after the trailing slash is a path part.
    const concat = /^\s*\+/.test(text.slice(m.index + m[0].length, m.index + m[0].length + 4)) && s.endsWith("/");
    const segs = s.split("/").filter(Boolean).map((x) => (x.includes(P) ? ":p" : x));
    if (based) segs.shift();
    if (concat) segs.push(":p");
    if (!segs.length || segs.every((x) => x === ":p")) continue;
    // Passed straight into a call (`api.get("/orders")`, `adminApi("/menu/…")`): a wrapper or a
    // client with a baseURL may add a prefix such as /api.
    const call = /[\w$)\]]\s*\(\s*$/.test(text.slice(Math.max(0, m.index - 20), m.index));
    out.push({ segs, based, call, at: text.slice(0, m.index).split("\n").length });
  }
  return out;
}

/** Match a literal's segments to routes: exact length, or (from a base URL) the route's tail. */
function matcher(routes) {
  // A catch-all (`ALL /*`, `/:page`) has no word to match on: it would match every URL.
  const shapes = routes.map((r) => ({ id: r.id, segs: r.path.split("/").filter(Boolean).map((x) => (/^[:{*]/.test(x) || /^\(.*\)$/.test(x) ? ":p" : x.replace(/\(.*\)$/, ""))) })).filter((s) => s.segs.some((x) => x !== ":p"));
  const same = (lit, seg) => seg === ":p" || lit === seg;
  return (lit) => {
    const hits = [];
    for (const s of shapes) {
      if (lit.segs.length > s.segs.length) continue;
      const tail = s.segs.slice(s.segs.length - lit.segs.length);
      // Without a base, the URL may still skip a prefix a wrapper or baseURL adds (/api, /api/admin).
      if (!lit.based && tail.length !== s.segs.length && !(lit.call && lit.segs.length >= 2 && s.segs.slice(0, s.segs.length - lit.segs.length).every((x) => PREFIX.test(x)))) continue;
      // A literal ":p" only stands in for a route parameter, never a fixed word.
      if (!lit.segs.every((x, i) => (x === ":p" ? tail[i] === ":p" : same(x, tail[i])))) continue;
      // At least one real word of the URL must be one of the route's.
      if (!lit.segs.some((x, i) => x !== ":p" && tail[i] === x)) continue;
      // From a base URL, a single short segment says too little.
      if (lit.based && tail.length < s.segs.length && lit.segs.filter((x) => x !== ":p").join("/").length < 5) continue;
      hits.push(s.id);
    }
    // Prefer the most specific: routes matched with fewest parameters standing in.
    return hits;
  };
}

/** Top-level declarations of a file, each with the text it spans. */
function chunks(text) {
  const decl = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)|^export\s+default\s+(?:async\s+)?(?:function\*?|class)?\s*([A-Za-z_$][\w$]*)?/gm;
  const marks = [];
  let m;
  while ((m = decl.exec(text))) marks.push({ name: m[1] ?? m[2] ?? "default", start: m.index, exported: /^export/.test(m[0]), isDefault: /^export\s+default/.test(m[0]) });
  return marks.map((x, i) => {
    const t = text.slice(x.start, marks[i + 1]?.start ?? text.length);
    // Methods of an object or class (`const Admin = { users: async () => fetch(…) }`), by name.
    const props = new Map();
    const pm = [...t.matchAll(/^[ \t]{2,8}(?:async\s+|static\s+)*([A-Za-z_$][\w$]*)\s*(?::\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)|\([^)]*\)\s*\{)/gm)];
    pm.forEach((m, j) => props.set(m[1], { start: x.start + m.index, text: t.slice(m.index, pm[j + 1]?.index ?? t.length) }));
    // `export default Admin;` stands for the declaration named Admin.
    const alias = x.isDefault ? t.match(/^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m)?.[1] ?? null : null;
    return { ...x, text: t, props, alias };
  });
}

/** What a file imports: local name -> { file, name } (name "*" for a namespace). */
function imports(text, file, resolve) {
  const out = new Map();
  const add = (local, spec, name) => {
    const f = resolve(file, spec);
    if (f) out.set(local, { file: f, name });
  };
  for (const m of text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) {
    const [, what, spec] = m;
    const ns = what.match(/\*\s+as\s+([\w$]+)/);
    if (ns) add(ns[1], spec, "*");
    const def = what.match(/^([\w$]+)\s*(?:,|$)/);
    if (def) add(def[1], spec, "default");
    const named = what.match(/\{([\s\S]*)\}/);
    if (named) for (const part of named[1].split(",")) { const [a, b] = part.replace(/\btype\s+/, "").trim().split(/\s+as\s+/); if (a) add((b ?? a).trim(), spec, a.trim()); }
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) add(m[1], m[2], "*");
  return out;
}
/** Re-exports: `export * from`, `export { a as b } from`. */
function reexports(text, file, resolve) {
  const star = [], named = new Map();
  for (const m of text.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/g)) { const f = resolve(file, m[1]); if (f) star.push(f); }
  for (const m of text.matchAll(/export\s+\*\s+as\s+([\w$]+)\s+from\s+["']([^"']+)["']/g)) { const f = resolve(file, m[2]); if (f) named.set(m[1], { file: f, name: "*" }); }
  for (const m of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    const f = resolve(file, m[2]);
    if (f) for (const part of m[1].split(",")) { const [a, b] = part.trim().split(/\s+as\s+/); if (a) named.set((b ?? a).trim(), { file: f, name: a.trim() }); }
  }
  return { star, named };
}

// Workspace packages (`@workspace/api-client-react`) resolve to their source.
function workspaceResolver(repo, files) {
  const pkgs = new Map();
  for (const f of files.filter((x) => x.endsWith("package.json") && !SKIP.test(x))) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(repo, f), "utf8"));
      if (!p.name) continue;
      const dir = path.posix.dirname(f) === "." ? "" : path.posix.dirname(f);
      const entry = [typeof p.exports === "string" ? p.exports : p.exports?.["."]?.import ?? p.exports?.["."]?.default ?? p.exports?.["."], p.source, p.module, p.main, "src/index.ts", "src/index.tsx", "src/index.js", "index.ts", "index.js"]
        .filter((x) => typeof x === "string").map((x) => path.posix.normalize(path.posix.join(dir, x)));
      pkgs.set(p.name, { dir, entry });
    } catch {}
  }
  return pkgs;
}

/**
 * Link the UI to routes and modules.
 * @returns {{ files: [{ file, kind, routes, modules, module }], unlinked: number }}
 */
export function linkUi(repo, routes, modules) {
  let all = [];
  try {
    all = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  } catch {
    return { files: [], unlinked: 0 };
  }
  const exists = new Set(all);
  // Backend code is what routes run; the rest is UI and shared client code.
  const backend = new Set([...routes.map((r) => r.file), ...modules.flatMap((m) => [...m.files, ...m.code, ...m.shared])]);
  // And the backend's package: its scripts and bootstrap aren't UI. The package is the nearest
  // folder with a package.json above the route handlers; at the repo root, their top folder.
  const pkgDirs = all.filter((f) => /(^|\/)package\.json$/.test(f) && !SKIP.test(f)).map((f) => path.posix.dirname(f)).filter((d) => d !== ".");
  const roots = new Set(routes.map((r) => {
    const own = pkgDirs.filter((d) => r.file.startsWith(d + "/")).sort((a, b) => b.length - a.length)[0];
    if (own) return own + "/";
    const top = r.file.split("/")[0];
    return r.file.includes("/") && !/^(src|lib|app)$/.test(top) ? top + "/" : null;
  }).filter(Boolean));
  const candidates = all.filter((f) => SRC.test(f) && !SKIP.test(f) && !TEST.test(f) && !backend.has(f) && ![...roots].some((r) => f.startsWith(r)));
  const base = importResolver(repo);
  const pkgs = workspaceResolver(repo, all);
  const resolve = (from, spec) => {
    const hit = base(from, spec);
    if (hit) return hit;
    for (const [name, p] of pkgs)
      if (spec === name) return p.entry.find((e) => exists.has(e)) ?? null;
      else if (spec.startsWith(name + "/")) { const sub = path.posix.join(p.dir, spec.slice(name.length + 1)); return base(p.dir ? p.dir + "/x" : "x", "./" + spec.slice(name.length + 1)) ?? [sub, `${sub}.ts`, `${sub}.tsx`, `${sub}.js`, `${sub}/index.ts`].find((e) => exists.has(e)) ?? null; }
    return null;
  };
  const match = matcher(routes);
  const read = (f) => { try { return fs.readFileSync(path.join(repo, f), "utf8"); } catch { return ""; } };

  // Per file: its chunks (with the routes their own URLs call), imports and re-exports.
  const F = new Map();
  for (const f of candidates) {
    const text = read(f);
    if (!text || text.length > 2_000_000) continue;
    const cs = chunks(text);
    const lits = urlLiterals(text);
    const direct = new Set();
    const chunkRoutes = cs.map(() => new Set());
    for (const l of lits) {
      const ids = match(l);
      if (!ids.length) continue;
      const pos = text.split("\n").slice(0, l.at - 1).join("\n").length;
      const ci = cs.findLastIndex((c) => c.start <= pos);
      for (const id of ids) (ci >= 0 ? chunkRoutes[ci] : direct).add(id), direct.add(id);
    }
    const propRoutes = cs.map((c) => {
      const pr = new Map();
      for (const [name, p] of c.props) {
        const set = new Set();
        for (const l of urlLiterals(p.text)) for (const id of match(l)) set.add(id);
        pr.set(name, set);
      }
      return pr;
    });
    F.set(f, { text, cs, chunkRoutes, propRoutes, direct, imp: imports(text, f, resolve), re: reexports(text, f, resolve), idents: cs.map((c) => new Set(c.text.match(/[A-Za-z_$][\w$]*/g) ?? [])) });
  }

  // Routes a file's export reaches, following local names, imports and re-exports.
  const symRoutes = new Map(); // "file\0name" -> Set
  const get = (file, name, seen = new Set()) => {
    const key = file + "\0" + name;
    if (symRoutes.has(key)) return symRoutes.get(key);
    if (seen.has(key)) return new Set();
    seen.add(key);
    const x = F.get(file);
    if (!x) return new Set();
    if (name === "*") { const all2 = new Set(); for (const c of x.chunkRoutes) for (const id of c) all2.add(id); return all2; }
    const i = x.cs.findIndex((c) => (name === "default" ? c.isDefault : c.name === name));
    if (i < 0) {
      const named = x.re.named.get(name);
      if (named) return get(named.file, named.name, seen);
      for (const s of x.re.star) { const r = get(s, name, seen); if (r.size) return r; }
      return new Set();
    }
    return x.chunkRoutes[i];
  };
  // The file a name stands for when it is a namespace (`* as ns`, `export * as ns from`).
  const nsOf = (file, name, depth = 0) => {
    if (name === "*") return file;
    const x = F.get(file);
    if (!x || depth > 6) return null;
    const n = x.re.named.get(name);
    if (n) return nsOf(n.file, n.name, depth + 1);
    for (const s2 of x.re.star) { const r = nsOf(s2, name, depth + 1); if (r) return r; }
    return null;
  };
  // Routes of one method of an exported object (`Admin.users` where `export default Admin`).
  const propOf = (file, name, member, depth = 0) => {
    const x = F.get(file);
    if (!x || depth > 4) return new Set();
    let i = x.cs.findIndex((c) => (name === "default" ? c.isDefault : c.name === name));
    if (i >= 0 && x.cs[i].alias) i = x.cs.findIndex((c) => c.name === x.cs[i].alias && !c.isDefault);
    if (i < 0) {
      const n = x.re.named.get(name);
      return n ? propOf(n.file, n.name, member, depth + 1) : new Set();
    }
    return x.propRoutes[i].get(member) ?? new Set();
  };
  // Links pass only through functions that call a few routes: an app-wide provider or
  // client that calls dozens says nothing about which feature a screen belongs to.
  // Narrow: a few routes, or any number within one module (a feature's own API object).
  const routeModule = new Map(modules.flatMap((m) => m.routes.map((id) => [id, m.id])));
  const narrow = (set) => { if (set.size <= 6) return true; if (set.size > 40) return false; const ms = new Set([...set].map((id) => routeModule.get(id))); return ms.size === 1; };
  const addNarrow = (into, from) => { if (from.size && narrow(from)) for (const r of from) into.add(r); };
  // Fixed point: a chunk calls what the names it uses call.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false;
    for (const [f, x] of F) {
      x.cs.forEach((c, i) => {
        const before = x.chunkRoutes[i].size;
        for (const id of x.idents[i]) {
          if (id === c.name) continue;
          const local = x.cs.findIndex((d) => d.name === id);
          if (local >= 0) addNarrow(x.chunkRoutes[i], x.chunkRoutes[local]);
          const im = x.imp.get(id);
          if (im && !nsOf(im.file, im.name)) addNarrow(x.chunkRoutes[i], get(im.file, im.name));
        }
        // Namespace members: endpoints.user(), dataService.getMessages()
        for (const mm of c.text.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
          const im = x.imp.get(mm[1]);
          const ns = im && nsOf(im.file, im.name);
          if (ns) addNarrow(x.chunkRoutes[i], get(ns, mm[2]));
          else if (im) addNarrow(x.chunkRoutes[i], propOf(im.file, im.name, mm[2]));
        }
        if (x.chunkRoutes[i].size !== before) grew = true;
      });
    }
    symRoutes.clear();
    if (!grew) break;
  }

  // Each file: every route its code calls; a client of many modules is shared API code.
  const moduleOf = new Map(modules.flatMap((m) => m.routes.map((id) => [id, m.id])));
  const out = [];
  for (const [f, x] of F) {
    const rs = new Set(x.direct);
    for (const c of x.chunkRoutes) for (const id of c) rs.add(id);
    if (!rs.size) continue;
    const counts = new Map();
    for (const id of rs) { const m = moduleOf.get(id); if (m) counts.set(m, (counts.get(m) ?? 0) + 1); }
    const mods = [...counts].sort((a, b) => b[1] - a[1]).map(([m]) => m);
    const exportsWithRoutes = x.cs.filter((c, i) => c.exported && x.chunkRoutes[i].size).length;
    // JSX by file type; plain .js counts when it returns markup (TypeScript generics aren't JSX).
    const jsx = /\.(?:[jt]sx|vue|svelte)$/.test(f) || (/\.[cm]?js$/.test(f) && /return\s*\(\s*<[A-Za-z]|React\.createElement\(/.test(x.text));
    const kind = !jsx && (mods.length >= 3 || exportsWithRoutes >= 8) ? "client" : /(^|\/)(pages?|routes|views|screens|app)\//.test(f) && jsx ? "page" : /(^|\/)hooks?\/|(^|\/)use[A-Z]/.test(f) ? "hook" : jsx ? "component" : "client";
    // A screen belongs to a module when at least half the routes it calls are that module's.
    const top = mods[0] ? counts.get(mods[0]) / rs.size : 0;
    out.push({ file: f, kind, routes: [...rs].sort(), modules: mods, module: kind === "client" || top < 0.5 ? null : mods[0] });
  }
  return { files: out.sort((a, b) => a.file.localeCompare(b.file)), scanned: F.size };
}
