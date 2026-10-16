// The one-screen verdict: a fixed block with one measured line per check and a
// verdict, so a person (or Claude, pasting it back) reads the state at a glance.
// Rows are [label, text, ok], where ok is true (●), false (✖) or null (·, info).

const mark = (ok) => (ok === true ? "●" : ok === false ? "✖" : "·");

export function renderCard({ title, rows, verdict, next = [] }) {
  const w = Math.max(...rows.map(([l]) => l.length), 7);
  const out = [`VERIDIC · ${title}`, ""];
  for (const [label, text, ok] of rows) out.push(`  ${mark(ok)} ${label.padEnd(w)}  ${text}`);
  out.push("", `  VERDICT ${verdict.ok ? `● ${verdict.text || "TRUE"}` : `✖ ${verdict.text}`}`);
  if (next.length) out.push("", ...next.slice(0, 3).map((n, i) => `  ${i ? "  " : "→ "}${n}`), ...(next.length > 3 ? [`    …and ${next.length - 3} more`] : []));
  return `${out.join("\n")}\n`;
}

/** A spec's card from its metrics row and the attention items that name it. */
export function specCard(s, attention) {
  const t = s._tests ?? {};
  const rows = [
    ["citations", `${s.citations ?? 0} cited, ${s.citations_resolving_pct ?? "—"}% resolve · ${s.anchored_pct ?? 0}% anchored`, s.citations_resolving_pct === 100],
    ["claims", s.claim_support_pct == null ? "no checkable facts" : `${s.claim_support_pct}% of stated facts are in the cited lines`, s.claim_support_pct == null ? null : s.claim_support_pct === 100],
    ["tests", t.requirements ? `${t.with_tests} of ${t.requirements} requirements${t.criteria ? ` · ${t.criteria_covered} of ${t.criteria} criteria` : ""}${t.weak_tests?.length ? ` · ${t.weak_tests.length} weak` : ""}${t.tests_asserting_nothing?.length ? ` · ${t.tests_asserting_nothing.length} assert nothing` : ""}${s.passing_pct != null ? ` · ${s.passing_pct}% passing` : ""}` : "no tests linked", t.requirements ? (s._failing?.length || t.tests_asserting_nothing?.length ? false : t.with_tests === t.requirements ? true : null) : null],
    ["stale", `${s.stale_requirements ?? "—"} requirement(s) · ${s.citations_to_update ?? "—"} citation(s) to move`, s.stale_requirements === 0 && !s.citations_to_update],
    ...(s.uncited_constants != null ? [["deps", `${s.dependency_score_pct ?? "—"}% of constants the cited code depends on are cited`, s.uncited_constants === 0 ? true : null]] : []),
    ...(s.results_current != null ? [["results", s.results_current ? `current (code basis ${s._basis.now})` : `outdated: computed on ${s._basis.recorded}, code is now ${s._basis.now}`, s.results_current]] : []),
  ];
  const mine = attention.filter((a) => a.startsWith(`${s.spec}:`)).map((a) => a.slice(s.spec.length + 2));
  return renderCard({ title: s.spec, rows, verdict: { ok: !mine.length, text: mine.length ? `${mine.length} TO FIX` : "" }, next: mine });
}
