#!/usr/bin/env node
// What will this change reach? Before editing, `impact src/file.ts` (or
// `file:12-40`, or a route like "POST /api/orders") lists every route whose code
// runs it, what each route really does (writes, deletes, moves money), and which
// tests reach that code. The routes that move money or delete come first.

import { openGraph } from "../../core/graph.mjs";
import { routeInventory } from "../../core/routes.mjs";
import { impact } from "../../core/impact.mjs";
import { renderCard } from "../../core/card.mjs";
import { parseArgs, emit, fail, run, writeAll } from "./_cli.mjs";

const usage = 'impact.mjs --repo <path> <file | file:12-40 | "METHOD /path"> … [--card]';

run(() => {
  const a = parseArgs(process.argv.slice(2), { flags: ["repo"], bools: ["card"] });
  if (!a.repo || !a._.length) fail("need --repo and at least one file, range or route", usage);
  const g = openGraph(a.repo);
  const r = impact(g, routeInventory(g), a._);
  if (a.card) {
    const s = r.summary;
    const top = r.routes.slice(0, 6).map((x) => [x.moves_money ? "money" : x.effect, `${x.route}${x.hops ? ` (via ${x.via})` : ""}`, x.moves_money || x.effect === "destructive" ? false : null]);
    const rows = [
      ["reaches", `${s.routes} route(s): ${s.moves_money} move money, ${s.destructive} delete, ${s.writes} write`, null],
      ...top,
      ...(r.routes.length > 6 ? [["", `…and ${r.routes.length - 6} more`, null]] : []),
      ["tests", s.files_without_asserting_tests.length ? `no asserting test reaches ${s.files_without_asserting_tests.join(", ")}` : "every target is reached by an asserting test", !s.files_without_asserting_tests.length],
    ];
    const next = [...(s.moves_money || s.destructive ? ["Read the money and delete routes above before editing; add a test for them if none reaches this code."] : []), ...(r.unknown ?? []).map((u) => `${u}: not a route or file here`)];
    writeAll(renderCard({ title: `impact of ${r.targets.join(", ")}`, rows, verdict: { ok: !s.files_without_asserting_tests.length, text: s.files_without_asserting_tests.length ? "UNTESTED CODE" : "COVERED" }, next }));
    process.exit(0);
  }
  emit(r, 0);
}, usage);
