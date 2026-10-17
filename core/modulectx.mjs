// The app's modules, for an agent: the list (`veridic modules`), and one module's
// full context (`veridic prepare --module <id>`): what it does, each route and what
// it really does, its tables, screens, tests, rules, open findings and dependants.
// Built from the same data as the report, so an agent works on the same split a
// person sees.

import { collectReport } from "./report.mjs";

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
  return (data.modules ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    routes: m.stats.routes,
    does: m.does,
    issues: { high: m.stats.high, medium: m.stats.medium },
    untested: m.tests.untested.length,
    specs: m.specs,
    specified: m.specified,
    spec_path: m.specs[0] ?? `specs/${m.id}/spec.md`,
    tables: (m.data?.owns ?? []).map((t) => t.table),
    screens: (m.screens ?? []).length,
    used_by: m.usedBy.map((u) => u.module),
    moves_money: m.stats.money > 0,
  }));
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
  const specs = (data.specs ?? []).filter((s) => m.specs.includes(s.path));
  if (!specs.length) L.push(`None yet. A new spec for this module goes in \`specs/${m.id}/spec.md\`.`);
  for (const s of specs) {
    L.push(`- \`${s.path}\` covers ${m.specified} of ${plural(m.stats.routes, "route")}. Extend it rather than writing a second spec.`);
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
