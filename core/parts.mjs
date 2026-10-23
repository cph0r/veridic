// The parts of the app and the spec files each part's one spec is made of. The same
// rule as the dashboard (report-page.js): a spec file in a folder named exactly after a
// part is that part's; else it belongs to the part whose code its rules cite most
// (ties: the first part, modules before screens); else to the part whose id is the
// longest prefix of its folder (orders-…); else to none.

const rulesOf = (s) => (s.requirements ?? []).filter((r) => r.requirement !== false);

/** spec path -> part id, or null when the spec belongs to no part. */
export function specHomes(data) {
  const parts = [
    ...(data.modules ?? []).map((m) => ({ id: m.id, files: new Set([...(m.files ?? []), ...(m.code ?? [])]) })),
    ...(data.screens ?? []).map((g) => ({ id: g.id, files: new Set(g.files ?? []) })),
  ];
  const homes = new Map();
  for (const s of data.specs ?? []) {
    // The product spec describes the whole app: it belongs to no part.
    if (/(^|\/)specs\/product\/spec\.md$/.test(String(s.path))) { homes.set(s.path, null); continue; }
    const cited = rulesOf(s).flatMap((r) => (r.cites ?? []).map((c) => c.file).filter(Boolean));
    let best = null;
    for (const p of parts) { const n = cited.filter((f) => p.files.has(f)).length; if (n && (!best || n > best[1])) best = [p.id, n]; }
    const dir = String(s.path).split("/").slice(-2)[0];
    const exact = parts.find((p) => dir === p.id);
    const prefix = parts.filter((p) => dir.startsWith(p.id + "-")).sort((a, b) => b.id.length - a.id.length)[0];
    homes.set(s.path, exact ? exact.id : best ? best[0] : prefix ? prefix.id : null);
  }
  return homes;
}

/** A part's spec files, and the one to write to: the file named after the part, else the one with the most rules, else a new specs/<id>/spec.md. */
export function partSpec(data, id, homes = specHomes(data)) {
  const mine = (data.specs ?? []).filter((s) => homes.get(s.path) === id);
  const main = mine.find((s) => String(s.path).split("/").slice(-2)[0] === id) ?? [...mine].sort((a, b) => rulesOf(b).length - rulesOf(a).length)[0];
  return { specs: mine.map((s) => s.path), spec_path: main ? main.path : `specs/${id}/spec.md` };
}
