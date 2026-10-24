// The conformance suite's checks, generated from the specs: black-box HTTP requests and what
// they must get back, runnable against any implementation of the same API. The original
// app runs them first: a failure there means the spec (or the seed) is wrong.
//
//   access   a route that needs sign-in, called signed out: 401 (an optional guard lets it through)
//   scope    an example row where another user is refused (denied, 403 or 404). Only the spec
//            says so: a handler using the caller's id may still serve everyone
//   example  each worked example under a rule
//   journey  a product journey: its steps' examples, in order

import { specDoc } from "../report.mjs";

const params = (p) => [...String(p).matchAll(/:(\w+)/g)].map((m) => `seed:${m[1]}`);

/** "POST /api/articles { title: "Hi" } as owner" -> { method, path, body?, as? } */
function parseGiven(s) {
  const m = String(s).match(/^([A-Z]+)\s+(\S+)(?:\s+(\{[\s\S]*\}))?(?:\s+as\s+(\w+))?\s*$/);
  return m ? { method: m[1], path: m[2], ...(m[4] ? { as: m[4] } : {}), ...(m[3] ? { body: m[3] } : {}) } : null;
}
/** "201, article.title: "Hi"" -> { status, fields? }; "denied" is 403 or 404. */
function parseThen(s) {
  const [first, ...rest] = String(s).split(/,\s*(?=[\w.]+:\s)/);
  const status = first.trim() === "denied" ? "denied" : Number(first.trim());
  if (status !== "denied" && !Number.isInteger(status)) return null;
  const fields = {};
  for (const r of rest) { const m = r.match(/^([\w.]+):\s*(.+)$/); if (m) fields[m[1]] = m[2].trim(); }
  return { status, ...(Object.keys(fields).length ? { fields } : {}) };
}

/**
 * @param data { routes: [{ id, method, path, access, guards? }], specs: [{ folder, text }], product? }
 * @returns [{ id, rule, kind, request: { method, path, as, body? }, expect: { status: number | "denied", fields? }, needs, steps? }]
 */
export function conformChecksFrom({ routes = [], specs = [], product = null }) {
  const out = [];
  for (const r of routes) {
    const optional = r.guards?.length && r.guards.every((g) => /optional/i.test(g));
    if ((r.access === "auth" || r.access === "role") && !optional)
      out.push({ id: `access:${r.id}:anon`, rule: null, kind: "access", request: { method: r.method, path: r.path, as: "anon" }, expect: { status: 401 }, needs: params(r.path) });
  }
  const byRule = new Map();
  for (const s of specs) {
    const doc = specDoc(s.text);
    for (const [id, req] of Object.entries(doc.reqs ?? {}))
      (req.examples ?? []).forEach((x, i) => {
        const request = parseGiven(x.given), expect = parseThen(x.then);
        if (!request || !expect) return;
        // Another user refused: 403 and 404 are the same answer (one hides that the record exists).
        if (request.as === "other" && (expect.status === 403 || expect.status === 404)) expect.status = "denied";
        const kind = expect.status === "denied" ? "scope" : "example";
        const c = { id: `${kind}:${s.folder}:${id}:${i + 1}`, rule: `${s.folder}:${id}`, kind, request: { ...request, as: request.as ?? "owner" }, expect, needs: params(request.path), ...(x.proven_by ? { proven_by: x.proven_by } : {}) };
        out.push(c);
        (byRule.get(c.rule) ?? byRule.set(c.rule, []).get(c.rule)).push(c);
      });
  }
  for (const j of product?.journeys ?? []) {
    const steps = j.steps.flatMap((st) => st.refs.flatMap((ref) => byRule.get(ref) ?? []));
    if (steps.length) out.push({ id: `journey:${j.id}`, rule: null, kind: "journey", title: j.title, steps: steps.map(({ request, expect }) => ({ request, expect })), needs: [...new Set(steps.flatMap((s) => s.needs))] });
  }
  return out;
}

/** The checks for a repo: its routes and access, its specs' examples, its product journeys. */
export async function conformChecks(repo) {
  const fs = await import("node:fs"), path = await import("node:path");
  const { openGraph } = await import("../graph.mjs");
  const { routeInventory } = await import("../routes.mjs");
  const { accessMatrix } = await import("../access.mjs");
  const { defaultSpecs } = await import("../metrics.mjs");
  const { parseProduct } = await import("../product.mjs");
  const g = openGraph(repo);
  const inv = routeInventory(g);
  const acc = new Map(accessMatrix(g, inv).map((a) => [a.route, a]));
  const routes = inv.routes.map((r) => ({ id: r.id, method: r.method, path: r.path, access: acc.get(r.id)?.access, guards: acc.get(r.id)?.guards ?? [] }));
  const specs = defaultSpecs(repo).map((f) => ({ folder: path.basename(path.dirname(f)), text: fs.readFileSync(f, "utf8") }));
  const pf = path.join(repo, "specs/product/spec.md");
  const product = fs.existsSync(pf) ? parseProduct(fs.readFileSync(pf, "utf8")) : null;
  return conformChecksFrom({ routes, specs, product });
}
