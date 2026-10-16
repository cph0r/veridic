#!/usr/bin/env node
// Is it done? `done FR-002 FR-003` checks the requirements an agent says it
// implemented: the change stayed in their seam (cited or declared files and
// their tests), and every verification criterion has an asserting test
// (passing, with --run). With no ids it checks every requirement the change
// touched. Exit 1 when not done.

import { doneCheck } from "../../core/seam.mjs";
import { renderCard } from "../../core/card.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = "done.mjs --repo <path> --spec <spec.md> [FR-002 …] [--range <base..head>] [--run] [--card]";

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo", "spec", "range"], bools: ["run", "card"] });
  if (!a.repo || !a.spec) fail("need --repo and --spec", usage);
  const r = doneCheck(a.repo, a.spec, { ids: a._, range: a.range, run: !!a.run });
  if (a.card) {
    const rows = [
      ["claimed", r.claimed.length ? r.claimed.join(", ") : "nothing: the change touched no requirement's seam", r.claimed.length ? null : false],
      ["seam", r.seam.strays.length ? `${r.seam.strays.length} stray file(s) outside the claimed requirements` : `held: ${r.seam.held} changed file(s), all in the seam of what was claimed`, !r.seam.strays.length],
      ...r.requirements.map((q) => [q.id, q.problems.length ? q.problems.join("; ") : `${q.status}${q.criteria ? ` · ${q.criteria} criteria` : ""}${q.note ? ` · ${q.note}` : ""}`, !q.problems.length]),
      ["range", r.range, null],
    ];
    const next = [...(r.unknown_ids ?? []).map((id) => `${id} isn't in this spec`), ...r.seam.strays.map((s) => `stray: ${s}`), ...r.requirements.flatMap((q) => q.problems.map((p) => `${q.id}: ${p}`))];
    writeAll(renderCard({ title: `done? ${r.spec}`, rows, verdict: { ok: r.done, text: r.done ? "DONE" : "NOT DONE" }, next }));
    process.exit(r.done ? 0 : 1);
  }
  emit(r, r.done ? 0 : 1);
}, usage);
