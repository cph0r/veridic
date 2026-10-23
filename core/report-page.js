// Veridic report page. Reads the JSON embedded in the page and renders it; no
// network, no dependencies. The page is the app's specs and nothing else: a
// sentence on how true and proven they are, every spec as a card, and each spec
// opened: its user stories, its rules, and for every rule whether it is proven,
// broken, out of date, pointing at code that's gone, or not tested yet.
// An observability tool: it shows the state of the specs; it never acts on them.
//
// veridicModel(D) is everything the page says, computed from the data; the view
// below only draws it. The tests load this file without a browser and call it.

/* eslint-disable no-var */
var veridicModel = (D) => {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const and = (list) => list.join(", ").replace(/, ([^,]*)$/, " and $1");

  // ---- a rule's test status, and its state on the page ----
  const REQ = {
    passing: ["Tested, passing", "good"], covered: ["Proven by a test", "good"], failing: ["Its test is failing", "bad"], unasserted: ["Its test checks nothing", "warn"],
    tagged_only: ["Its test misses the code", "warn"], todo: ["Its test is a todo", "none"], none: ["Not tested yet", "none"],
    broken: ["Broken, proven", "bad"], // an expected-failure test shows the code breaks the rule
    marker_stale: ["Fixed: make its test a normal one", "warn"], // the expected-failure test now fails
  };
  const statusOf = (r) => { const [label, tone] = REQ[r.status] || REQ.none; return { label, tone }; };
  // What the page says about a rule, worst first: the code breaks it; it cites code that's gone;
  // the code it cites changed since it was written; its test is weak; no test yet; proven.
  const STATE = {
    broken: { key: "broken", tone: "bad", mark: "!", label: null },
    lost: { key: "lost", tone: "warn", mark: "?", label: "Points at code that's gone" },
    stale: { key: "stale", tone: "warn", mark: "~", label: "Out of date: the code changed after it was written" },
    proven: { key: "proven", tone: "good", mark: "✓", label: null },
    weak: { key: "weak", tone: "warn", mark: "?", label: null },
    untested: { key: "untested", tone: "none", mark: "–", label: null },
  };
  const lost = (r) => (r.cites || []).some((c) => c.resolves === false);
  const stateOf = (r) => {
    const s = statusOf(r);
    const st = s.tone === "bad" ? STATE.broken : lost(r) ? STATE.lost : r.stale ? STATE.stale : s.tone === "good" ? STATE.proven : s.tone === "warn" ? STATE.weak : STATE.untested;
    return { ...st, label: st.label || s.label };
  };
  const RANK = { broken: 0, lost: 1, stale: 2, weak: 3, untested: 4, proven: 5 };

  // ---- a rule in plain words: its first clause, the rest on tap ----
  const fmt = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  function ruleText(r) {
    let t = String(r.text || "").replace(/\s*\(holds: no\)\.?/i, ".");
    t = t.replace(/\bMUST NOT\b/g, "must not").replace(/\bMUST\b/g, "must").replace(/\bSHOULD\b/g, "should");
    t = t.replace(/^(The system|The API|The server|The app|It) (must|should)/, (_, w, m) => cap(m));
    let first = t.match(/^.+?(?=,\s+and\s|[.;](?:\s|$)|\s\()/)?.[0] ?? t;
    if (first.length > 140) { const cut = first.lastIndexOf(",", 140); if (cut > 40) first = first.slice(0, cut); }
    const rest = t.slice(first.length).replace(/^[.;,]\s*/, "").trim();
    return { head: fmt(cap(first)), rest: rest ? fmt(cap(rest)) : "" };
  }

  // ---- the specs ----
  const nameOf = (s) => (s.doc && s.doc.title) || String(s.path).split("/").slice(-2)[0].replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const specs = (D.specs || []).map((s) => {
    const rules = (s.requirements || []).filter((r) => r.requirement !== false);
    const by = (k) => rules.filter((r) => stateOf(r).key === k);
    const sp = { path: s.path, name: nameOf(s), rules, stories: (s.doc && s.doc.stories) || [], meta: (s.doc && s.doc.meta) || {},
      broken: by("broken"), lost: by("lost"), stale: by("stale"), proven: by("proven"), weak: by("weak"),
      untested: rules.filter((r) => statusOf(r).tone === "none") };
    sp.tone = !rules.length ? "none" : sp.broken.length ? "bad" : sp.lost.length || sp.stale.length || sp.weak.length ? "warn" : sp.untested.length ? "todo" : "good";
    sp.outdated = sp.stale.length + sp.lost.length;
    sp.health = { bad: "Broken", warn: sp.outdated ? "Out of date" : "Weak tests", todo: sp.proven.length ? "Partly proven" : "Not tested", good: "Proven", none: "No rules" }[sp.tone];
    sp.files = new Set(rules.flatMap((r) => (r.cites || []).map((c) => c.file).filter(Boolean))).size;
    return sp;
  });
  const TONE = { bad: 0, warn: 1, todo: 2, none: 3, good: 4 };
  const trouble = (s) => s.broken.length + s.stale.length + s.lost.length;
  specs.sort((a, b) => TONE[a.tone] - TONE[b.tone] || trouble(b) - trouble(a) || b.rules.length - a.rules.length);
  const S = new Map(specs.map((s) => [s.path, s]));

  // ---- the parts of the app, each with its one spec ----
  // The same rule as core/parts.mjs: a spec file in a folder named exactly after a part
  // is that part's; else the part whose code its rules cite most (ties: the first); else
  // the part whose id is the longest prefix of its folder (orders-…); else it stands
  // alone as a part of its own ("other"). A part may have no spec yet.
  const partDefs = [
    ...(D.modules || []).map((m) => ({ id: m.id, name: m.name, kind: "module", files: new Set([...(m.files || []), ...(m.code || [])]) })),
    ...(D.screens || []).map((g) => ({ id: g.id, name: g.name, kind: "screens", files: new Set(g.files || []) })),
  ];
  const home = new Map(); // spec path -> part id
  for (const sp of specs) {
    const cited = sp.rules.flatMap((r) => (r.cites || []).map((c) => c.file).filter(Boolean));
    let best = null;
    for (const d of partDefs) { const n = cited.filter((f) => d.files.has(f)).length; if (n && (!best || n > best[1])) best = [d.id, n]; }
    const dir = String(sp.path).split("/").slice(-2)[0];
    const exact = partDefs.find((d) => dir === d.id);
    const prefix = partDefs.filter((d) => dir.startsWith(d.id + "-")).sort((a, b) => b.id.length - a.id.length)[0];
    home.set(sp.path, exact ? exact.id : best ? best[0] : prefix ? prefix.id : sp.path);
  }
  const partOf = (specPath) => home.get(specPath) || specPath;
  const coverOf = new Map(((D.coverage || {}).parts || []).map((c) => [c.id, c]));
  const makePart = (id, name, kind, ss) => {
    const all = (k) => ss.flatMap((x) => x[k]);
    const p = { id, name, kind, specs: ss, path: ss.length ? ss[0].path : null, rules: all("rules"), stories: all("stories"), broken: all("broken"), stale: all("stale"), lost: all("lost"), proven: all("proven"), weak: all("weak"), untested: all("untested") };
    p.outdated = p.stale.length + p.lost.length;
    p.files = new Set(p.rules.flatMap((r) => (r.cites || []).map((c) => c.file).filter(Boolean))).size;
    p.tone = !p.rules.length ? "none" : p.broken.length ? "bad" : p.outdated || p.weak.length ? "warn" : p.untested.length ? "todo" : "good";
    p.health = !ss.length ? "No spec" : { bad: "Broken", warn: p.outdated ? "Out of date" : "Weak tests", todo: p.proven.length ? "Partly proven" : "Not tested", good: "Proven", none: "No rules" }[p.tone];
    const c = coverOf.get(id);
    p.covered = c ? { total: c.total, covered: c.covered } : null;
    return p;
  };
  const parts = [
    ...partDefs.map((d) => makePart(d.id, d.name, d.kind, specs.filter((x) => home.get(x.path) === d.id))),
    ...specs.filter((x) => !partDefs.some((d) => d.id === home.get(x.path))).map((x) => makePart(x.path, x.name, "other", [x])),
  ];
  const PTONE = (p) => (p.specs.length ? TONE[p.tone] : 9); // parts with no spec last
  const ptrouble = (p) => p.broken.length + p.outdated;
  parts.sort((a, b) => PTONE(a) - PTONE(b) || ptrouble(b) - ptrouble(a) || b.rules.length - a.rules.length);

  // The table: one row per part; filter by health and text, sort by any column (default: worst first).
  const FILTERS = {
    all: () => true, fix: (s) => s.broken.length || s.outdated, broken: (s) => s.broken.length,
    stale: (s) => s.outdated, untested: (s) => s.untested.length, proven: (s) => s.tone === "good" && s.specs.length > 0,
    nospec: (s) => !s.specs.length,
  };
  const SORTS = {
    name: (s) => s.name.toLowerCase(), health: (s) => TONE[s.tone], rules: (s) => s.rules.length,
    proven: (s) => (s.rules.length ? s.proven.length / s.rules.length : -1), broken: (s) => s.broken.length,
    outdated: (s) => s.outdated, untested: (s) => s.untested.length, stories: (s) => s.stories.length, files: (s) => s.files,
    covered: (s) => (s.covered && s.covered.total ? s.covered.covered / s.covered.total : -1),
  };
  const rows = ({ q = "", filter = "all", sort = null, dir = "desc" } = {}) => {
    const needle = String(q).trim().toLowerCase();
    const out = parts.filter((s) => (FILTERS[filter] || FILTERS.all)(s) && (!needle || (s.name + " " + s.id + " " + s.specs.map((x) => x.path + " " + x.name).join(" ")).toLowerCase().includes(needle)));
    if (!sort || !SORTS[sort]) return out; // already worst first
    const k = SORTS[sort], sign = dir === "asc" ? 1 : -1;
    return out.map((s, i) => [s, i]).sort(([a, i], [b, j]) => { const x = k(a), y = k(b); return x < y ? -sign : x > y ? sign : i - j; }).map(([s]) => s);
  };

  // ---- the numbers: rules, counted the way the cards count them ----
  const sum = (f) => specs.reduce((n, s) => n + f(s), 0);
  const counts = {
    specs: specs.length, rules: sum((s) => s.rules.length), stories: sum((s) => s.stories.length),
    proven: sum((s) => s.proven.length), broken: sum((s) => s.broken.length), stale: sum((s) => s.stale.length), lost: sum((s) => s.lost.length),
    weak: sum((s) => s.weak.length), untested: sum((s) => s.untested.length),
    true: sum((s) => s.rules.filter((r) => !r.stale && !lost(r)).length),
    // how much of the app's behaviour code the specs cite (veridic coverage)
    behaviour: (D.coverage && D.coverage.behaviour) || 0, covered: (D.coverage && D.coverage.covered) || 0,
  };

  // Fix first: rules the code breaks, then rules that point at code that's gone or describe code that changed.
  const fix = [], later = [];
  for (const s of specs) for (const r of s.broken) fix.push({ n: 1, tone: "bad", spec: s.path, rule: r.id, html: ruleText(r).head, w: (statusOf(r).label === "Broken, proven" ? "Broken, proven: the code doesn't do this today." : esc(statusOf(r).label) + ".") + " " + esc(r.id) + "." });
  for (const s of specs) if (s.lost.length) fix.push({ n: s.lost.length, tone: "warn", spec: s.path, rule: s.lost[0].id, html: esc(s.lost.length === 1 ? "A rule points at code that's gone" : s.lost.length + " rules point at code that's gone"), w: "The file or lines " + (s.lost.length === 1 ? "it cites" : "they cite") + " no longer exist, so nothing can check " + (s.lost.length === 1 ? "it." : "them.") });
  for (const s of specs) if (s.stale.length) fix.push({ n: s.stale.length, tone: "warn", spec: s.path, rule: s.stale[0].id, html: esc(s.stale.length === 1 ? "A rule is out of date" : s.stale.length + " rules are out of date"), w: "The code " + (s.stale.length === 1 ? "it describes" : "they describe") + " changed after " + (s.stale.length === 1 ? "it was" : "they were") + " written. Check " + (s.stale.length === 1 ? "it still holds." : "they still hold.") });
  // When you have time: rules whose test is weak, rules with no test yet.
  for (const s of specs) if (s.weak.length) later.push({ tone: "warn", spec: s.path, rule: s.weak[0].id, html: esc(plural(s.weak.length, "rule") + (s.weak.length === 1 ? " has a test" : " have tests") + " that don't really check " + (s.weak.length === 1 ? "it" : "them")), w: "A test that checks nothing passes even when the code is wrong." });
  const most = [...specs].filter((s) => s.untested.length).sort((a, b) => b.untested.length - a.untested.length);
  if (most.length) { const n = most.reduce((k, s) => k + s.untested.length, 0); later.push({ tone: "todo", spec: most[0].path, html: esc(plural(n, "rule") + (n === 1 ? " has" : " have") + " no test yet"), w: esc(most.length === 1 ? "All in " + most[0].name + "." : "Across " + plural(most.length, "spec") + "; most in " + most[0].name + " (" + most[0].untested.length + ").") }); }

  // The files no spec describes yet, pointing at the part with the most (through its spec).
  const gap = counts.behaviour - counts.covered;
  if (counts.behaviour && gap > 0) {
    const cov = D.coverage, parts = [...(cov.parts || [])].sort((a, b) => b.uncovered.length - a.uncovered.length);
    const top = parts[0] && parts[0].uncovered.length >= (cov.orphans || []).length ? { name: parts[0].name, n: parts[0].uncovered.length, id: parts[0].id } : { name: "code in no part", n: (cov.orphans || []).length, id: null };
    const owner = [...(D.modules || []), ...(D.screens || [])].find((m) => m.id === top.id);
    const spec = owner && (owner.specs || []).find((p) => S.has(p)) || null;
    later.push({ tone: "todo", spec, html: esc(plural(gap, "file") + " no spec describes"), w: esc("Most in " + top.name + " (" + top.n + "). veridic coverage lists them.") });
  }

  // ---- the headline ----
  const is = (n, one, many) => (n === 1 ? one : many);
  const problems = [
    counts.broken && plural(counts.broken, "rule") + is(counts.broken, " is", " are") + " broken",
    counts.stale && (counts.broken ? counts.stale + is(counts.stale, " is", " are") : plural(counts.stale, "rule") + is(counts.stale, " is", " are")) + " out of date",
    counts.lost && (counts.broken || counts.stale ? String(counts.lost) : plural(counts.lost, "rule")) + is(counts.lost, " points", " point") + " at code that's gone",
  ].filter(Boolean);
  const todo = counts.untested + counts.weak;
  const verdict = !specs.length ? "No specs yet."
    : problems.length ? '<em class="' + (counts.broken ? "c-bad" : "c-warn") + '">' + cap(and(problems)) + "</em>."
    : todo ? 'Your specs are up to date; <em class="c-warn">' + plural(todo, "rule") + "</em> still need" + is(todo, "s", "") + " a test."
    : 'Every rule is true to the code <em class="c-good">and proven.</em>';
  const app = D.app || {};

  // One page of rows: size 0 shows all; a page past either end shows the nearest one.
  const page = (list, { page: p = 1, size = 10 } = {}) => {
    const total = list.length, pages = size > 0 ? Math.max(1, Math.ceil(total / size)) : 1;
    const at = Math.min(Math.max(1, p | 0 || 1), pages);
    const items = size > 0 ? list.slice((at - 1) * size, at * size) : list;
    return { items, page: at, pages, total, from: total ? (size > 0 ? (at - 1) * size + 1 : 1) : 0, to: size > 0 ? Math.min(at * size, total) : total };
  };
  const P = new Map(parts.map((p) => [p.id, p]));
  // A view saved by an earlier version: a sort with no column, or a filter with no rows, resets.
  const VISIBLE_SORTS = ["name", "health", "rules", "proven", "stories", "covered"];
  const cleanView = (v) => ({ ...v, sort: VISIBLE_SORTS.includes(v.sort) ? v.sort : null, filter: v.filter && FILTERS[v.filter] && (v.filter === "all" || rows({ filter: v.filter }).length) ? v.filter : "all" });
  // Where a rule lives: its part, and the spec file it is in (ids repeat across a part's files).
  const ruleHome = (id, specPath) => ({ part: partOf(specPath), spec: specPath });
  // ---- a part's sheet: its stories with the rules they name, and its rules by state ----
  // A story's rules: the ids its scenarios name, from its own spec file, each once, in order.
  const storiesOf = (p) => p.specs.flatMap((sp) => (sp.stories || []).map((st) => {
    const ids = [...new Set((st.scenarios || []).flatMap((x) => x.refs || []))];
    return { story: st, spec: sp.path, rules: ids.map((id) => sp.rules.find((r) => r.id === id)).filter(Boolean) };
  }));
  const rulesInNoStory = (p) => p.specs.flatMap((sp) => {
    const named = new Set((sp.stories || []).flatMap((st) => (st.scenarios || []).flatMap((x) => x.refs || [])));
    return sp.rules.filter((r) => !named.has(r.id)).map((r) => ({ spec: sp.path, rule: r }));
  });
  // Each rule in exactly one state (its first in RANK), so the counts add up to all.
  const RULE_STATES = {
    all: () => true,
    attention: (r) => ["broken", "lost", "stale"].includes(stateOf(r).key),
    weak: (r) => stateOf(r).key === "weak",
    untested: (r) => stateOf(r).key === "untested",
    proven: (r) => stateOf(r).key === "proven",
  };
  const partRules = (p, { state = "all", q = "" } = {}) => {
    const needle = String(q).trim().toLowerCase();
    return p.specs.flatMap((sp) => sp.rules.map((r) => ({ spec: sp.path, rule: r })))
      .filter(({ rule }) => (RULE_STATES[state] || RULE_STATES.all)(rule) && (!needle || (rule.id + " " + rule.text).toLowerCase().includes(needle)))
      .sort((a, b) => RANK[stateOf(a.rule).key] - RANK[stateOf(b.rule).key]);
  };
  const ruleCounts = (p) => Object.fromEntries(Object.keys(RULE_STATES).map((k) => [k, partRules(p, { state: k }).length]));
  return { storiesOf, rulesInNoStory, partRules, ruleCounts, rows, page, parts, partOf, P, ruleHome, cleanView, specs, S, counts, fix, later, verdict, title: app.title || D.name, stateOf, statusOf, ruleText, RANK, plural, esc, cap, REQ };
};

(() => {
  "use strict";
  if (typeof document === "undefined") return;
  const D = JSON.parse(document.getElementById("data").textContent);
  const M = veridicModel(D);
  const { specs, S, counts, esc, plural } = M;
  const $ = (s) => document.querySelector(s);
  const store = {
    get: (k) => { try { return localStorage.getItem("veridic-" + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem("veridic-" + k, v); } catch {} },
  };
  const ago = (d) => { const s = (Date.now() - new Date(d)) / 1000; return s < 90 ? "Checked just now" : s < 5400 ? "Checked " + Math.round(s / 60) + " min ago" : "Checked " + new Date(d).toLocaleString(); };
  const hid = (g) => (g ? ' data-g="' + g + '"' : "");
  let open = null; // the spec open in the sheet

  // ---- the shell ----
  $("#app").innerHTML = `<div class="wrap">
  <section class="hero"><div class="rv"><h1 class="verdict" id="appname"></h1></div><div class="rings rv" id="rings" style="animation-delay:.12s"></div></section>
  <section id="specs-sec"><h2 class="sr">Your app</h2>
  <div class="tools rv" style="animation-delay:.22s"><input id="q" type="search" placeholder="Search parts and specs" aria-label="Search parts and specs"><label class="pick"><span>Show</span><select id="filters" aria-label="Show"></select></label></div>
  <div class="tablewrap rv" style="animation-delay:.25s"><table class="specs"><thead><tr id="thead"></tr></thead><tbody id="tbody"></tbody></table><div class="noresults" id="noresults" hidden>No part matches.</div></div><div class="pager" id="pager"></div></section>
  <div class="key rv" aria-label="Key"><span class="key-h">Key</span><span><i class="sw good"></i>Proven by a test</span><span><i class="sw bad"></i>Broken</span><span><i class="sw warn"></i>Out of date</span><span><i class="sw weak"></i>Weak test</span><span><i class="sw none"></i>Not tested</span><span><b class="rev">Δ</b>Changed in the code since written</span></div>
  <footer class="foot" id="foot"></footer>
</div>
<div class="scrim" id="scrim"></div>
<aside class="sheet" id="panel" aria-label="Spec"><div class="grab"></div><div class="part" id="part"></div></aside>
<div class="confetti" id="confetti"></div>`;

  // ---- hero: the app's name and the gauges ----
  $("#appname").textContent = M.title;
  const colorFor = (p) => (p >= 90 ? "var(--good)" : p >= 60 ? "var(--warn)" : "var(--bad)");
  const ring = (p, lbl, sub, color) => { const C = 2 * Math.PI * 33; return '<div class="ring" tabindex="0"><svg viewBox="0 0 78 78"><circle class="track" cx="39" cy="39" r="33" fill="none" stroke-width="7"/><circle class="arc" cx="39" cy="39" r="33" fill="none" stroke-width="7" stroke="' + (color || colorFor(p)) + '" stroke-dasharray="' + C + '" stroke-dashoffset="' + C + '" data-to="' + C * (1 - p / 100) + '"/></svg><div class="num" data-n="' + p + '">0%</div><div class="lbl">' + lbl + '</div><div class="sub">' + sub + "</div></div>"; };
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  if (counts.rules) $("#rings").innerHTML =
    ring(pct(counts.true, counts.rules), "Up to date", "Rules that still match the code they point to (" + counts.true + " of " + counts.rules + ").") +
    ring(pct(counts.proven, counts.rules), "Proven", "Rules a test proves (" + counts.proven + " of " + counts.rules + ")." + (counts.broken ? " " + plural(counts.broken, "rule") + " broken." : ""), counts.broken ? "var(--bad)" : pct(counts.proven, counts.rules) >= 90 ? "var(--good)" : "var(--warn)") +
    (counts.behaviour ? ring(pct(counts.covered, counts.behaviour), "Covered", "Code files a spec describes (" + counts.covered + " of " + counts.behaviour + "). Tests, config and generated files don't count.") : "");

  // ---- every part of the app, as a row: filter by health or text, sort by any column ----
  const COLS = [
    ["name", "Part", "text"], ["health", "Health", "text"], ["rules", "Rules", "num"], ["proven", "Proven", "bar", "Each part's rules: proven, needing attention, weak test, not tested (hatched)"],
    ["stories", "Stories", "num"], ["covered", "Covered", "num", "The part's code files a spec describes"],
  ];
  const FILTER = [["all", "All"], ["fix", "Needs fixing"], ["stale", "Out of date"], ["untested", "Not tested"], ["proven", "Proven"], ["nospec", "No spec"]];
  let view = { q: "", filter: "all", sort: null, dir: "desc", page: 1, size: 10 };
  try { view = M.cleanView({ ...view, ...JSON.parse(store.get("table:" + D.name) || "{}") }); } catch {}
  const num = (n, cls) => (n ? '<span class="' + (cls || "") + '">' + n + "</span>" : '<span class="zero">–</span>');
  // A part's rules as one bar, one segment per state (each rule in exactly one), not tested hatched.
  const SEGS = [["proven", "good", "proven"], ["attention", "warn", "need attention"], ["weak", "weak", "weak test"], ["untested", "none", "not tested"]];
  const ruleBar = (p) => {
    const c = M.ruleCounts(p), n = c.all;
    const tip = SEGS.filter(([k]) => c[k]).map(([k, , w]) => c[k] + " " + w).join(" · ");
    return '<div class="pv" title="' + esc(tip) + '"><span>' + c.proven + "<small> /" + n + '</small></span><i class="rbar">' + SEGS.filter(([k]) => c[k]).map(([k, tone]) => '<b class="' + (k === "attention" && p.broken.length ? "bad" : tone) + '" style="width:' + (100 * c[k]) / n + '%"></b>').join("") + "</i></div>";
  };
  const rowHTML = (p) => {
    const cov = p.covered && p.covered.total ? p.covered.covered + '<small> /' + p.covered.total + "</small>" : '<span class="zero">–</span>';
    const delta = p.outdated ? ' <span class="rev" title="' + esc(plural(p.outdated, "rule") + " changed in the code since written") + '">Δ' + p.outdated + "</span>" : "";
    return '<tr data-part="' + esc(p.id) + '" tabindex="0"' + (open === p.id ? ' class="sel"' : "") + '><td class="c-name"><div class="snm">' + esc(p.name) + delta + "</div></td>" +
      '<td><span class="hl ' + (p.specs.length ? p.tone : "nospec") + '">' + esc(p.health) + "</span></td>" +
      '<td class="num">' + num(p.rules.length) + "</td>" +
      '<td class="bar">' + (p.rules.length ? ruleBar(p) : '<span class="zero">–</span>') + "</td>" +
      '<td class="num">' + num(p.stories.length) + '</td><td class="num">' + cov + "</td></tr>";
  };
  function drawTable() {
    store.set("table:" + D.name, JSON.stringify(view));
    $("#thead").innerHTML = COLS.map(([k, label, kind, tip]) => '<th class="' + kind + '" aria-sort="' + (view.sort === k ? (view.dir === "asc" ? "ascending" : "descending") : "none") + '"><button data-sort="' + k + '"' + (tip ? ' title="' + tip + '"' : "") + ">"+ label + '<span class="arrow">' + (view.sort === k ? (view.dir === "asc" ? "↑" : "↓") : "") + "</span></button></th>").join("");
    $("#filters").innerHTML = FILTER.map(([k, label]) => { const n = M.rows({ filter: k }).length; return k === "nospec" && !n ? "" : '<option value="' + k + '"' + (view.filter === k ? " selected" : "") + ">" + (k === "all" ? "All parts" : label) + " (" + n + ")</option>"; }).join("");
    const pg = M.page(M.rows(view), view);
    view.page = pg.page;
    $("#tbody").innerHTML = pg.items.map(rowHTML).join("");
    $("#noresults").hidden = pg.total > 0;
    // Pages: "1–10 of 30", previous/next, numbers (the first, the last and two around this one), rows per page.
    const nums = [];
    for (let i = 1; i <= pg.pages; i++) if (i === 1 || i === pg.pages || Math.abs(i - pg.page) <= 1) nums.push(i); else if (nums[nums.length - 1] !== "…") nums.push("…");
    $("#pager").innerHTML = pg.total <= 10 && view.size === 10 ? "" :
      '<span class="pinfo">' + pg.from + "–" + pg.to + " of " + pg.total + '</span><span class="pnav"><button data-page="' + (pg.page - 1) + '" aria-label="Previous page"' + (pg.page <= 1 ? " disabled" : "") + ">‹</button>" +
      nums.map((n) => (n === "…" ? '<span class="pgap">…</span>' : '<button data-page="' + n + '"' + (n === pg.page ? ' aria-current="page"' : "") + ">" + n + "</button>")).join("") +
      '<button data-page="' + (pg.page + 1) + '" aria-label="Next page"' + (pg.page >= pg.pages ? " disabled" : "") + '>›</button></span><label class="psize">Rows <select id="psize">' + [10, 25, 50, 0].map((n) => '<option value="' + n + '"' + (n === view.size ? " selected" : "") + ">" + (n || "All") + "</option>").join("") + "</select></label>";
  }
  if (M.parts.length) {
    $("#q").value = view.q;
    $("#filters").addEventListener("change", (ev) => { view.filter = ev.target.value; view.page = 1; drawTable(); });
    $("#q").addEventListener("input", () => { view.q = $("#q").value; view.page = 1; drawTable(); });
    $("#pager").addEventListener("change", (ev) => { if (ev.target.id === "psize") { view.size = +ev.target.value; view.page = 1; drawTable(); } });
    drawTable();
  }
  else { $("#specs-sec").remove(); $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">This repo has no specs yet. Ask Claude to <b>write a spec</b> for a part of your app (<code>veridic parts</code> lists them), then run <code>veridic report</code> again.</div>'); }

  // ---- a spec, in a sheet: what needs attention, its stories, its rules ----
  const fold = (g, items, render, n, label) => items.slice(0, n).map((x) => render(x)).join("") + items.slice(n).map((x) => render(x, g)).join("") + (items.length > n ? '<button class="showall" data-unfold="' + g + '">' + label(items.length - n) + " →</button>" : "");
  function ruleHTML(r, g) {
    const t = M.ruleText(r), st = M.stateOf(r);
    const where = (r.cites || []).map((c) => '<span class="loc' + (c.resolves === false ? " gone" : "") + '">' + esc(c.cite) + "</span>").join("");
    const tests = (r.tests || []).map((x) => '<span class="loc">' + esc(x) + "</span>").join("");
    const checks = (r.checks || []).map((c) => "<li>" + esc(c.text || "") + "</li>").join("");
    // A rule the code changed under (or whose code is gone) gets a revision cloud and a Δ, as on a drawing.
    const rev = st.key === "stale" || st.key === "lost";
    return '<button class="req' + (rev ? " rev-cloud" : "") + (g ? " x" : "") + '"' + hid(g) + ' data-rule="' + esc(r.id) + '"><span class="mark ' + st.tone + '">' + (rev ? "Δ" : st.mark) + '</span><span class="tx"><span><span class="rid">' + esc(r.id) + "</span> " + t.head + '</span><div class="why">' + esc(st.label) + "</div>" +
      '<div class="more">' + (t.rest ? "<p>" + t.rest + "</p>" : "") + (checks ? '<div class="mh">Checks</div><ul>' + checks + "</ul>" : "") + (where ? '<div class="mh">In the code</div>' + where : "") + (tests ? '<div class="mh">Proven by</div>' + tests : "") + "</div></span></button>";
  }
  // ---- a part's sheet, in three tabs: Overview, Stories, Rules ----
  const TABS = [["overview", "Overview"], ["stories", "Stories"], ["rules", "Rules"]];
  const RSTATES = [["all", "All"], ["attention", "Needs attention"], ["weak", "Weak test"], ["untested", "Not tested"], ["proven", "Proven"]];
  const tabOf = (k) => (TABS.some(([t]) => t === k) ? k : "overview");
  let sheet = { tab: tabOf(store.get("sheet-tab")), rstate: "all", q: "", by: "state" };
  const tag = (h, inn) => h.replace(/data-rule="/g, 'data-in="' + esc(inn) + '" data-rule="');
  const ruleRow = (x, g) => tag(ruleHTML(x.rule, g), x.spec);
  // one line per rule a story names: its state, id and first words; a tap opens it in Rules
  const ruleLine = (r, inn) => { const st = M.stateOf(r); return '<span class="rl" data-ref="' + esc(r.id) + '" data-in="' + esc(inn) + '"><span class="mark ' + st.tone + '">' + st.mark + '</span><span><span class="rid">' + esc(r.id) + "</span> " + M.ruleText(r).head + "</span></span>"; };
  function storyHTML(x, g) {
    const st = x.story, sc = (st.scenarios || []).map((s) => '<div class="scn"><div><b>Given</b> ' + esc(s.given) + "</div><div><b>When</b> " + esc(s.when) + "</div><div><b>Then</b> " + esc(s.then) + "</div></div>").join("");
    const proven = x.rules.filter((r) => M.stateOf(r).key === "proven").length;
    const meta = [st.why && esc(st.why), plural((st.scenarios || []).length, "scenario"), x.rules.length ? proven + " of " + plural(x.rules.length, "rule") + " proven" : "names no rules"].filter(Boolean).join(" · ");
    return '<button class="req story' + (g ? " x" : "") + '"' + hid(g) + '><span class="mark none">' + esc(st.priority || st.n || "") + '</span><span class="tx"><span>' + esc(st.title) + '</span><div class="why">' + meta + '</div><div class="more">' + (sc || "<p>No scenarios written.</p>") +
      (x.rules.length ? '<div class="mh">Rules it names</div>' + x.rules.map((r) => ruleLine(r, x.spec)).join("") : "") + "</div></span></button>";
  }
  function overviewHTML(p, rc) {
    const att = M.partRules(p, { state: "attention" });
    // The part's rules as a donut, one slice per state; each legend row opens those rules.
    const SLICES = [["proven", "Proven", "var(--good)"], ["attention", "Needs attention", "var(--bad)"], ["weak", "Weak test", "var(--warn)"], ["untested", "Not tested", "var(--line2)"]];
    const R = 34, C = 2 * Math.PI * R;
    let at = 0;
    const arcs = SLICES.filter(([k]) => rc[k]).map(([k, , color]) => { const len = (C * rc[k]) / rc.all, gap = SLICES.filter(([j]) => rc[j]).length > 1 ? 2 : 0; const a = '<circle cx="44" cy="44" r="' + R + '" fill="none" stroke="' + color + '" stroke-width="12" stroke-dasharray="' + Math.max(len - gap, 0.5) + " " + (C - Math.max(len - gap, 0.5)) + '" stroke-dashoffset="' + -at + '"/>'; at += len; return a; }).join("");
    const pie = '<div class="pie"><div class="donut"><svg viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="' + R + '" fill="none" stroke="var(--line)" stroke-width="12"/>' + arcs + '</svg><div class="mid"><b>' + rc.all + "</b><span>" + (rc.all === 1 ? "rule" : "rules") + '</span></div></div><div class="legend">' +
      SLICES.map(([k, label, color]) => '<button data-tab="rules" data-rstate="' + k + '"' + (rc[k] ? "" : " disabled") + '><i style="background:' + color + '"></i><span>' + label + "</span><b>" + rc[k] + "</b></button>").join("") + "</div></div>";
    const attention = att.length ? '<div class="sub-h">Needs attention</div>' + att.slice(0, 5).map((x) => ruleRow(x)).join("") + (att.length > 5 ? '<button class="showall" data-tab="rules" data-rstate="attention">See all ' + att.length + " in Rules →</button>" : "")
      : p.rules.length ? '<div class="calm"><span class="mark good">✓</span>Nothing needs attention: every rule still matches the code.</div>' : "";
    const files = '<div class="sub-h">' + (p.specs.length === 1 ? "Spec file" : plural(p.specs.length, "spec file")) + "</div>" + p.specs.map((sp) => '<div class="sfile"><div><b>' + esc(sp.name) + '</b><span class="path">' + esc(sp.path) + '</span></div><span class="sn">' + plural(sp.rules.length, "rule") + " · " + plural((sp.stories || []).length, "story", "stories") + "</span></div>").join("");
    return pie + (attention ? '<div class="blk">' + attention + "</div>" : "") + '<div class="blk">' + files + "</div>";
  }
  function storiesHTML(p) {
    const all = M.storiesOf(p), loose = M.rulesInNoStory(p);
    const list = all.length ? fold("st", all, storyHTML, 8, (k) => "Show " + k + " more stories") : '<div class="empty-req">No user stories written yet.</div>';
    const rest = loose.length ? '<div class="blk"><button class="req" data-unfold="ns"><span class="mark none">' + loose.length + '</span><span class="tx"><span><b>Rules in no story</b></span><div class="why">Rules no story names · tap to see them</div></span></button>' + loose.map((x) => ruleRow(x, "ns")).join("") + "</div>" : "";
    return list + rest;
  }
  function rulesList(p) {
    const list = M.partRules(p, { state: sheet.rstate, q: sheet.q });
    if (!list.length) return '<div class="empty-req">' + (p.rules.length ? "No rules match." : "No rules written yet.") + "</div>";
    const head = sheet.by === "file" ? (x) => { const sp = p.specs.find((s) => s.path === x.spec); return sp ? sp.name : x.spec; }
      : (x) => { const k = M.stateOf(x.rule).key; return ["broken", "lost", "stale"].includes(k) ? "Needs attention" : k === "proven" ? "Proven" : "Not proven yet"; };
    const groups = new Map();
    for (const x of list) { const h = head(x); if (!groups.has(h)) groups.set(h, []); groups.get(h).push(x); }
    return [...groups].map(([h, xs]) => '<div class="blk"><div class="sub-h">' + esc(h) + '<span class="x-n">' + xs.length + "</span></div>" + xs.map((x) => ruleRow(x)).join("") + "</div>").join("");
  }
  function rulesTabHTML(p, rc) {
    const pick = (id, label, opts, cur) => '<label class="pick"><span>' + label + '</span><select id="' + id + '" aria-label="' + label + '">' + opts.map(([k, l]) => '<option value="' + k + '"' + (cur === k ? " selected" : "") + ">" + l + "</option>").join("") + "</select></label>";
    return '<div class="rtools"><input id="rq" type="search" placeholder="Search rules" aria-label="Search rules" value="' + esc(sheet.q) + '"><div class="picks">' +
      pick("rstate", "Show", RSTATES.map(([k, l]) => [k, (k === "all" ? "All rules" : l) + " (" + rc[k] + ")"]), sheet.rstate) +
      pick("rby", "Group by", [["state", "State"], ["file", "Spec file"]], sheet.by) + '</div></div><div id="rlist">' + rulesList(p) + "</div>";
  }
  // A part's sheet: its head, the tabs, then only the open tab.
  function partHTML(p) {
    const head = '<div class="part-head"><div><h3' + (p.name.length > 40 ? ' class="long"' : "") + ">" + esc(p.name) + '</h3></div><button class="close" aria-label="Close">✕</button></div>';
    if (!p.specs.length) return head + '<div class="cols"><div><div class="empty-req">Nothing describes ' + esc(p.name) + ' yet. Ask Claude to <b>write a spec for ' + esc(p.name) + "</b> (<code>/veridic:specs</code> does every part that has none).</div></div></div>";
    const rc = M.ruleCounts(p), n = { overview: null, stories: p.stories.length, rules: rc.all };
    const tabs = '<div class="tabs" role="tablist">' + TABS.map(([k, label]) => '<button role="tab" data-tab="' + k + '" aria-selected="' + (sheet.tab === k) + '">' + label + (n[k] != null ? '<span class="n">' + n[k] + "</span>" : "") + "</button>").join("") + "</div>";
    const body = sheet.tab === "stories" ? storiesHTML(p) : sheet.tab === "rules" ? rulesTabHTML(p, rc) : overviewHTML(p, rc);
    return head + tabs + '<div class="tabbody" role="tabpanel">' + body + "</div>";
  }
  const drawSheet = () => { const p = M.P.get(open); if (p) $("#part").innerHTML = partHTML(p); };
  function setTab(tab, rstate) {
    sheet = { ...sheet, tab: tabOf(tab), ...(rstate ? { rstate, q: "" } : {}) };
    store.set("sheet-tab", sheet.tab);
    drawSheet();
    const tb = $("#part .tabs"); if (tb && $("#panel").scrollTop > tb.offsetTop) $("#panel").scrollTop = tb.offsetTop;
  }
  function openPart(id, rule, inSpec, keep) {
    const p = M.P.get(id); if (!p) return;
    const panel = $("#panel");
    if (open === id && panel.classList.contains("open") && !rule && !keep) { closeSpec(); return; }
    document.querySelectorAll("#tbody tr").forEach((c) => c.classList.toggle("sel", c.dataset.part === id));
    if (open !== id) sheet = { ...sheet, rstate: "all", q: "" };
    open = id;
    if (rule) sheet = { ...sheet, tab: "rules", rstate: "all", q: "" };
    drawSheet();
    panel.scrollTop = 0;
    panel.classList.add("open");
    document.body.classList.add("sheet-open");
    try { history.replaceState(null, "", "#" + encodeURIComponent(id)); } catch {}
    if (rule) showRule(rule, inSpec);
  }
  // A spec path (from a card or an old link) opens the part it belongs to.
  const openSpec = (path, rule) => openPart(M.ruleHome(rule, path).part, rule, path, true);
  // open a rule in the Rules tab: show every rule, open it, bring it into view
  function showRule(id, inSpec) {
    if (sheet.tab !== "rules" || sheet.rstate !== "all" || sheet.q) { sheet = { ...sheet, tab: "rules", rstate: "all", q: "" }; drawSheet(); }
    const el = [...document.querySelectorAll("#part [data-rule]")].find((x) => x.dataset.rule === id && (!inSpec || x.dataset.in === inSpec)); if (!el) return;
    el.classList.add("open", "flash");
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    setTimeout(() => el.classList.remove("flash"), 1600);
  }
  function closeSpec() {
    open = null;
    $("#panel").classList.remove("open");
    document.body.classList.remove("sheet-open");
    document.querySelectorAll("#tbody tr.sel").forEach((c) => c.classList.remove("sel"));
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && open) closeSpec();
    const tr = ev.target.closest && ev.target.closest("#tbody tr");
    if (tr && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); openPart(tr.dataset.part); }
  });
  $("#scrim").addEventListener("click", closeSpec);
  document.addEventListener("change", (ev) => { const id = ev.target.id; if (id !== "rstate" && id !== "rby") return; sheet[id === "rstate" ? "rstate" : "by"] = ev.target.value; const p = M.P.get(open); if (p) $("#rlist").innerHTML = rulesList(p); });
  document.addEventListener("input", (ev) => { if (ev.target.id !== "rq") return; sheet.q = ev.target.value; const p = M.P.get(open); if (p) $("#rlist").innerHTML = rulesList(p); });
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const so = t.closest("[data-sort]");
    // First click: names A to Z, numbers high to low; the next click reverses.
    if (so) { const k = so.dataset.sort, first = k === "name" ? "asc" : "desc"; view = { ...view, dir: view.sort === k ? (view.dir === "asc" ? "desc" : "asc") : first, sort: k, page: 1 }; drawTable(); return; }
    const pb = t.closest("[data-page]");
    if (pb && !pb.disabled) { view.page = +pb.dataset.page; drawTable(); document.getElementById("specs-sec").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return; }
    const fi = t.closest("[data-filter]");
    if (fi) { view.filter = fi.dataset.filter; view.page = 1; drawTable(); return; }
    const tb = t.closest("[data-tab]");
    if (tb) { setTab(tb.dataset.tab, tb.dataset.rstate); return; }
    const ref = t.closest("[data-ref]");
    if (ref) { ev.stopPropagation(); showRule(ref.dataset.ref, ref.dataset.in); return; }
    const pr = t.closest("[data-part]");
    if (pr) { openPart(pr.dataset.part); return; }
    const sp = t.closest("[data-spec]");
    if (sp) { openSpec(sp.dataset.spec, sp.dataset.rule); return; }
    if (t.closest(".close")) { closeSpec(); return; }
    const uf = t.closest("[data-unfold]");
    if (uf) { document.querySelectorAll('[data-g="' + uf.dataset.unfold + '"]').forEach((x) => x.classList.remove("x")); uf.remove(); return; }
    const rq = t.closest(".req");
    if (rq) rq.classList.toggle("open");
  });

  // ---- all good: every rule true to the code and proven ----
  if (specs.length && !M.fix.length && !M.later.length) $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">Every rule is true to the code and proven by a test.</div>');
  const errs = D.errors || [];
  $("#foot").innerHTML = "<span>" + esc(M.title) + (counts.specs ? " · " + plural(counts.specs, "spec") + " · " + plural(counts.rules, "rule") : "") + "</span><span>Veridic · " + ago(D.generated).toLowerCase() + "</span>" +
    (errs.length ? '<details class="errs"><summary>' + plural(errs.length, "thing") + " Veridic couldn't check</summary>" + errs.map((e) => "<div>" + esc(e) + "</div>").join("") + "</details>" : "");

  // ---- motion: rings fill, numbers count; confetti when every rule is true and proven ----
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fill = () => {
    document.querySelectorAll(".arc").forEach((a) => (a.style.strokeDashoffset = a.dataset.to));
    document.querySelectorAll(".num[data-n]").forEach((n) => {
      const to = +n.dataset.n;
      if (calm) { n.textContent = to + "%"; return; }
      const t1 = performance.now(), step = (t) => { const k = Math.min(1, (t - t1) / 1300); n.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))) + "%"; if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  };
  if (calm) fill(); else requestAnimationFrame(() => setTimeout(fill, 250));
  if (specs.length && !M.fix.length && !M.later.length && !calm) {
    const c = $("#confetti"), cl = ["#4cc38a", "#e3a73c", "#d97757", "#7aa7e8", "#c68be0"];
    c.innerHTML = [...Array(60)].map(() => '<i style="left:' + Math.random() * 100 + "vw;background:" + cl[(Math.random() * cl.length) | 0] + ";animation-delay:" + Math.random() * 0.8 + "s;transform:rotate(" + Math.random() * 360 + 'deg)"></i>').join("");
    setTimeout(() => (c.innerHTML = ""), 4000);
  }
  if (location.hash.length > 1) { const h = decodeURIComponent(location.hash.slice(1)); if (M.P.has(h)) openPart(h); else openSpec(h); }
})();
