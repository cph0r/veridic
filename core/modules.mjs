// Modules: the app's features, found from its code rather than its URL prefixes,
// so someone can work on one feature without learning the rest.
//
//   1. Units: one per route handler file; a file serving many routes of several
//      features (Express apps with every route in app.js) splits by URL word.
//   2. Units with the same main word (the folder, or the most shared word of the
//      file name: orders.ts, public/orders/crud.ts) join.
//   3. Groups that reach the same domain code (services, models; not what every
//      route reaches: logger, auth, db) join, closest first.
//   4. A unit of one or two routes left alone joins the group its URLs belong to.
//   No merge grows a module past 30% of the app. `.veridic.json` "modules" pins
//   routes to named modules first: { "Orders": ["src/routes/orders.ts", "/api/*/orders/**"] }.
//
// Each module then gets the code it owns (files mostly its routes reach), the code
// it shares, and its neighbours: the modules whose code it calls, and those calling its.

import fs from "node:fs";
import path from "node:path";
import { footprintOf } from "./impact.mjs";

const AUTH = new Set("auth authentication login logout signin signup register session oauth sso token password passport".split(" "));
const TECH = new Set("callback webhook event status log request response handler util helper hook middleware".split(" "));
const GENERIC = new Set("endpoint endpoints server rest ws src routes route controllers controller api app lib index public admin owner internal private crud helpers utils service services module modules artifacts config handlers handler".split(" "));
const SCOPE = /^(?:api|v\d+|rest|public|admin|owner|internal|private)$/;
const TEST = /(^|\/)(__tests__|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Words of a path or name: split on separators and camelCase, singular, generic words dropped. */
export function words(s) {
  return String(s)
    .replace(/\.[cm]?[jt]sx?$/, "")
    .split(/[/\-_.:{}#]+|(?<=[a-z])(?=[A-Z])/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 2 && !GENERIC.has(w) && !/^\d/.test(w))
    .map((w) => (w.length > 4 ? w.replace(/ies$/, "y").replace(/(?<![sui])s$/, "") : w))
    .map((w) => (AUTH.has(w) ? "auth" : w));
}
const urlWord = (p) => {
  const segs = p.split("/").filter((x) => x && !/^[:{*]/.test(x)).map((w) => w.toLowerCase());
  while (segs.length > 1 && SCOPE.test(segs[0])) segs.shift();
  return segs[0] || "/";
};
const glob = (pat) => new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*") + "$");
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "module";
const title = (s) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function overrides(repo) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(repo, ".veridic.json"), "utf8")).modules;
    return m && typeof m === "object" ? Object.entries(m).map(([name, pats]) => ({ name, pats: [].concat(pats).map((p) => ({ url: p.startsWith("/"), re: glob(p) })) })) : [];
  } catch {
    return [];
  }
}

