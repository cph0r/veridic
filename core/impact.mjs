// What a change reaches: the routes whose code (handler and the functions it
// calls) touches the given files or line ranges, what each of those routes really
// does, and which tests cover that code. Run before an edit to see the blast
// radius, and after one to check it (see doneWithoutSpec in seam.mjs).

import { reached } from "./reach.mjs";
import { routeEffects } from "./effects.mjs";
import { normRoute } from "./routes.mjs";
import { testsReaching } from "./tests.mjs";

const overlaps = (n, t) => n.file === t.file && (t.start == null || (n.start <= (t.end ?? t.start) && n.end >= t.start));

/** "path", "path:12", "path:12-40", or a route ("POST /api/x") -> targets [{ file, start?, end? }]. */
export function parseTargets(inv, args) {
  const out = [];
  const unknown = [];
  for (const a of args) {
    const route = a.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)\s+(\/\S*)$/i);
    if (route) {
      const want = normRoute(`${route[1].toUpperCase()} ${route[2]}`);
      const hits = inv.routes.filter((r) => normRoute(r.id) === want);
      if (hits.length) for (const r of hits) out.push({ file: r.file, start: r.start, end: r.end, route: r.id });
      else unknown.push(a);
      continue;
    }
    const m = a.match(/^([^\s:]+?)(?::(\d+)(?:-(\d+))?)?$/);
    if (m) out.push({ file: m[1], ...(m[2] ? { start: Number(m[2]), end: Number(m[3] ?? m[2]) } : {}) });
    else unknown.push(a);
  }
  return { targets: out, unknown };
}

const kindsOf = (effects) => {
  const k = new Set(effects.map((e) => e.kind));
  return {
    effect: k.has("destructive") ? "destructive" : k.has("write") || k.has("moves_money") || k.has("notifies") ? "write" : "read",
    ...(k.has("moves_money") ? { moves_money: true } : {}),
    ...(k.has("notifies") ? { notifies: true } : {}),
    ...(k.has("external") ? { external: true } : {}),
  };
};

/** The code each route runs: its handler and the functions it reaches. Cached per graph. */
const footprints = new WeakMap();
export function footprintOf(g, route, depth = 4) {
  if (!footprints.has(g)) footprints.set(g, new Map());
  const m = footprints.get(g);
  if (!m.has(route.id)) m.set(route.id, reached(g, route, depth));
  return m.get(route.id);
}

/**
 * Routes reaching the targets, closest first: { route, hops, via, effect, moves_money?, … }.
 * hops 0 means the target is in the route's own handler.
 */
export function affectedRoutes(g, inv, targets) {
  const out = [];
  for (const r of inv.routes) {
    const nodes = footprintOf(g, r);
    const hit = nodes.filter((n) => targets.some((t) => overlaps(n, t))).sort((a, b) => a.depth - b.depth)[0];
    if (!hit) continue;
    out.push({ route: r.id, at: `${r.file}:${r.start}-${r.end}`, hops: hit.depth, ...(hit.depth ? { via: hit.name } : {}), ...kindsOf(routeEffects(g, r)) });
  }
  const risk = (x) => (x.moves_money ? 0 : x.effect === "destructive" ? 1 : x.effect === "write" ? 2 : 3);
  return out.sort((a, b) => risk(a) - risk(b) || a.hops - b.hops || a.route.localeCompare(b.route));
}

/** The full report for `veridic impact`. */
export function impact(g, inv, args) {
  const { targets, unknown } = parseTargets(inv, args);
  const routes = affectedRoutes(g, inv, targets);
  const files = [...new Set(targets.map((t) => t.file))];
  const tests = testsReaching(g.repo, files);
  const coverage = files.map((f) => {
    const ts = tests.get(f) ?? [];
    return { file: f, tests: ts.map((t) => t.file), asserting_tests: ts.filter((t) => t.asserting > 0).length };
  });
  return {
    targets: targets.map((t) => (t.route ? t.route : t.start ? `${t.file}:${t.start}${t.end !== t.start ? `-${t.end}` : ""}` : t.file)),
    ...(unknown.length ? { unknown } : {}),
    summary: {
      routes: routes.length,
      moves_money: routes.filter((r) => r.moves_money).length,
      destructive: routes.filter((r) => r.effect === "destructive").length,
      writes: routes.filter((r) => r.effect === "write").length,
      files_without_asserting_tests: coverage.filter((c) => !c.asserting_tests).map((c) => c.file),
    },
    routes,
    coverage,
  };
}
