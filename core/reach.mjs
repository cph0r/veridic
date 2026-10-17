// What a route's code reaches: its handler range plus every function it calls, up to
// a few calls away, including handlers the code index doesn't link (controller
// modules, `exports.x = …`, constructor objects, function-valued constants).

import path from "node:path";
import { SYMBOL_KINDS, isTestFile } from "./graph.mjs";
import { codeOnly } from "./tests.mjs";
import { importResolver } from "./resolve.mjs";

const MAX_NODES = 120;

// Module references the code index doesn't link: `userController.createUser`, where
// userController is a required or imported module, resolves to createUser's
// definition in that module (through one index-file re-export).
// Relative imports and the project's own aliases (tsconfig/jsconfig paths, module-alias).
const resolvers = new WeakMap();
const resolveRel = (g, from, spec) => {
  if (!resolvers.has(g)) resolvers.set(g, importResolver(g.repo ?? "."));
  return resolvers.get(g)(from, spec);
};
const modulesOf = cacheBy((g, file) => {
  const src = g.text(file) ?? "";
  const map = {};
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) map[m[1]] = { file: resolveRel(g, file, m[2]) };
  for (const m of src.matchAll(/import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s+["'](\.[^"']+)["']/g)) map[m[1]] = { file: resolveRel(g, file, m[2]) };
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*["']([^"']+)["']\s*\)|import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1] ?? m[3];
    const from = resolveRel(g, file, m[2] ?? m[4]);
    for (const part of names.split(",")) {
      const [orig, local = orig] = part.trim().split(/\s*(?::|\bas\b)\s*/).map((x) => x.trim());
      if (local && from) map[local] = { file: from, member: orig };
    }
  }
  // `const sessionHandler = new SessionHandler(db)`: the instance's members live in SessionHandler's module.
  for (const m of src.matchAll(/\b(?:const|let|var|this\.)\s*([\w$]+)\s*=\s*new\s+([\w$]+)\s*\(/g)) if (map[m[2]]?.file && !map[m[2]].member) map[m[1]] = { file: map[m[2]].file };
  return map;
});
// `exports.userService = require("./user.service")`, `export * as x from`, `export { default as x } from`.
const reexport = (g, file, name) => {
  const src = g.text(file) ?? "";
  const m =
    src.match(new RegExp(`(?:module\\.)?exports\\.${name}\\s*=\\s*require\\(\\s*["'](\\.[^"']+)["']`)) ??
    src.match(new RegExp(`\\b${name}\\s*:\\s*require\\(\\s*["'](\\.[^"']+)["']`)) ??
    src.match(new RegExp(`export\\s*\\*\\s*as\\s+${name}\\s+from\\s*["'](\\.[^"']+)["']`)) ??
    src.match(new RegExp(`export\\s*\\{\\s*default\\s+as\\s+${name}\\s*\\}\\s*from\\s*["'](\\.[^"']+)["']`));
  return m ? resolveRel(g, file, m[1]) : null;
};
const DEF_KINDS = new Set(["function", "method", "constant", "variable"]);
// A function value: `(req, res) => {`, `async function (…) {`, `x => {`, or a wrapper
// around one (`catchAsync(async (req, res) => {`). `{ …methods }` or `new Store()` is not.
const FN = /^(?:async\s*)?(?:function\b[^(]*)?\([^)]*\)\s*(?::[^={]+)?(?:=>)?\s*\{|^(?:async\s+)?[\w$]+\s*=>\s*\{/;
const WRAPPED = /^[\w$.]+\s*\(\s*(?:async\s*)?(?:function\b[^(]*)?\([^)]*\)\s*(?::[^={]+)?(?:=>)?\s*\{|^[\w$.]+\s*\(\s*(?:async\s+)?[\w$]+\s*=>\s*\{/;
/** Does this constant's initializer hold a function? */
const holdsFunction = (g, n) => {
  const text = (g.lines(n.file) ?? []).slice(n.start - 1, n.start + 3).join("\n");
  const at = text.search(new RegExp(`\\b${n.name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*`));
  if (at < 0) return false;
  const rest = text.slice(at).replace(/^[^=]*=\s*/, "");
  return FN.test(rest) || WRAPPED.test(rest);
};
const indexed = (g, file, name) => [...g.nodes.values()].find((n) => n.file === file && n.name === name && DEF_KINDS.has(n.kind) && (n.kind === "function" || n.kind === "method" || (n.end > n.start && holdsFunction(g, n))));
// Definitions the index doesn't record as symbols: `exports.x = …`, `this.x = …`,
// object methods `x(req, res) {` and properties `x: async (req, res) => {`.
const defined = cacheBy((g, key) => {
  const [file, name] = key.split("\0");
  const src = g.text(file) ?? "";
  const code = codeOnly(src);
  const n = name.replace(/\$/g, "\\$");
  const re = new RegExp(`(?:(?:module\\.)?exports\\.${n}|this\\.${n})\\s*=\\s*|(?<![\\w$.])${n}\\s*:\\s*(?=(?:async\\s*)?(?:function\\b|\\(|[\\w$]+\\s*=>))|^\\s*(?:async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`, "m");
  const m = code.match(re);
  if (!m) return null;
  // Only a function: `(req, res) => {`, `async function (…) {`, `x => {`, or a wrapper
  // around one (`catchAsync(async (req, res) => {`). `x = new Store()` is not.
  const head = code.slice(m.index + m[0].length, m.index + m[0].length + 400);
  if (!m[0].trimEnd().endsWith("{") && !FN.test(head) && !WRAPPED.test(head)) return null;
  const open = m[0].trimEnd().endsWith("{") ? m.index + m[0].trimEnd().length - 1 : code.indexOf("{", m.index + m[0].length);
  const nextDef = code.slice(m.index + m[0].length).search(/\n(?:exports\.|module\.exports|this\.[\w$]+\s*=)/);
  const limit = nextDef < 0 ? code.length : m.index + m[0].length + nextDef;
  let end = limit;
  if (open >= 0 && open < limit) {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
  }
  const line = (i) => src.slice(0, i).split("\n").length;
  return { id: `def:${file}:${name}`, kind: "function", name, file, start: line(m.index), end: line(Math.min(end, code.length - 1)) };
});
const symbolIn = (g, file, name) => indexed(g, file, name) ?? defined(g, `${file}\0${name}`);
function memberTargets(g, file, start, end) {
  const mods = modulesOf(g, file);
  if (!Object.keys(mods).length) return [];
  const text = (g.lines(file) ?? []).slice(start - 1, end).join("\n");
  const out = [];
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g)) {
    const mod = mods[m[1]];
    if (!mod?.file) continue;
    // `const { Workspace } = require("../models/workspace")`: Workspace.update lives in that
    // module (an object of methods), unless the module only re-exports it from elsewhere.
    const target = mod.member ? (reexport(g, mod.file, mod.member) ?? mod.file) : mod.file;
    const t = target && symbolIn(g, target, m[2]);
    if (t) out.push(t);
  }
  // Named imports used bare: `router.post("/", registerUser)`.
  for (const m of text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g)) {
    const mod = mods[m[1]];
    if (!mod?.member || !mod.file) continue;
    const t = symbolIn(g, mod.file, mod.member) ?? (reexport(g, mod.file, mod.member) ? null : null);
    if (t) out.push(t);
  }
  return out;
}
// Cached per graph (repo), so two repos analysed in one process never share entries.
function cacheBy(fn) {
  const byGraph = new WeakMap();
  return (g, k) => {
    if (!byGraph.has(g)) byGraph.set(g, new Map());
    const m = byGraph.get(g);
    if (!m.has(k)) m.set(k, fn(g, k));
    return m.get(k);
  };
}

/** The handler range plus every function/method it reaches, up to `depth` calls away. */
const BUILTIN = new Set("sort map filter find findIndex includes indexOf push pop shift unshift splice slice concat join reverse keys values entries forEach reduce some every at has add clear set get then catch finally pipe on once emit write end close toString replace split trim test exec match parse stringify assign freeze".split(" "));
const esc = (s) => s.replace(/[$]/g, "\\$");
// A link from another file that the call can't mean:
//  - `x.name(` never calls a top-level function elsewhere (an imported module's member is
//    resolved through the import, not by name);
//  - `xs.sort(` / `p.then(` is a built-in unless the caller's file names the method's class.
function nameOnly(g, file, text, t) {
  const bare = new RegExp(`(?<![\\w$.])${esc(t.name)}\\s*\\(`).test(text);
  const member = new RegExp(`\\.${esc(t.name)}\\s*\\(`).test(text);
  if (t.kind === "function" && member && !bare) return true;
  // `f()` reaches a function in another file only if this file imports `f` (or requires
  // its module): the index also links same-named functions across unrelated packages.
  if ((t.kind === "function" || t.kind === "constant" || t.kind === "variable") && bare && !member && !importsFrom(g, file, t.name, t.file)) return true;
  if (t.kind === "method" && BUILTIN.has(t.name)) {
    const cls = (t.qname ?? "").split("::")[0];
    return !cls || !new RegExp(`\\b${esc(cls)}\\b`).test(g.text(file) ?? "");
  }
  return false;
}

// Does `file` import `name` from somewhere that can be `target`? A relative import must
// resolve to it (or to a barrel); a package import must name it (`@acme/orders` for
// packages/orders/…). Files with no imports at all (globals, legacy scripts) pass.
const IMPORT_LINE = /^\s*(?:import\b[\s\S]*?from\s*["']([^"']+)["']|(?:const|let|var)\s+[\s\S]*?=\s*require\(\s*["']([^"']+)["']\s*\)|export\s*\{[^}]*\}\s*from\s*["']([^"']+)["'])/gm;
const importsFrom = (g, file, name, target) => {
  const text = g.text(file) ?? "";
  const lines = [...text.matchAll(IMPORT_LINE)];
  if (!lines.length) return true;
  const nameRe = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
  const hits = lines.filter((m) => nameRe.test(m[0]));
  if (!hits.length) return false;
  return hits.some((m) => {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec.startsWith(".")) {
      const r = resolveRel(g, file, spec);
      return !r || r === target || /(^|\/)index\.[cm]?[jt]sx?$/.test(r);
    }
    const r = resolveRel(g, file, spec);
    if (r) return r === target || /(^|\/)index\.[cm]?[jt]sx?$/.test(r);
    const words = spec.toLowerCase().split(/[@/\-_.]+/).filter((w) => w.length > 2 && !/^(?:workspace|src|lib|dist|index|packages?|node|server|client)$/.test(w));
    return !words.length || words.some((w) => target.toLowerCase().includes(w));
  });
};
function cacheBy2(fn) {
  const byGraph = new WeakMap();
  return (g, a, b) => {
    if (!byGraph.has(g)) byGraph.set(g, new Map());
    const m = byGraph.get(g), k = a + "\0" + b;
    if (!m.has(k)) m.set(k, fn(g, a, b));
    return m.get(k);
  };
}

// Every call of `.name(` in the text is on a `$(…)` DOM query.
function domOnly(text, name) {
  const esc = name.replace(/\$/g, "\\$");
  const all = text.match(new RegExp(`\\.${esc}\\s*\\(`, "g"))?.length ?? 0;
  const dom = text.match(new RegExp(`\\$\\([^()]*\\)\\.${esc}\\s*\\(`, "g"))?.length ?? 0;
  return all > 0 && all === dom;
}

// Effects, data and impact all walk the same routes: walk each once per index.
const walks = new WeakMap();
export function reached(g, route, depth = 3) {
  const m = walks.get(g) ?? walks.set(g, new Map()).get(g);
  const key = `${route.id}\0${route.file}:${route.start}-${route.end}\0${depth}\0${route.handlerText ?? ""}`;
  if (!m.has(key)) m.set(key, walk(g, route, depth));
  return m.get(key);
}

function walk(g, route, depth) {
  const out = [{ file: route.file, start: route.start, end: route.end, name: route.id, depth: 0 }];
  const seen = new Set();
  let frontier = [out[0]];
  for (let d = 1; d <= depth && frontier.length && out.length < MAX_NODES; d++) {
    const next = [];
    for (const r of frontier) {
      const rangeText = (g.lines(r.file) ?? []).slice(r.start - 1, r.end).join("\n");
      const byImport = memberTargets(g, r.file, r.start, r.end);
      // The index links calls by name; drop links the call itself rules out.
      const linked = g.usesInRange(r.file, r.start, r.end).map((u) => u.target).filter((t) => t.file === r.file || !nameOnly(g, r.file, rangeText, t));
      let targets = [...linked, ...byImport];
      // A chained route shares lines with its neighbours: keep what its own call names.
      if (r.depth === 0 && route.handlerText) targets = targets.filter((t) => new RegExp(`(?<![\\w$])${t.name.replace(/\$/g, "\\$")}(?![\\w$])`).test(route.handlerText));
      for (const t of targets) {
        // `$("link").remove()` is cheerio/jQuery, whatever else in the repo is named remove.
        if (t.kind === "method" && domOnly(rangeText, t.name)) continue;
        // Functions, and constants holding one (`const createUser = catchAsync(async …)`).
        const fnLike = t.kind === "function" || t.kind === "method" || ((t.kind === "constant" || t.kind === "variable") && t.end > t.start && holdsFunction(g, t));
        if (!SYMBOL_KINDS.has(t.kind) || !fnLike || isTestFile(t.file) || t.file.includes("node_modules") || seen.has(t.id)) continue;
        if (t.file === r.file && t.start >= r.start && t.end <= r.end) continue; // nested in the range already scanned
        seen.add(t.id);
        const n = { file: t.file, start: t.start, end: t.end, name: t.name, depth: d };
        out.push(n);
        next.push(n);
        if (out.length >= MAX_NODES) break;
      }
    }
    frontier = next;
  }
  return out;
}


/** Text of the handlers a route names directly (depth 1); with `names`, only those (e.g. the handler, not its middleware). */
export function handlerText(g, route, names = null) {
  return reached(g, route, 1)
    .filter((r) => r.depth === 1 && (!names || names.has(r.name)))
    .map((r) => (g.lines(r.file) ?? []).slice(r.start - 1, r.end).join("\n"))
    .join("\n");
}
