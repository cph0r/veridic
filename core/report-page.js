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
    sp.health = { bad: "Broken", warn: sp.outdated ? "Out of date" : "Weak tests", todo: "Not tested", good: "Proven", none: "No rules" }[sp.tone];
    sp.files = new Set(rules.flatMap((r) => (r.cites || []).map((c) => c.file).filter(Boolean))).size;
    return sp;
  });
  const TONE = { bad: 0, warn: 1, todo: 2, none: 3, good: 4 };
  const trouble = (s) => s.broken.length + s.stale.length + s.lost.length;
  specs.sort((a, b) => TONE[a.tone] - TONE[b.tone] || trouble(b) - trouble(a) || b.rules.length - a.rules.length);
  const S = new Map(specs.map((s) => [s.path, s]));

  // ---- the parts of the app, each with its one spec ----
  // A spec file belongs to the part whose code its rules cite most (ties: the first);
  // with no citations, to the part its folder is named after (orders, orders-…); else
  // it stands alone as a part of its own ("other"). A part may have no spec yet.
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
    const named = partDefs.find((d) => dir === d.id || dir.startsWith(d.id + "-"));
    home.set(sp.path, best ? best[0] : named ? named.id : sp.path);
  }
  const partOf = (specPath) => home.get(specPath) || specPath;
  const coverOf = new Map(((D.coverage || {}).parts || []).map((c) => [c.id, c]));
  const makePart = (id, name, kind, ss) => {
    const all = (k) => ss.flatMap((x) => x[k]);
    const p = { id, name, kind, specs: ss, path: ss.length ? ss[0].path : null, rules: all("rules"), stories: all("stories"), broken: all("broken"), stale: all("stale"), lost: all("lost"), proven: all("proven"), weak: all("weak"), untested: all("untested") };
    p.outdated = p.stale.length + p.lost.length;
    p.files = new Set(p.rules.flatMap((r) => (r.cites || []).map((c) => c.file).filter(Boolean))).size;
    p.tone = !p.rules.length ? "none" : p.broken.length ? "bad" : p.outdated || p.weak.length ? "warn" : p.untested.length ? "todo" : "good";
    p.health = !ss.length ? "No spec" : { bad: "Broken", warn: p.outdated ? "Out of date" : "Weak tests", todo: "Not tested", good: "Proven", none: "No rules" }[p.tone];
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
    const out = parts.filter((s) => (FILTERS[filter] || FILTERS.all)(s) && (!needle || (s.name + " " + s.id + " " + s.specs.map((x) => x.path).join(" ")).toLowerCase().includes(needle)));
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
  return { rows, page, parts, partOf, specs, S, counts, fix, later, verdict, title: app.title || D.name, stateOf, statusOf, ruleText, RANK, plural, esc, cap, REQ };
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
  const SH = { good: "✓", warn: "~", bad: "!", todo: "–", none: "·" };
  const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const hid = (g) => (g ? ' data-g="' + g + '"' : "");
  let open = null; // the spec open in the sheet

  // ---- the shell ----
  $("#app").innerHTML = `<div class="wrap">
  <div class="top"><div class="brand"><span class="logo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></span>Veridic</div>
    <div class="when"><span id="when"></span><button class="icon-btn" id="theme" aria-label="Switch theme"></button></div></div>
  <section class="hero"><div class="rv"><div class="eyebrow" id="appname"></div><h1 class="verdict" id="verdict"></h1><p class="about" id="stats"></p></div><div class="rings rv" id="rings" style="animation-delay:.12s"></div></section>
  <section id="specs-sec"><h2 class="rv" style="animation-delay:.2s">Your specs <span class="hint">· click a row to read it, a heading to sort</span></h2>
  <div class="tools rv" style="animation-delay:.22s"><input id="q" type="search" placeholder="Search specs" aria-label="Search specs"><div class="seg" id="filters" role="group" aria-label="Show"></div></div>
  <div class="tablewrap rv" style="animation-delay:.25s"><table class="specs"><thead><tr id="thead"></tr></thead><tbody id="tbody"></tbody></table><div class="noresults" id="noresults" hidden>No spec matches.</div></div><div class="pager" id="pager"></div></section>
  <section id="fix-sec"><h2 class="rv" style="animation-delay:.3s">Fix first</h2><div class="cards rv" style="animation-delay:.35s" id="fix"></div></section>
  <section id="later-sec"><h2 class="rv" style="animation-delay:.35s">When you have time</h2><div class="cards rv" style="animation-delay:.4s" id="later"></div></section>
  <footer class="foot" id="foot"></footer>
</div>
<div class="scrim" id="scrim"></div>
<aside class="sheet" id="panel" aria-label="Spec"><div class="grab"></div><div class="part" id="part"></div></aside>
<div class="confetti" id="confetti"></div>`;

  // ---- hero: the verdict, two gauges, the counts ----
  $("#appname").textContent = M.title;
  $("#verdict").innerHTML = M.verdict;
  $("#when").textContent = ago(D.generated);
  $("#stats").textContent = counts.specs ? [plural(counts.specs, "spec"), plural(counts.rules, "rule"), counts.stories ? plural(counts.stories, "user story", "user stories") : ""].filter(Boolean).join(" · ") : "";
  const colorFor = (p) => (p >= 90 ? "var(--good)" : p >= 60 ? "var(--warn)" : "var(--bad)");
  const ring = (p, lbl, sub, color) => { const C = 2 * Math.PI * 33; return '<div class="ring"><svg viewBox="0 0 78 78"><circle class="track" cx="39" cy="39" r="33" fill="none" stroke-width="7"/><circle class="arc" cx="39" cy="39" r="33" fill="none" stroke-width="7" stroke="' + (color || colorFor(p)) + '" stroke-dasharray="' + C + '" stroke-dashoffset="' + C + '" data-to="' + C * (1 - p / 100) + '"/></svg><div class="num" data-n="' + p + '">0%</div><div class="lbl">' + lbl + '</div><div class="sub">' + sub + "</div></div>"; };
  const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  if (counts.rules) $("#rings").innerHTML =
    ring(pct(counts.true, counts.rules), "Up to date", counts.true + " of " + plural(counts.rules, "rule") + " match the code") +
    ring(pct(counts.proven, counts.rules), "Proven", counts.proven + " of " + plural(counts.rules, "rule") + (counts.broken ? " · " + counts.broken + " broken" : ""), counts.broken ? "var(--bad)" : null) +
    (counts.behaviour ? ring(pct(counts.covered, counts.behaviour), "Covered", counts.covered + " of " + counts.behaviour + " files described by a spec") : "");

  // ---- every spec, as a row: filter by health or text, sort by any column ----
  const COLS = [
    ["name", "Spec", "text"], ["health", "Health", "text"], ["rules", "Rules", "num"], ["proven", "Proven", "num"],
    ["broken", "Broken", "num"], ["outdated", "Out of date", "num"], ["untested", "Not tested", "num"], ["stories", "Stories", "num"], ["files", "Files", "num"],
  ];
  const FILTER = [["all", "All"], ["fix", "Needs fixing"], ["stale", "Out of date"], ["untested", "Not tested"], ["proven", "Proven"]];
  let view = { q: "", filter: "all", sort: null, dir: "desc", page: 1, size: 10 };
  try { view = { ...view, ...JSON.parse(store.get("table:" + D.name) || "{}") }; } catch {}
  const num = (n, cls) => (n ? '<span class="' + (cls || "") + '">' + n + "</span>" : '<span class="zero">–</span>');
  const rowHTML = (s) => {
    const pct = s.rules.length ? Math.round((100 * s.proven.length) / s.rules.length) : 0;
    return '<tr data-spec="' + esc(s.path) + '" tabindex="0"' + (open === s.path ? ' class="sel"' : "") + '><td class="c-name"><div class="snm"><i class="sh ' + s.tone + '">' + SH[s.tone] + "</i>" + esc(s.name) + '</div><div class="spath">' + esc(s.path) + "</div></td>" +
      '<td><span class="hl ' + s.tone + '">' + esc(s.health) + "</span></td>" +
      '<td class="num">' + s.rules.length + "</td>" +
      '<td class="num"><div class="pv"><span>' + s.proven.length + (s.rules.length ? '<small> /' + s.rules.length + "</small>" : "") + '</span><i class="pbar"><b style="width:' + pct + '%"></b></i></div></td>' +
      '<td class="num">' + num(s.broken.length, "c-bad") + '</td><td class="num">' + num(s.outdated, "c-warn") + '</td><td class="num">' + num(s.untested.length) + '</td><td class="num">' + num(s.stories.length) + '</td><td class="num">' + num(s.files) + "</td></tr>";
  };
  function drawTable() {
    store.set("table:" + D.name, JSON.stringify(view));
    $("#thead").innerHTML = COLS.map(([k, label, kind]) => '<th class="' + kind + '" aria-sort="' + (view.sort === k ? (view.dir === "asc" ? "ascending" : "descending") : "none") + '"><button data-sort="' + k + '">' + label + '<span class="arrow">' + (view.sort === k ? (view.dir === "asc" ? "↑" : "↓") : "") + "</span></button></th>").join("");
    $("#filters").innerHTML = FILTER.map(([k, label]) => '<button data-filter="' + k + '" aria-pressed="' + (view.filter === k) + '">' + label + '<span class="n">' + M.rows({ filter: k }).length + "</span></button>").join("");
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
  if (specs.length) {
    $("#q").value = view.q;
    $("#q").addEventListener("input", () => { view.q = $("#q").value; view.page = 1; drawTable(); });
    $("#pager").addEventListener("change", (ev) => { if (ev.target.id === "psize") { view.size = +ev.target.value; view.page = 1; drawTable(); } });
    drawTable();
  }
  else { $("#specs-sec").remove(); $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">This repo has no specs yet. Ask Claude to <b>write a spec</b> for a part of your app (<code>veridic modules</code> lists the parts), then run <code>veridic report</code> again.</div>'); }

  // ---- a spec, in a sheet: what needs attention, its stories, its rules ----
  const fold = (g, items, render, n, label) => items.slice(0, n).map((x) => render(x)).join("") + items.slice(n).map((x) => render(x, g)).join("") + (items.length > n ? '<button class="showall" data-unfold="' + g + '">' + label(items.length - n) + " →</button>" : "");
  function ruleHTML(r, g) {
    const t = M.ruleText(r), st = M.stateOf(r);
    const where = (r.cites || []).map((c) => '<span class="loc' + (c.resolves === false ? " gone" : "") + '">' + esc(c.cite) + "</span>").join("");
    const tests = (r.tests || []).map((x) => '<span class="loc">' + esc(x) + "</span>").join("");
    const checks = (r.checks || []).map((c) => "<li>" + esc(c.text || "") + "</li>").join("");
    return '<button class="req' + (g ? " x" : "") + '"' + hid(g) + ' data-rule="' + esc(r.id) + '"><span class="mark ' + st.tone + '">' + st.mark + '</span><span class="tx"><span><span class="rid">' + esc(r.id) + "</span> " + t.head + '</span><div class="why">' + esc(st.label) + "</div>" +
      '<div class="more">' + (t.rest ? "<p>" + t.rest + "</p>" : "") + (checks ? '<div class="mh">Checks</div><ul>' + checks + "</ul>" : "") + (where ? '<div class="mh">In the code</div>' + where : "") + (tests ? '<div class="mh">Proven by</div>' + tests : "") + "</div></span></button>";
  }
  function storyHTML(st, g) {
    const sc = (st.scenarios || []).map((x) => '<div class="scn"><div><b>Given</b> ' + esc(x.given) + "</div><div><b>When</b> " + esc(x.when) + "</div><div><b>Then</b> " + esc(x.then) + "</div>" + ((x.refs || []).length ? '<div class="refs">' + x.refs.map((id) => '<span class="chip link" data-ref="' + esc(id) + '">' + esc(id) + "</span>").join("") + "</div>" : "") + "</div>").join("");
    return '<button class="req story' + (g ? " x" : "") + '"' + hid(g) + '><span class="mark none">' + esc(st.priority || st.n || "") + '</span><span class="tx"><span>' + esc(st.title) + "</span>" + (st.why ? '<div class="why">' + esc(st.why) + "</div>" : "") + '<div class="more">' + (sc || "<p>No scenarios written.</p>") + "</div></span></button>";
  }
  function specHTML(s) {
    const key = s.path.replace(/\W/g, "");
    const rules = [...s.rules].sort((a, b) => M.RANK[M.stateOf(a).key] - M.RANK[M.stateOf(b).key]);
    const attention = rules.filter((r) => ["broken", "lost", "stale"].includes(M.stateOf(r).key));
    const rest = rules.filter((r) => !attention.includes(r)), todo = rest.filter((r) => M.stateOf(r).key !== "proven"), done = rest.filter((r) => M.stateOf(r).key === "proven");
    const summary = !s.rules.length ? "No rules written yet."
      : [s.broken.length && plural(s.broken.length, "rule") + " broken", s.stale.length && s.stale.length + " out of date", s.lost.length && s.lost.length + " pointing at code that's gone", s.proven.length + " of " + s.rules.length + " proven"].filter(Boolean).join(" · ") + ".";
    return '<div class="part-head"><div><h3' + (s.name.length > 40 ? ' class="long"' : "") + '><i class="sh ' + s.tone + '">' + SH[s.tone] + "</i>" + esc(s.name) + "</h3><p>" + summary + '</p><p class="path">' + esc(s.path) + (s.meta && s.meta.status ? " · " + esc(s.meta.status) : "") + '</p></div><button class="close" aria-label="Close">✕</button></div><div class="cols"><div>' +
      (attention.length ? '<div class="sub-h">Needs attention</div>' + attention.map((r) => ruleHTML(r)).join("") + '<div class="gap"></div>' : "") +
      (s.stories.length ? '<div class="sub-h">User stories</div>' + fold("s-" + key, s.stories, storyHTML, 4, (k) => "Show " + k + " more") + '<div class="gap"></div>' : "") +
      '<div class="sub-h">Rules</div>' + (s.rules.length
        ? fold("n-" + key, todo, ruleHTML, 6, (k) => "Show " + k + " more not proven yet") +
          (done.length ? '<button class="req" data-unfold="d-' + key + '"><span class="mark good">✓</span><span class="tx"><span><b>' + (attention.length + todo.length ? plural(done.length, "more rule") : "All " + plural(done.length, "rule")) + '</b></span><div class="why">Proven by tests · tap to see them</div></span></button>' + done.map((r) => ruleHTML(r, "d-" + key)).join("") : "")
        : '<div class="empty-req">This spec has no rules yet.</div>') +
      "</div></div>";
  }
  function openSpec(path, rule) {
    const s = S.get(path); if (!s) return;
    const panel = $("#panel");
    if (open === path && panel.classList.contains("open") && !rule) { closeSpec(); return; }
    document.querySelectorAll("#tbody tr").forEach((c) => c.classList.toggle("sel", c.dataset.spec === path));
    open = path;
    $("#part").innerHTML = specHTML(s);
    panel.scrollTop = 0;
    panel.classList.add("open");
    document.body.classList.add("sheet-open");
    try { history.replaceState(null, "", "#" + encodeURIComponent(path)); } catch {}
    if (rule) showRule(rule);
  }
  // open a rule in the sheet: unfold its group, open it, bring it into view
  function showRule(id) {
    const el = [...document.querySelectorAll("#part [data-rule]")].find((x) => x.dataset.rule === id); if (!el) return;
    if (el.dataset.g) document.querySelectorAll('[data-g="' + el.dataset.g + '"]').forEach((x) => x.classList.remove("x"));
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
    if (tr && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); openSpec(tr.dataset.spec); }
  });
  $("#scrim").addEventListener("click", closeSpec);
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    const so = t.closest("[data-sort]");
    // First click: names A to Z, numbers high to low; the next click reverses.
    if (so) { const k = so.dataset.sort, first = k === "name" ? "asc" : "desc"; view = { ...view, dir: view.sort === k ? (view.dir === "asc" ? "desc" : "asc") : first, sort: k, page: 1 }; drawTable(); return; }
    const pb = t.closest("[data-page]");
    if (pb && !pb.disabled) { view.page = +pb.dataset.page; drawTable(); document.getElementById("specs-sec").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); return; }
    const fi = t.closest("[data-filter]");
    if (fi) { view.filter = fi.dataset.filter; view.page = 1; drawTable(); return; }
    const ref = t.closest("[data-ref]");
    if (ref) { ev.stopPropagation(); showRule(ref.dataset.ref); return; }
    const sp = t.closest("[data-spec]");
    if (sp) { openSpec(sp.dataset.spec, sp.dataset.rule); return; }
    if (t.closest(".close")) { closeSpec(); return; }
    const uf = t.closest("[data-unfold]");
    if (uf) { document.querySelectorAll('[data-g="' + uf.dataset.unfold + '"]').forEach((x) => x.classList.remove("x")); uf.remove(); return; }
    const rq = t.closest(".req");
    if (rq) rq.classList.toggle("open");
  });

  // ---- fix first, then what can wait ----
  const card = (l, s, i, g) => '<button class="card' + (i >= 6 ? " x" : "") + '"' + hid(i >= 6 ? g : "") +  (l.spec ? ' data-spec="' + esc(l.spec) + '"' : "") + (l.rule ? ' data-rule="' + esc(l.rule) + '"' : "") + '><i class="sh ' + (l.tone || s) + '">' + SH[l.tone || s] + '</i><span><div class="t">' + l.html + '</div><div class="w">' + l.w + '</div>' + (l.spec ? '<div class="p">' + esc(S.get(l.spec).name) + " →</div>" : "") + "</span></button>";
  const deal = (sec, id, list, s) => {
    if (!list.length) { $(sec).remove(); return; }
    $("#" + id).innerHTML = list.map((l, i) => card(l, s, i, id)).join("");
    if (list.length > 6) $("#" + id).insertAdjacentHTML("afterend", '<button class="showall" data-unfold="' + id + '" style="margin-top:14px">Show all ' + list.length + " →</button>");
  };
  deal("#fix-sec", "fix", M.fix, "bad");
  deal("#later-sec", "later", M.later, "warn");
  if (specs.length && !M.fix.length && !M.later.length) $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">Every rule is true to the code and proven by a test.</div>');
  const errs = D.errors || [];
  $("#foot").innerHTML = "<span>" + esc(M.title) + (counts.specs ? " · " + plural(counts.specs, "spec") + " · " + plural(counts.rules, "rule") : "") + "</span><span>Veridic · " + ago(D.generated).toLowerCase() + "</span>" +
    (errs.length ? '<details class="errs"><summary>' + plural(errs.length, "thing") + " Veridic couldn't check</summary>" + errs.map((e) => "<div>" + esc(e) + "</div>").join("") + "</details>" : "");

  // ---- theme: the system's by default; the toggle pins light or dark ----
  const dark = () => (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  const t0 = store.get("theme"); if (t0 === "light" || t0 === "dark") document.documentElement.dataset.theme = t0;
  const paint = () => { $("#theme").innerHTML = dark() ? SUN : MOON; $("#theme").title = dark() ? "Light mode" : "Dark mode"; };
  $("#theme").onclick = () => { const t = dark() ? "light" : "dark"; document.documentElement.dataset.theme = t; store.set("theme", t); paint(); };
  paint();

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
  if (location.hash.length > 1) openSpec(decodeURIComponent(location.hash.slice(1)));
})();
