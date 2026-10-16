// Everything a spec session needs to start, gathered before it starts: the
// feature's scope, the contract comparison and every relevant code range, as
// one Markdown document. Handing this to the agent up front removes its scope
// and read turns, and nearly all of a run's time is the model, not the tools.

import { openGraph } from "./graph.mjs";
import { routeInventory, normRoute } from "./routes.mjs";
import { scope } from "./scope.mjs";
import { findOpenapi, loadContract, drift } from "./contract.mjs";
import { bundle } from "./read.mjs";
import { stateMachine, stateMachineMarkdown } from "./states.mjs";

const CORE_PRIORITY = 5;

/**
 * @param seeds  routes ("POST /api/x"), files or symbols, as for scope
 * @returns {{ markdown, scope, stats: { ranges, lines, chars } }}
 */
export function prepare(repo, seeds, opts = {}) {
  const g = openGraph(repo);
  const inv = routeInventory(g, { entry: opts.entry });
  const openapiFile = findOpenapi(repo);
  const contract = openapiFile ? loadContract(repo, openapiFile) : null;
  const sc = scope(g, inv, seeds, { openapi: contract?.ops ?? [] });
  if (sc.error) throw new Error(`scope: ${sc.error} (${(sc.unresolved ?? []).join(", ")})`);

  const out = [];
  out.push(`# Feature context`, "");
  out.push(`Gathered by \`plumb prepare\` for: ${seeds.map((s) => `\`${s}\``).join(", ")}.`);
  out.push(`It is facts and code only. Line numbers are real: cite them as \`[evidence: path:start-end]\`. Read more of the repo only for what this doesn't show (types, tests, config).`, "");

  const unit = (u) => `- \`${u.id}\` at \`${u.at}\`${u.seed ? " (seed)" : ""}${u.tier ? ` [${u.tier}]` : ""}${u.shared?.length ? ` via ${u.shared.slice(0, 2).map((s) => `\`${s.symbol}\``).join(", ")}` : ""}${u.shared_literals?.length ? ` shares state ${u.shared_literals.map((l) => `\`${l}\``).join(", ")}` : ""}`;
  out.push(`## Scope`, "");
  for (const [title, list] of [
    ["Routes", sc.routes],
    ["Webhooks", sc.webhooks],
    ["Timers and jobs", sc.timers],
  ]) {
    if (!list?.length) continue;
    out.push(`**${title}**`, "", ...list.map(unit), "");
  }
  if (sc.callers?.length) out.push(`**Other callers into this feature** (not routes or timers)`, "", ...sc.callers.map((c) => `- \`${c.name}\` at \`${c.at}\` calls ${c.calls.map((x) => `\`${x}\``).join(", ")}`), "");
  if (sc.schemas?.length) out.push(`**Tables**`, "", ...sc.schemas.map((t) => `- \`${t.table ?? t.name}\` at \`${t.at}\``), "");

  if (contract) {
    const ids = new Set([...sc.routes, ...sc.webhooks].map((r) => normRoute(r.id)));
    const d = drift(g, contract, inv.routes.filter((r) => ids.has(normRoute(r.id))), { scoped: true, scopeIds: ids });
    out.push(`## Contract (\`${contract.file}\`)`, "");
    out.push(`${d.summary.documented_ops} documented operation(s) in scope, ${d.summary.implemented_routes} implemented route(s).`);
    if (d.documented_not_implemented.length) out.push("", `Documented but not implemented: ${d.documented_not_implemented.map((o) => `\`${o.id}\``).join(", ")}.`);
    if (d.implemented_not_documented.length) out.push("", `Implemented but not documented: ${d.implemented_not_documented.map((o) => `\`${o.id}\``).join(", ")}.`);
    for (const o of d.operations) {
      const notes = [
        ...(o.undocumented_statuses ?? []).map((u) => `returns ${u.status} at \`${u.at}\` (undocumented)`),
        ...(o.unreturned_statuses ?? []).map((u) => `documents ${u.status}, never returned${u.maybe_from ? ` (maybe ${u.maybe_from.join(", ")})` : ""}`),
        ...(o.undeclared_body_fields ?? []).map((f) => `reads \`req.body.${f.field}\` at \`${f.at}\` (not in the schema)`),
      ];
      out.push("", `- \`${o.id}\`: ${notes.join("; ")}`);
    }
    out.push("");
  }

  // Who writes each status, from which state, and the bug-shaped patterns among them.
  const sm = stateMachine(g, sc);
  const smd = stateMachineMarkdown(sm);
  if (smd) out.push(smd);

  // Core code in full (seed handlers, their callees, core routes, webhooks, timers,
  // other callers, core tables: priority <= 5). Peripheral ranges only by location:
  // the agent opens one if it matters, instead of every turn re-reading all of them.
  const list = sc.read_list ?? [];
  const core = opts.all ? list : list.filter((r) => r.priority <= CORE_PRIORITY);
  const rest = opts.all ? [] : list.filter((r) => r.priority > CORE_PRIORITY);
  const code = bundle(repo, core, { budget: opts.budget ?? Infinity });
  out.push(`## Code`, "", `${code.printed} ranges, ${code.lines} lines, highest priority first.`, "", "```text", code.text.trimEnd(), "```", "");
  if (rest.length) out.push(`## Peripheral code (not included; open if relevant)`, "", ...rest.map((r) => `- \`${r.at}\`: ${r.why}`), "");
  const markdown = out.join("\n");
  return { markdown, scope: sc, states: sm, stats: { hints: sm.hints.length, ranges: code.printed, lines: code.lines, peripheral_listed: rest.length, chars: markdown.length } };
}
