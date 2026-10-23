// The app's modules, for an agent: the list (`veridic modules`), and one module's
// full context (`veridic prepare --module <id>`): what it does, each route and what
// it really does, its tables, screens, tests, rules, open findings and dependants.
// Built from the same data as the report, so an agent works on the same split a
// person sees.

import { collectReport } from "./report.mjs";
import { specHomes, partSpec } from "./parts.mjs";

const EFF = { read: "reads", write: "changes data", destructive: "deletes data" };
const ACC = { public: "anyone", auth: "signed-in users", role: "admins or set roles" };
const OWN = { yes: "checks the data is the caller's", no: "doesn't check whose data it is", weak: "checks with values the client sends" };
const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;

export async function loadModules(repo) {
  const data = await collectReport(repo);
  return { data, modules: data.modules ?? [] };
}

/** A module by id or name, case-insensitive. */
export function findModule(modules, key) {
  const k = String(key).toLowerCase();
  return modules.find((m) => m.id.toLowerCase() === k) ?? modules.find((m) => m.name.toLowerCase() === k) ?? null;
}

/** One line per module: the split and the state of each. */
export function moduleList(data) {
  // One spec per part: where to write it (spec_path) and the files it is made of (part_specs).
  const homes = specHomes(data);
  const one = (id) => partSpec(data, id, homes);
  return (data.modules ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    routes: m.stats.routes,
    does: m.does,
    issues: { high: m.stats.high, medium: m.stats.medium },
    untested: m.tests.untested.length,
    specs: m.specs,
    specified: m.specified,
    spec_path: one(m.id).spec_path,
    part_specs: one(m.id).specs,
    tables: (m.data?.owns ?? []).map((t) => t.table),
    screens: (m.screens ?? []).length,
    used_by: m.usedBy.map((u) => u.module),
    moves_money: m.stats.money > 0,
  })).concat((data.screens ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    kind: "screens",
    routes: 0,
    pages: g.pages.length,
    does: [],
    issues: { high: 0, medium: 0 },
    untested: 0,
    specs: g.specs,
    specified: 0,
    spec_path: one(g.id).spec_path,
    part_specs: one(g.id).specs,
    tables: [],
    screens: g.pages.length,
    used_by: [],
    moves_money: false,
  })));
}

/** One module's context, as Markdown for an agent. */
export function moduleMarkdown(data, m) {
  const name = (id) => data.modules.find((x) => x.id === id)?.name ?? id;
  const routes = data.routes.filter((r) => r.module === m.id);
  const d = m.data ?? { owns: [], uses: [] };
  const L = [`# Module: ${m.name} (\`${m.id}\`) of ${data.app?.title ?? data.name}`, ""];
  if (data.app?.about) L.push(`The app: ${data.app.about.split(/\n\s*\n/)[0]}`, "");
  L.push(`It lets callers ${m.does.join(", ")}.`, "");
  L.push("## Routes", "What each really does, traced through the code it calls.", "");
  for (const r of routes)
    L.push(`- \`${r.id}\`: ${[EFF[r.effect] ?? r.effect, r.moves_money && "moves money", r.notifies && "notifies someone", r.external && "calls an outside service"].filter(Boolean).join(", ")}; callable by ${ACC[r.access] ?? r.access}${r.access !== "public" && OWN[r.scoped] ? `; ${OWN[r.scoped]}` : ""}${r.tables?.length ? `; tables: ${r.tables.map((t) => `${t.op} ${t.table}`).join(", ")}` : ""}${m.tests.untested.includes(r.id) ? "; **no test**" : ""}. Code: \`${r.handler}\``);
  if (d.owns.length || d.uses.length) {
    L.push("", "## Data");
    for (const t of d.owns) L.push(`- owns \`${t.table}\`${t.at ? ` (defined at \`${t.at}\`)` : ""}: read by ${plural(t.reads, "route")}, written by ${t.writes}, deleted by ${t.deletes}${t.alsoWrittenBy.length ? `; also written by ${t.alsoWrittenBy.map(name).join(", ")}` : ""}`);
    if (d.uses.length) L.push(`- only reads: ${d.uses.map((t) => `\`${t.table}\`${t.owner ? ` (owned by ${name(t.owner)})` : ""}`).join(", ")}. Change those in their owner.`);
  }
  if (m.screens?.length) L.push("", "## Screens that call it", ...m.screens.map((x) => `- \`${x.file}\` (${x.kind}): ${x.routes.join(", ")}`));
  L.push("", "## Code", `- backend: ${[...m.files, ...m.code.filter((f) => !m.files.includes(f))].map((f) => `\`${f}\``).join(", ")}`);
  if (m.shared.length) L.push(`- shared code it relies on (used app-wide; change only if you must): ${m.shared.slice(0, 15).map((f) => `\`${f}\``).join(", ")}`);
  L.push("", "## Tests");
  L.push(m.tests.files.length ? `- reaching it: ${m.tests.files.map((t) => `\`${t.file}\``).join(", ")}` : "- none reach it");
  if (m.tests.untested.length) L.push(`- routes no test calls or names: ${m.tests.untested.map((x) => `\`${x}\``).join(", ")}`);
  L.push("", "## Written rules");
  // This part's one spec (its files), where to write, and other specs that touch its code.
  const one = partSpec(data, m.id);
  const specs = (data.specs ?? []).filter((s) => one.specs.includes(s.path) || m.specs.includes(s.path));
  if (!one.specs.length) L.push(`None yet. This part's spec goes in \`${one.spec_path}\`.`);
  else L.push(`This part's spec is ${one.specs.map((p) => `\`${p}\``).join(", ")}. Write to \`${one.spec_path}\`: extend it, never start a second spec file for this part.`);
  for (const s of specs) {
    L.push(one.specs.includes(s.path) ? `- \`${s.path}\` covers ${m.specified} of ${plural(m.stats.routes, "route")}.` : `- \`${s.path}\` (another part's spec; it also cites this part's code)`);
    for (const r of s.requirements.filter((q) => q.requirement)) L.push(`  - ${r.id}: ${r.text}${r.stale ? " [its code changed since it was written]" : ""}${r.status === "passing" || r.status === "covered" ? "" : " [no test]"}`);
  }
  const issues = (data.findings ?? []).filter((f) => f.module === m.id && f.severity !== "low");
  if (issues.length) {
    L.push("", "## Open findings", "Problems Veridic found. They are not required behaviour: in a spec, list them as risks or open questions, never as MUST requirements.", "");
    for (const f of issues) L.push(`- ${f.severity}: ${f.title ?? f.kind} at \`${f.where}\`: ${f.text}${f.evidence?.length ? ` (evidence: ${f.evidence.join(", ")})` : ""}`);
  }
  if (m.usedBy.length || m.uses.length) {
    L.push("", "## Neighbours");
    if (m.usedBy.length) L.push(`- depend on it (re-check after a change): ${m.usedBy.map((u) => `${name(u.module)} via ${u.via.map((f) => `\`${f}\``).join(", ")}`).join("; ")}`);
    if (m.uses.length) L.push(`- it depends on: ${m.uses.map((u) => name(u.module)).join(", ")}`);
  }
  const mp = data.structure?.modularity?.problems?.filter((p) => p.kind !== "hub" && p.modules.includes(m.id)) ?? [];
  const dups = data.structure?.duplication?.blocks?.filter((b) => b.a.module === m.id || b.b.module === m.id) ?? [];
  if (mp.length || dups.length) {
    L.push("", "## Structure");
    for (const p of mp) L.push(p.kind === "shared-writes" ? `- \`${p.table}\` (owned by ${name(p.owner)}) is also written by ${p.others.map(name).join(", ")} at ${Object.values(p.at).flat().map((x) => `\`${x}\``).join(", ")}` : `- ${p.modules.map(name).join(" and ")} depend on each other`);
    for (const b of dups.slice(0, 8)) L.push(`- ${b.lines} lines copied: \`${b.a.file}:${b.a.start}-${b.a.end}\` = \`${b.b.file}:${b.b.start}-${b.b.end}\``);
  }
  return L.join("\n") + "\n";
}

