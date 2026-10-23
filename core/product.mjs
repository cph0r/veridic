// The product spec (specs/product/spec.md): what the app does end to end. Journeys are the
// main things a person does across parts, each step naming the part rules that make it work;
// guarantees are promises that span parts, each listing the part rules that together make
// it true. Its rules cite part rules ("apps:FR-003": spec folder, colon, id), not code, so
// a journey or guarantee is proven when all its part rules are.

export const PRODUCT_SPEC = /(^|\/)specs\/product\/spec\.md$/;

const REF = /\b([\w-]+):((?:FR|NFR|AC|INV)-?\d+[a-z]?)\b/g;
const refsIn = (s) => [...String(s).matchAll(REF)].map((m) => `${m[1]}:${m[2]}`);

/** -> { title, summary, journeys: [{ id, title, steps: [{ text, refs }] }], guarantees: [{ id, text, refs }] } */
export function parseProduct(text) {
  const out = { title: null, summary: null, journeys: [], guarantees: [] };
  let h2 = null, journey = null;
  for (const raw of String(text).split("\n")) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^#\s+(.*)$/))) { out.title = m[1].replace(/^product\s*:\s*/i, "").trim(); continue; }
    if ((m = l.match(/^##\s+(.*)$/))) { h2 = m[1].trim().toLowerCase(); journey = null; continue; }
    if ((m = l.match(/^###\s+(J-?\d+)\s*[:.\-–—]\s*(.*)$/))) { journey = { id: m[1], title: m[2].trim(), steps: [] }; out.journeys.push(journey); continue; }
    if (!h2 && !out.summary && l && !l.startsWith("#")) { out.summary = l; continue; }
    if (journey && (m = l.match(/^\d+\.\s+(.*)$/))) {
      const refs = refsIn(m[1]);
      journey.steps.push({ text: m[1].replace(/\s*\(([^()]*)\)\s*$/, (all, inner) => (refsIn(inner).length ? "" : all)).trim(), refs });
      continue;
    }
    if ((m = l.match(/^[-*]\s*\*\*(G-?\d+)\*\*\s*:?\s*(.*)$/))) {
      const rules = m[2].match(/\[rules:\s*([^\]]*)\]/);
      out.guarantees.push({ id: m[1], text: m[2].replace(/\s*\[rules:[^\]]*\]/, "").trim(), refs: rules ? refsIn(rules[1]) : [] });
    }
  }
  return out;
}

/** References that don't resolve: { id, ref, why }[]. `specs` maps a spec folder to its rule ids. */
export function productProblems(product, specs) {
  const out = [];
  const check = (id, ref) => {
    const [folder, rule] = ref.split(":");
    if (!specs[folder]) out.push({ id, ref, why: `no spec folder specs/${folder}` });
    else if (!specs[folder].includes(rule)) out.push({ id, ref, why: `no ${rule} in specs/${folder}` });
  };
  for (const j of product.journeys) for (const s of j.steps) for (const r of s.refs) check(j.id, r);
  for (const g of product.guarantees) for (const r of g.refs) check(g.id, r);
  return out;
}

/** The state of several rules together: null if any is missing; broken, then stale, if any is; proven if all are; else untested. */
export function combine(states) {
  if (!states.length || states.some((s) => s == null)) return null;
  if (states.some((s) => s === "broken" || s === "lost")) return "broken";
  if (states.some((s) => s === "stale")) return "stale";
  return states.every((s) => s === "proven") ? "proven" : "untested";
}

/** The product with a state on each journey, step and guarantee, from `ruleState(ref)`. */
export function productState(product, ruleState) {
  const steps = (j) => j.steps.map((s) => ({ ...s, state: combine(s.refs.map(ruleState)) }));
  return {
    ...product,
    journeys: product.journeys.map((j) => { const st = steps(j); return { ...j, steps: st, state: combine(st.flatMap((s) => s.refs.map(ruleState))) }; }),
    guarantees: product.guarantees.map((g) => ({ ...g, state: combine(g.refs.map(ruleState)) })),
  };
}

/** A part rule's state from a report rule row (the same reading the parts table makes). */
export function ruleRowState(r) {
  if (!r) return null;
  if (r.status === "failing" || r.status === "broken" || (r.cites ?? []).some((c) => c.resolves === false)) return "broken";
  if (r.stale) return "stale";
  return r.status === "covered" || r.status === "passing" ? "proven" : "untested";
}
