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
    return sp;
  });
  const TONE = { bad: 0, warn: 1, todo: 2, none: 3, good: 4 };
  const trouble = (s) => s.broken.length + s.stale.length + s.lost.length;
  specs.sort((a, b) => TONE[a.tone] - TONE[b.tone] || trouble(b) - trouble(a) || b.rules.length - a.rules.length);
  const S = new Map(specs.map((s) => [s.path, s]));

  // ---- the numbers: rules, counted the way the cards count them ----
  const sum = (f) => specs.reduce((n, s) => n + f(s), 0);
  const counts = {
    specs: specs.length, rules: sum((s) => s.rules.length), stories: sum((s) => s.stories.length),
    proven: sum((s) => s.proven.length), broken: sum((s) => s.broken.length), stale: sum((s) => s.stale.length), lost: sum((s) => s.lost.length),
    weak: sum((s) => s.weak.length), untested: sum((s) => s.untested.length),
    true: sum((s) => s.rules.filter((r) => !r.stale && !lost(r)).length),
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

  return { specs, S, counts, fix, later, verdict, title: app.title || D.name, stateOf, statusOf, ruleText, RANK, plural, esc, cap, REQ };
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

  // ---- the shell ----
  $("#app").innerHTML = `<div class="wrap">
  <div class="top"><div class="brand"><span class="logo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></span>Veridic</div>
    <div class="when"><span id="when"></span><button class="icon-btn" id="theme" aria-label="Switch theme"></button></div></div>
  <section class="hero"><div class="rv"><div class="eyebrow" id="appname"></div><h1 class="verdict" id="verdict"></h1><p class="about" id="stats"></p></div><div class="rings rv" id="rings" style="animation-delay:.12s"></div></section>
  <section id="specs-sec"><h2 class="rv" style="animation-delay:.2s">Your specs <span class="hint">· tap one to read it</span></h2><div class="grid rv" style="animation-delay:.25s" id="grid"></div></section>
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
    ring(pct(counts.proven, counts.rules), "Proven", counts.proven + " of " + plural(counts.rules, "rule") + (counts.broken ? " · " + counts.broken + " broken" : ""), counts.broken ? "var(--bad)" : null);

  // ---- every spec, as a card: its ring is its rules, proven, broken and out of date ----
  const C = (r) => 2 * Math.PI * r;
  function specRing(s) {
    const r = 22, n = s.rules.length || 1, segs = [[s.proven.length, "var(--good)"], [s.broken.length, "var(--bad)"], [s.stale.length + s.lost.length, "var(--warn)"]];
    let at = 0, out = '<svg class="sring" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="6"/>';
    for (const [k, color] of segs) { if (!k) continue; const f = k / n; out += '<circle class="arc" cx="28" cy="28" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="6" stroke-dasharray="' + C(r) + '" stroke-dashoffset="' + C(r) + '" data-to="' + C(r) * (1 - f) + '" transform="rotate(' + (-90 + at * 360) + ' 28 28)"/>'; at += f; }
    return out + '<text x="28" y="33" text-anchor="middle" class="sring-n">' + s.rules.length + "</text></svg>";
  }
  const flag = (n, word, cls) => (n ? '<span class="flag ' + cls + '">' + n + " " + word + "</span>" : "");
  if (specs.length) $("#grid").innerHTML = specs.map((s) => '<button class="scard" data-spec="' + esc(s.path) + '">' + specRing(s) + '<span class="sbody"><span class="snm"><i class="sh ' + s.tone + '">' + SH[s.tone] + "</i>" + esc(s.name) + '</span><span class="ssub">' + [plural(s.rules.length, "rule"), s.stories.length ? plural(s.stories.length, "story", "stories") : ""].filter(Boolean).join(" · ") + '</span><span class="flags">' + flag(s.broken.length, "broken", "bad") + flag(s.stale.length, "out of date", "warn") + flag(s.lost.length, "code gone", "warn") + (s.rules.length ? '<span class="flag">' + s.proven.length + " of " + s.rules.length + " proven</span>" : '<span class="flag">no rules yet</span>') + "</span></span></button>").join("");
  else { $("#specs-sec").remove(); $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">This repo has no specs yet. Ask Claude to <b>write a spec</b> for a part of your app (<code>veridic modules</code> lists the parts), then run <code>veridic report</code> again.</div>'); }

  // ---- a spec, in a sheet: what needs attention, its stories, its rules ----
  let open = null;
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
    document.querySelectorAll(".scard").forEach((c) => c.classList.toggle("sel", c.dataset.spec === path));
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
    document.querySelectorAll(".scard.sel").forEach((c) => c.classList.remove("sel"));
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  }
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && open) closeSpec(); });
  $("#scrim").addEventListener("click", closeSpec);
  document.addEventListener("click", (ev) => {
    const t = ev.target;
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
  const card = (l, s, i, g) => '<button class="card' + (i >= 6 ? " x" : "") + '"' + hid(i >= 6 ? g : "") + ' data-spec="' + esc(l.spec) + '"' + (l.rule ? ' data-rule="' + esc(l.rule) + '"' : "") + '><i class="sh ' + (l.tone || s) + '">' + SH[l.tone || s] + '</i><span><div class="t">' + l.html + '</div><div class="w">' + l.w + '</div><div class="p">' + esc(S.get(l.spec).name) + " →</div></span></button>";
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