/** The modules of an app: [{ id, name, routes, files, code, shared, uses, usedBy, pinned }]. */
export function findModules(g, inv) {
  const routes = inv.routes;
  if (!routes.length) return [];
  const pins = overrides(g.repo);
  const pinned = new Map(); // route id -> module name
  for (const r of routes) for (const o of pins) if (o.pats.some((p) => (p.url ? p.re.test(r.path) : p.re.test(r.file)))) { pinned.set(r.id, o.name); break; }

  // 1. Units.
  const pre = new Map();
  for (const r of routes) if (!pinned.has(r.id)) pre.set(r.file, (pre.get(r.file) ?? []).concat(r));
  const unitRoutes = new Map();
  for (const [f, rs] of pre) {
    const ws = new Set(rs.map((r) => urlWord(r.path)));
    if (rs.length >= 12 && ws.size >= 3) for (const r of rs) { const k = `${f}#${urlWord(r.path)}`; unitRoutes.set(k, (unitRoutes.get(k) ?? []).concat(r)); }
    else unitRoutes.set(f, rs);
  }
  const units = [...unitRoutes.keys()];
  const fileOf = (u) => u.split("#")[0];
  const reachOfRoute = new Map(routes.map((r) => [r.id, new Set(footprintOf(g, r).map((n) => n.file).filter((x) => !TEST.test(x) && !x.includes("node_modules")))]));
  const reach = new Map(units.map((u) => [u, new Set(unitRoutes.get(u).flatMap((r) => [...reachOfRoute.get(r.id)]).filter((x) => x !== fileOf(u)))]));
  // What nearly everything reaches (logger, auth, db) says nothing about features.
  const reachCount = new Map();
  for (const s of reach.values()) for (const x of s) reachCount.set(x, (reachCount.get(x) ?? 0) + 1);
  const shared = new Set([...reachCount].filter(([, n]) => n > Math.max(2, units.length * 0.2)).map(([x]) => x));
  const dom = new Map(units.map((u) => [u, new Set([...reach.get(u)].filter((x) => !shared.has(x)))]));

  // 2. Main words.
  const tok = new Map(units.map((u) => [u, new Set([...words(u.includes("#") ? u.split("#")[1] : u.split("/").slice(-2).join("/")), ...unitRoutes.get(u).flatMap((r) => words(urlWord(r.path)))])]));
  const df = new Map();
  for (const t of tok.values()) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  const main = new Map(units.map((u) => {
    const pick = (ws) => ws.filter((w) => !TECH.has(w)).sort((a, b) => (df.get(b) ?? 0) - (df.get(a) ?? 0))[0];
    if (u.includes("#")) return [u, pick(words(u.split("#")[1])) ?? null];
    const parts = u.split("/");
    return [u, pick(words(parts.at(-2) ?? "")) ?? pick(words(parts.at(-1))) ?? pick(unitRoutes.get(u).flatMap((r) => words(urlWord(r.path)))) ?? null];
  }));

  const parent = new Map(units.map((u) => [u, u]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  const sizeOf = new Map(units.map((u) => [u, unitRoutes.get(u).length]));
  const CAP = Math.max(8, routes.length * 0.3);
  const join = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb || sizeOf.get(ra) + sizeOf.get(rb) > CAP) return false;
    parent.set(ra, rb);
    sizeOf.set(rb, sizeOf.get(ra) + sizeOf.get(rb));
    return true;
  };
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) if (main.get(units[i]) && main.get(units[i]) === main.get(units[j])) join(units[i], units[j]);

  // 3. Shared domain code, whole groups at a time (one stray file can't chain two features).
  const jac = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; const u = a.size + b.size - i; return u ? i / u : 0; };
  for (;;) {
    const roots = [...new Set(units.map(find))];
    const rr = new Map(roots.map((r) => [r, new Set(units.filter((u) => find(u) === r).flatMap((u) => [...dom.get(u)]))]));
    let best = null;
    for (let i = 0; i < roots.length; i++)
      for (let j = i + 1; j < roots.length; j++) {
        if (sizeOf.get(roots[i]) + sizeOf.get(roots[j]) > CAP) continue;
        const s = jac(rr.get(roots[i]), rr.get(roots[j]));
        if (s >= 0.3 && (!best || s > best[0])) best = [s, roots[i], roots[j]];
      }
    if (!best) break;
    join(best[1], best[2]);
  }

  // 4. Tiny leftovers join the group their URLs name.
  const groupWord = (r) => {
    const c = new Map();
    for (const u of units) if (find(u) === r && main.get(u)) c.set(main.get(u), (c.get(main.get(u)) ?? 0) + unitRoutes.get(u).length);
    return [...c].sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  for (const u of units) {
    const r = find(u);
    if (sizeOf.get(r) > 2 || units.some((x) => x !== u && find(x) === r)) continue;
    const ws = unitRoutes.get(u).flatMap((rt) => words(urlWord(rt.path))).filter((w) => !TECH.has(w));
    const target = [...new Set(units.map(find))].find((x) => x !== r && ws.includes(groupWord(x)));
    if (target) join(u, target);
  }

  // Assemble: groups and pinned modules, named from their routes' URLs.
  const groups = new Map();
  for (const u of units) groups.set(find(u), (groups.get(find(u)) ?? []).concat(unitRoutes.get(u)));
  const out = [...groups.entries()].map(([root, rs]) => {
    const w = groupWord(root);
    const raw = new Map();
    for (const r of rs) { const x = urlWord(r.path); if (!w || words(x).includes(w)) raw.set(x, (raw.get(x) ?? 0) + 1); }
    const best = [...raw].sort((a, b) => b[1] - a[1])[0]?.[0];
    return { name: title(w === "auth" ? "auth" : best && best !== "/" ? best : w ?? fileOf(root).split("/").pop().replace(/\.[^.]+$/, "")), routes: rs, pinned: false };
  });
  for (const o of pins) {
    const rs = routes.filter((r) => pinned.get(r.id) === o.name);
    if (rs.length) out.push({ name: o.name, routes: rs, pinned: true });
  }
  // Unique ids; biggest first.
  out.sort((a, b) => b.routes.length - a.routes.length);
  const seen = new Map();
  for (const m of out) {
    let id = slug(m.name);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n > 1) (id = `${id}-${n}`), (m.name = `${m.name} ${n}`);
    m.id = id;
  }

  // Ownership: a non-shared file belongs to the module whose routes reach it most;
  // a handler file belongs to its routes' module.
  const moduleOf = new Map();
  for (const m of out) for (const r of m.routes) moduleOf.set(r.id, m);
  const votes = new Map();
  for (const r of routes)
    for (const f of reachOfRoute.get(r.id)) {
      if (shared.has(f)) continue;
      const v = votes.get(f) ?? new Map();
      v.set(moduleOf.get(r.id).id, (v.get(moduleOf.get(r.id).id) ?? 0) + 1);
      votes.set(f, v);
    }
  const owner = new Map();
  for (const [f, v] of votes) owner.set(f, [...v].sort((a, b) => b[1] - a[1])[0][0]);
  // A handler file belongs to the module most of its routes are in.
  const byHandler = new Map();
  for (const r of routes) { const v = byHandler.get(r.file) ?? new Map(); v.set(moduleOf.get(r.id).id, (v.get(moduleOf.get(r.id).id) ?? 0) + 1); byHandler.set(r.file, v); }
  for (const [f, v] of byHandler) owner.set(f, [...v].sort((a, b) => b[1] - a[1])[0][0]);
  for (const m of out) {
    const reached = new Set(m.routes.flatMap((r) => [...reachOfRoute.get(r.id)]));
    m.files = [...new Set(m.routes.map((r) => r.file))].sort();
    m.code = [...reached].filter((f) => owner.get(f) === m.id).sort();
    m.shared = [...reached].filter((f) => shared.has(f)).sort();
    const uses = new Map();
    for (const f of reached) {
      const o = owner.get(f);
      if (o && o !== m.id && !shared.has(f)) uses.set(o, (uses.get(o) ?? []).concat(f));
    }
    m.uses = [...uses].map(([id, via]) => ({ module: id, via: via.sort() })).sort((a, b) => b.via.length - a.via.length);
  }
  for (const m of out) m.usedBy = out.filter((x) => x.uses.some((u) => u.module === m.id)).map((x) => ({ module: x.id, via: x.uses.find((u) => u.module === m.id).via }));
  return out.map((m) => ({ id: m.id, name: m.name, pinned: m.pinned, routes: m.routes.map((r) => r.id), files: m.files, code: m.code, shared: m.shared, uses: m.uses, usedBy: m.usedBy }));
}