/**
 * A screen group's context, as Markdown for an agent writing its spec: its pages and
 * their URLs, its files, the API calls they make with the server rules each depends
 * on (to link, not repeat), and the files no spec describes yet.
 */
export function screenMarkdown(data, s, { uncovered = [] } = {}) {
  const L = [`# Screens: ${s.name} (\`${s.id}\`) of ${data.app?.title ?? data.name}`, ""];
  const one = partSpec(data, s.id);
  L.push(`Write this group's spec to \`${one.spec_path}\`${one.specs.length ? " (extend it; never start a second spec file for these screens)" : ""}. Describe what someone using these screens sees and can do; where a screen depends on a server rule, link it in one line (\`Server rules: specs/orders FR-016\`) instead of restating it.`, "");
  L.push(`## Pages (${s.pages.length})`, "");
  for (const p of s.pages) L.push(`- \`${p}\`${s.urls?.[p] ? ` at \`${s.urls[p]}\`` : ""}`);
  L.push("", `## Files (${s.files.length})`, "");
  for (const f of s.files) L.push(`- \`${f}\``);
  // The server rules behind each call: rules whose citations land in the route's handler.
  const rulesFor = (routeId) => {
    const h = (data.routes ?? []).find((r) => r.id === routeId)?.handler ?? "";
    const [, file, a, b] = h.match(/^(.*):(\d+)(?:-(\d+))?$/) ?? [];
    if (!file) return [];
    const lo = Number(a), hi = Number(b ?? a);
    const out = [];
    for (const sp of data.specs ?? []) for (const r of sp.requirements ?? []) if (r.requirement !== false && (r.cites ?? []).some((c) => c.file === file && (c.start == null || (c.start <= hi && (c.end ?? c.start) >= lo)))) out.push(`${sp.path} ${r.id}`);
    return out;
  };
  if (s.calls?.length) {
    L.push("", `## API calls (${s.calls.length}) and the server rules they depend on`, "");
    for (const id of s.calls) { const rs = rulesFor(id); L.push(`- \`${id}\`${rs.length ? `: ${rs.join(", ")}` : ": no server rule cites its handler yet"}`); }
  }
  if (uncovered.length) {
    L.push("", `## Not described by any spec yet (${uncovered.length})`, "", "Cite each in a rule, or say in Assumptions why it needs none.", "");
    for (const f of uncovered) L.push(`- \`${f}\``);
  }
  return L.join("\n") + "\n";
}
