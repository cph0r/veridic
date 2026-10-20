// Veridic report page. Reads the JSON embedded in the page and renders it; no
// network, no dependencies. One page for someone who knows the requirements, not
// the code: a verdict in a sentence, the app as a graph of its parts (tap one to
// see what it does and should do), then what to fix first and what can wait.
// An observability tool: it shows the state of the repo; it never acts on it.
//
// veridicModel(D) is everything the page says, computed from the data; the view
// below only draws it. The tests load this file without a browser and call it.

/* eslint-disable no-var */
var veridicModel = (D) => {
  "use strict";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const names = (list) => list.join(", ").replace(/, ([^,]*)$/, " and $1");

  // ---- plain words for an endpoint, and who can call it ----
  const AUD = { admin: "staff", owner: "owner", public: "guests", webhooks: "other services", internal: "internal" };
  const WORD = { login: "Log in", logout: "Log out", signin: "Sign in", signout: "Sign out", signup: "Sign up", register: "Sign up", me: "See your account", health: "Check the server is up", search: "Search" };
  const single = (w) => w.replace(/[-_]/g, " ").replace(/ies$/, "y").replace(/(?<![su])s$/, "");
  const an = (w) => (/^[aeiou]/i.test(w) ? "an " : "a ") + w;
  const strip = (path) => { const p = path.replace(/^\/api(?=\/|$)/, "") || "/"; const s = p.split("/"); return AUD[s[1]] && s.length > 2 ? "/" + s.slice(2).join("/") : p; };
  const audOf = (path) => AUD[(path.replace(/^\/api(?=\/|$)/, "") || "/").split("/")[1]] || "";
  const who = (r) => audOf(r.path) || (r.access === "public" ? "public" : "auth");
  function act(method, path) {
    const p = strip(path);
    if (p === "/") return "Check the server is up";
    const segs = p.split("/").filter(Boolean), last = segs[segs.length - 1] || "", param = /^[:{*]/.test(last);
    if (!param && WORD[last.toLowerCase()]) return WORD[last.toLowerCase()];
    const noun = param ? an(single(segs[segs.length - 2] || "item")) : last.replace(/[-_]/g, " ");
    const parent = !param && segs.length > 2 && /^[:{]/.test(segs[segs.length - 2]) ? " on " + an(single(segs[segs.length - 3])) : "";
    const verb = { GET: param ? "Open" : "See", POST: "Add", PUT: "Edit", PATCH: "Edit", DELETE: "Delete" }[method] || cap(String(method).toLowerCase());
    return verb + " " + (method === "POST" && !param ? an(single(noun)) : noun) + parent;
  }

  // ---- a rule's state, and its text in plain words ----
  const REQ = {
    passing: ["Tested, passing", "good"], covered: ["Proven by a test", "good"], failing: ["Its test is failing", "bad"], unasserted: ["Its test checks nothing", "warn"],
    tagged_only: ["Its test misses the code", "warn"], todo: ["Its test is a todo", "none"], none: ["Not tested yet", "none"],
    broken: ["Broken, proven", "bad"], // an expected-failure test shows the code breaks the rule
    marker_stale: ["Fixed: make its test a normal one", "warn"], // the expected-failure test now fails
  };
  const statusOf = (r) => { const [label, tone] = REQ[r.status] || REQ.none; return { label, tone }; };
  const fmt = (s) => esc(s).replace(/&lt;b&gt;(.*?)&lt;\/b&gt;/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  function ruleText(r) {
    let t = String(r.text || "").replace(/\s*\(holds: no\)\.?/i, ".").replace(/`(GET|POST|PUT|PATCH|DELETE) ([^`]+)`/g, (_, m, p) => "<b>" + act(m, p) + "</b>");
    t = t.replace(/\bMUST NOT\b/g, "must not").replace(/\bMUST\b/g, "must").replace(/\bSHOULD\b/g, "should");
    t = t.replace(/^(The system|The API|The server|The app|It) (must|should)/, (_, w, m) => cap(m));
    let first = t.match(/^.+?(?=,\s+and\s|[.;](?:\s|$)|\s\()/)?.[0] ?? t;
    if (first.length > 100) { const cut = first.lastIndexOf(",", 100); if (cut > 40) first = first.slice(0, cut); }
    const rest = t.slice(first.length).replace(/^[.;,]\s*/, "").trim();
    return { head: fmt(cap(first)), rest: rest ? fmt(cap(rest)) : "" };
  }

  // ---- the parts: the app's modules, or one per spec in a repo without routes ----
  const NICE = { auth: "Accounts & sign-in", main: "Server", health: "Server health", pos: "Point of sale" };
  const tname = (t) => String(t).replace(/^_/, "").replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const RISK = (f) => f.severity === "high" || f.severity === "medium";
  const specs = D.specs || [], routes = D.routes || [], findings = D.findings || [];
  const reqsOf = (paths) => specs.filter((s) => paths.includes(s.path)).flatMap((s) => (s.requirements || []).filter((r) => r.requirement !== false));
  // A module's own spec: the one in a folder named after it (orders, orders-payment), else its first.
  const ownSpecs = (m) => { const own = (m.specs || []).filter((sp) => { const dir = sp.split("/").slice(-2)[0]; return dir === m.id || dir.startsWith(m.id + "-"); }); return own.length ? own : (m.specs || []).slice(0, 1); };
  const healthOf = (p) => (p.broken.length || p.risks.length ? "bad" : !p.rs.length && !p.routes.length ? "none" : p.untested.length || !p.rs.length || p.rs.some((r) => statusOf(r).tone !== "good") ? "warn" : "good");
  const make = (id, name, rs, rts, untested, owns, risks, specPaths) => {
    const p = { id, name, rs, routes: rts, untested, owns, risks, specPaths, broken: rs.filter((r) => statusOf(r).tone === "bad"), tested: rs.filter((r) => statusOf(r).tone === "good") };
    p.health = healthOf(p);
    return p;
  };
  const specTitle = (s) => (s.doc && s.doc.title) || s.path.split("/").slice(-2)[0].replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const parts = (D.modules || []).length
    ? D.modules.map((m) => make(m.id, NICE[m.id] || m.name, reqsOf(ownSpecs(m)), routes.filter((r) => r.module === m.id), (m.tests && m.tests.untested) || [], ((m.data && m.data.owns) || []).map((o) => tname(o.table)), findings.filter((f) => f.module === m.id && RISK(f) && f.area !== "Spec"), ownSpecs(m)))
    : specs.map((s) => make(s.path, specTitle(s), reqsOf([s.path]), [], [], [], [], [s.path]));
  const P = new Map(parts.map((p) => [p.id, p]));
  const pname = (id) => (P.get(id) || { name: id }).name;

  // ---- how parts connect: uses its code, reads its data, changes its data ----
  const E = new Map();
  const link = (a, b) => { if (a === b || !P.has(a) || !P.has(b)) return null; const k = a + ">" + b; if (!E.has(k)) E.set(k, { a, b, uses: false, reads: [], changes: [] }); return E.get(k); };
  const add = (list, t) => { if (!list.includes(t)) list.push(t); };
  const sw = (((D.structure || {}).modularity || {}).problems || []).filter((pr) => pr.kind === "shared-writes");
  for (const m of D.modules || []) for (const u of m.uses || []) { const e = link(m.id, u.module); if (e) e.uses = true; }
  for (const pr of sw) for (const o of pr.others) { const e = link(o, pr.owner); if (e) add(e.changes, tname(pr.table)); }
  for (const m of D.modules || []) for (const o of (m.data && m.data.owns) || []) for (const r of o.readBy || []) { const e = link(r, m.id); if (e) add(e.reads, tname(o.table)); }
  const edges = [...E.values()];
  const kindOf = (e) => (e.changes.length ? "changes" : e.uses ? "uses" : "reads");
  const words = (l) => l.slice(0, 2).join(", ") + (l.length > 2 ? " +" + (l.length - 2) : "");
  const lblOf = (e) => [e.changes.length ? "changes " + words(e.changes) : "", e.uses ? "uses" : "", e.reads.length && !e.changes.length ? "reads " + words(e.reads) : ""].filter(Boolean).join(" · ");

  // ---- the numbers: one unit, "problems", everywhere ----
  const allReqs = parts.flatMap((p) => p.rs);
  const proven = { tested: allReqs.filter((r) => statusOf(r).tone === "good").length, broken: allReqs.filter((r) => statusOf(r).tone === "bad").length, total: allReqs.length };
  const nRoutes = routes.length, nUntested = parts.reduce((s, p) => s + p.untested.length, 0);
  const apiRisks = findings.filter((f) => RISK(f) && f.area !== "Spec"), nHigh = apiRisks.filter((f) => f.severity === "high").length;
  const safety = { problems: apiRisks.length, serious: nHigh, label: apiRisks.length ? "Safety problems" : "Safe" };
  const tested = { done: nRoutes - nUntested, total: nRoutes };
  const specOwner = new Map(parts.flatMap((p) => p.specPaths.map((sp) => [sp, p.id])));
  const modOf = (f) => (P.has(f.module) ? f.module : specOwner.get(String(f.where || "").replace(/(:\d|\s).*$/, "")) || null);
  const whereOf = (ids) => (ids.length > 3 ? names(ids.slice(0, 2).map(pname)) + " and " + (ids.length - 2) + " more" : names(ids.map(pname)));

  // Fix first: rules the code breaks, then risks, one card per kind of problem.
  const fix = [], later = [];
  for (const p of parts) for (const r of p.broken) fix.push({ n: 1, parts: [p.id], html: ruleText(r).head, w: statusOf(r).label === "Broken, proven" ? "Broken, proven: the code doesn't do this today." : esc(statusOf(r).label) + "." });
  const groups = new Map();
  for (const f of apiRisks) { const g = groups.get(f.title) || { f, n: 0, high: false, parts: [] }; g.n++; g.high = g.high || f.severity === "high"; const m = modOf(f); if (m && !g.parts.includes(m)) g.parts.push(m); groups.set(f.title, g); }
  for (const g of [...groups.values()].sort((a, b) => b.high - a.high || b.n - a.n)) fix.push({ n: g.n, parts: g.parts, html: esc(g.f.title), w: esc(g.f.why || g.f.text) });
  const nFix = fix.reduce((s, c) => s + c.n, 0);
  // When you have time: out-of-date requirements, parts with no spec, actions no test calls, data changed from two places.
  const stale = findings.filter((f) => f.area === "Spec" && RISK(f));
  if (stale.length) later.push({ parts: [...new Set(stale.map(modOf).filter(Boolean))], html: esc(stale.length === 1 ? "A requirement is out of date" : stale.length + " requirements are out of date"), w: "The code they describe changed after they were written." });
  const bare = parts.filter((p) => p.routes.length && !p.rs.length);
  if (bare.length) later.push({ parts: bare.map((p) => p.id), html: esc(bare.length === 1 ? bare[0].name + " has no requirements yet" : bare.length > 4 ? bare.length + " parts have no requirements yet" : names(bare.map((p) => p.name)) + " have no requirements yet"), w: "Nothing says what " + (bare.length === 1 ? "it" : "they") + " should do, so nothing can check " + (bare.length === 1 ? "it does." : "they do.") });
  const unt = parts.filter((p) => p.untested.length).sort((a, b) => b.untested.length - a.untested.length);
  if (unt.length) later.push({ parts: unt.map((p) => p.id), html: esc(plural(nUntested, "action") + " no test calls"), w: esc("Most in " + names(unt.slice(0, 3).map((p) => p.name)) + ".") });
  if (sw.length) later.push({ parts: [...new Set(sw.flatMap((pr) => pr.others))].filter((i) => P.has(i)), html: esc(sw.length === 1 ? pname(sw[0].others[0]) + " changes " + tname(sw[0].table) : plural(sw.length, "kind") + " of data are changed from two places"), w: esc((sw.length === 1 ? "Those belong to " + pname(sw[0].owner) + "." : sw.slice(0, 3).map((pr) => tname(pr.table)).join(", ") + (sw.length > 3 ? ", …" : "") + ".") + " Two places changing the same data can drift apart.") });

  // ---- the headline ----
  const testPct = nRoutes ? Math.round((100 * tested.done) / nRoutes) : 100;
  const probs = '<em class="c-bad">' + plural(nFix, "problem") + "</em> to fix";
  const verdict = nFix && nFix <= 3 && testPct >= 60 && !nHigh ? "Mostly solid, with " + probs + "."
    : nFix ? cap(probs) + (nRoutes && testPct < 50 ? ", and most of it isn't tested yet." : ".")
    : later.length ? 'In good shape, with <em class="c-warn">' + plural(later.length, "thing") + "</em> for later."
    : !parts.length ? "Nothing to check yet."
    : 'Everything <em class="c-good">checks out.</em>';
  // the about line, unless it only repeats the title
  const app = D.app || {};
  const aboutRaw = app.about ? String(app.about).split(/\n\s*\n/)[0].replace(/\*\*|__/g, "").replace(/(?<=[.!?])\s+[^.!?]*:\s*$/, "") : "";
  const titleWords = String(app.title || "").toLowerCase().match(/[a-z]{3,}/g) || [];
  const about = aboutRaw && !(aboutRaw.length < 110 && titleWords.length && titleWords.every((w) => aboutRaw.toLowerCase().includes(w))) ? aboutRaw : "";

  const layout = edges.length ? "graph" : "list";
  return { layout, parts, P, edges, fix, later, nFix, safety, proven, tested, verdict, about, title: app.title || D.name, act, who, ruleText, statusOf, kindOf, lblOf, whereOf, plural, esc, cap, REQ };
};

(() => {
  "use strict";
  if (typeof document === "undefined") return;
  const D = JSON.parse(document.getElementById("data").textContent);
  const M = veridicModel(D);
  const { parts, P, edges, esc, plural, cap } = M;
  const $ = (s) => document.querySelector(s);
  const store = {
    get: (k) => { try { return localStorage.getItem("veridic-" + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem("veridic-" + k, v); } catch {} },
  };
  const md = (s) => esc(s).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const ago = (d) => { const s = (Date.now() - new Date(d)) / 1000; return s < 90 ? "Checked just now" : s < 5400 ? "Checked " + Math.round(s / 60) + " min ago" : "Checked " + new Date(d).toLocaleString(); };
  const HL = { good: "All good", warn: "Not proven yet", bad: "Needs fixing", none: "Nothing to check" }, SH = { good: "✓", warn: "?", bad: "!", none: "·" };
  const SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  // ---- the shell ----
  $("#app").innerHTML = `<div class="wrap">
  <div class="top"><div class="brand"><span class="logo"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg></span>Veridic</div>
    <div class="when"><span id="when"></span><button class="icon-btn" id="theme" aria-label="Switch theme"></button></div></div>
  <div class="change" id="change" hidden></div>
  <section class="hero"><div class="rv"><div class="eyebrow" id="appname"></div><h1 class="verdict" id="verdict"></h1><p class="about" id="about"></p></div><div class="rings rv" id="rings" style="animation-delay:.12s"></div></section>
  <section id="map-sec"><h2 class="rv" style="animation-delay:.2s">Your app <span class="hint" id="map-hint"></span></h2>
  <div class="mapbox rv" style="animation-delay:.25s"><div class="map" id="map"></div><div class="legend" id="legend"></div></div></section>
  <section id="fix-sec"><h2 class="rv" style="animation-delay:.3s">Fix first <span class="hint" id="fix-n"></span></h2><div class="cards rv" style="animation-delay:.35s" id="fix"></div></section>
  <section id="later-sec"><h2 class="rv" style="animation-delay:.35s">When you have time</h2><div class="cards rv" style="animation-delay:.4s" id="later"></div></section>
  <footer class="foot" id="foot"></footer>
</div>
<div class="scrim" id="scrim"></div>
<aside class="sheet" id="panel" aria-label="Part details"><div class="grab"></div><div class="part" id="part"></div></aside>
<div class="confetti" id="confetti"></div>`;

  // ---- hero: the verdict and three gauges ----
  $("#appname").textContent = M.title;
  $("#about").innerHTML = M.about ? md(M.about) : "";
  $("#verdict").innerHTML = M.verdict;
  $("#when").textContent = ago(D.generated);
  const colorFor = (pct) => (pct >= 90 ? "var(--good)" : pct >= 60 ? "var(--warn)" : "var(--bad)");
  const ring = (pct, lbl, sub, color, center) => { const C = 2 * Math.PI * 33; return '<div class="ring"><svg viewBox="0 0 78 78"><circle class="track" cx="39" cy="39" r="33" fill="none" stroke-width="7"/><circle class="arc" cx="39" cy="39" r="33" fill="none" stroke-width="7" stroke="' + (color || colorFor(pct)) + '" stroke-dasharray="' + C + '" stroke-dashoffset="' + C + '" data-to="' + C * (1 - pct / 100) + '"/></svg><div class="num"' + (center == null ? ' data-n="' + pct + '">0%' : ">" + center) + '</div><div class="lbl">' + lbl + '</div><div class="sub">' + sub + "</div></div>"; };
  const pr = M.proven, tt = M.tested, sf = M.safety;
  $("#rings").innerHTML =
    (pr.total ? ring(Math.round((100 * pr.tested) / pr.total), "Proven", pr.tested + " of " + plural(pr.total, "requirement") + (pr.broken ? " · " + pr.broken + " broken" : ""), pr.broken ? "var(--bad)" : null) : "") +
    (tt.total ? ring(Math.round((100 * tt.done) / tt.total), "Actions tested", tt.done + " of " + tt.total + " have a test that calls them") : "") +
    (sf.problems ? ring(100, sf.label, sf.serious ? sf.serious + " serious" : "none serious", sf.serious ? "var(--bad)" : "var(--warn)", sf.problems) : tt.total ? ring(100, "Safe", "no problems found", "var(--good)", "✓") : "");

  // ---- the change in progress, when there is one ----
  const ch = D.change;
  if (ch && ch.files && ch.files.length) {
    const el = $("#change"), n = (ch.problems || []).length;
    el.hidden = false;
    el.className = "change " + (n ? "bad" : "good");
    el.innerHTML = '<i class="sh ' + (n ? "bad" : "good") + '">' + (n ? "!" : "✓") + "</i><span><b>Change in progress</b> · " + plural(ch.files.length, "file") + " edited · " + (n ? plural(n, "problem") + ": " + esc([...new Set(ch.problems.map((x) => x.title || x.kind))].slice(0, 2).join(", ")) : "in scope, nothing to fix") + "</span>";
  }

  // ---- the graph: parts are circles, links are lines; a force layout pulls connected parts together ----
  const map = $("#map"), mb = $(".mapbox");
  const W = Math.max(300, mb.clientWidth - parseFloat(getComputedStyle(mb).paddingLeft) * 2);
  const narrow = W < 640;
  const H = Math.round(Math.min(narrow ? 680 : parts.length > 12 ? 720 : 600, Math.max(narrow ? 420 : 340, 220 + parts.length * (narrow ? 28 : 26))));
  const R = (p) => Math.min(46, 22 + 4 * Math.sqrt(p.routes.length || p.rs.length / 3));
  const N = parts.map((p, i) => { const a = (i / Math.max(1, parts.length)) * Math.PI * 2; return { p, id: p.id, r: R(p), x: Math.cos(a) * 160 + ((i * 37) % 11), y: Math.sin(a) * 120 + ((i * 53) % 7), vx: 0, vy: 0 }; });
  const NI = new Map(N.map((n) => [n.id, n]));
  // a few hundred steps of: everything repels, links pull, all drift to the middle, nothing overlaps
  for (let it = 0, heat = 1; it < 600; it++, heat *= 0.993) {
    for (const a of N) for (const b of N) {
      if (a === b) continue;
      const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 1, d = Math.sqrt(d2);
      const f = (14000 * (1 + parts.length / 10)) / d2, min = a.r + b.r + 56;
      a.vx += (dx / d) * f; a.vy += (dy / d) * f;
      if (d < min) { a.vx += (dx / d) * (min - d) * 0.25; a.vy += (dy / d) * (min - d) * 0.25; }
    }
    for (const e of edges) { const a = NI.get(e.a), b = NI.get(e.b), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - 150 - a.r - b.r) * 0.03; a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; }
    for (const n of N) { n.vx -= n.x * 0.012 * (narrow ? 1.6 : 1); n.vy -= n.y * 0.012 * (narrow ? 0.7 : 1.6); n.x += Math.max(-30, Math.min(30, n.vx)) * heat; n.y += Math.max(-30, Math.min(30, n.vy)) * heat; n.vx *= 0.5; n.vy *= 0.5; }
  }
  if (N.length) { // fit to the box, leaving room for the names under the circles
    const x0 = Math.min(...N.map((n) => n.x - n.r - 50)), x1 = Math.max(...N.map((n) => n.x + n.r + 50));
    const y0 = Math.min(...N.map((n) => n.y - n.r - 6)), y1 = Math.max(...N.map((n) => n.y + n.r + 40));
    const s = Math.min(1.25, W / (x1 - x0), H / (y1 - y0));
    for (const n of N) { n.x = W / 2 + (n.x - (x0 + x1) / 2) * s; n.y = H / 2 + (n.y - (y0 + y1) / 2) * s; }
  }
  // where someone dragged the circles last time (theirs only, in this browser)
  const LAYOUT = "layout:" + D.name;
  try { const saved = JSON.parse(store.get(LAYOUT) || "null"); if (saved) for (const n of N) if (saved[n.id]) { n.x = saved[n.id][0] * W; n.y = saved[n.id][1] * H; } } catch {}
  const saveLayout = () => store.set(LAYOUT, JSON.stringify(Object.fromEntries(N.map((n) => [n.id, [n.x / W, n.y / H]]))));

  const C = (r) => 2 * Math.PI * r;
  function nodeSVG(n) {
    const p = n.p, r = n.r, rr = r - 5, k = p.rs.length, g = p.tested.length, b = p.broken.length;
    const arc = (frac, color, start) => (frac > 0 ? '<circle class="arc" r="' + rr + '" fill="none" stroke="' + color + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + C(rr) + '" stroke-dashoffset="' + C(rr) + '" data-to="' + C(rr) * (1 - frac) + '" transform="rotate(' + (-90 + start * 360) + ')"/>' : "");
    return '<g class="gnode h-' + p.health + '" data-part="' + esc(p.id) + '" transform="translate(' + n.x + "," + n.y + ')" tabindex="0" role="button" aria-label="' + esc(p.name + ", " + HL[p.health]) + '">' +
      '<circle class="halo" r="' + (r + 9) + '"/><circle class="disc" r="' + r + '"/><circle class="track" r="' + rr + '" fill="none" stroke-width="5"/>' +
      (k ? arc(g / k, "var(--good)", 0) + arc(b / k, "var(--bad)", g / k) : "") +
      '<text class="cnt" dy="5.5" text-anchor="middle">' + SH[p.health] + "</text>" +
      '<text class="nm" y="' + (r + 20) + '" text-anchor="middle">' + esc(p.name) + "</text>" +
      (g || b ? '<text class="sb" y="' + (r + 35) + '" text-anchor="middle">' + (b ? b + " broken" : g + " of " + k + " proven") + "</text>" : "") + "</g>";
  }
  // a line from rim to rim, bent a little so two-way links don't sit on top of each other
  function wire(e) {
    const a = NI.get(e.a), b = NI.get(e.b), dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
    const x1 = a.x + ux * (a.r + 4), y1 = a.y + uy * (a.r + 4), x2 = b.x - ux * (b.r + 8), y2 = b.y - uy * (b.r + 8);
    const bend = 0.12 * d, cx = (x1 + x2) / 2 - uy * bend, cy = (y1 + y2) / 2 + ux * bend;
    return { d: "M" + x1 + "," + y1 + " Q" + cx + "," + cy + " " + x2 + "," + y2, mx: (x1 + 2 * cx + x2) / 4, my: (y1 + 2 * cy + y2) / 4 };
  }
  const eid = (e) => "e" + edges.indexOf(e);
  const DEFS = "<defs>" + ["uses", "reads", "changes"].map((k) => '<marker id="arr-' + k + '" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="' + (k === "changes" ? "var(--warn)" : "var(--ink3)") + '"/></marker>').join("") + "</defs>";
  const edgeSVG = () => edges.map((e) => {
    const w = wire(e), k = M.kindOf(e), attrs = ' data-a="' + esc(e.a) + '" data-b="' + esc(e.b) + '"';
    return '<path id="' + eid(e) + '" class="edge k-' + k + '"' + attrs + ' d="' + w.d + '" marker-end="url(#arr-' + k + ')"/>' +
      '<circle r="3.5" class="dot-flow"' + attrs + '><animateMotion dur="1.8s" repeatCount="indefinite"><mpath href="#' + eid(e) + '"/></animateMotion></circle>' +
      '<text class="edge-lbl k-' + k + '" id="' + eid(e) + 't"' + attrs + ' x="' + w.mx + '" y="' + (w.my - 6) + '" text-anchor="middle">' + esc(M.lblOf(e)) + "</text>";
  }).join("");
  // a graph only when parts connect; phones with a big app get the list too
  const asList = M.layout === "list" || (narrow && parts.length > 8);
  if (!parts.length) $("#map-sec").remove();
  else if (asList) {
    // phones with a big app: a list grouped by health instead of the graph
    const GROUP = [["bad", "Needs fixing"], ["warn", "Not proven yet"], ["good", "All good"], ["none", "Nothing to check"]];
    const sub = (p) => [p.routes.length ? plural(p.routes.length, "thing") + " you can do" : plural(p.rs.length, "requirement"), p.broken.length ? p.broken.length + " broken" : p.tested.length ? p.tested.length + " of " + p.rs.length + " proven" : ""].filter(Boolean).join(" · ");
    map.innerHTML = '<div class="plist">' + GROUP.map(([h, t]) => { const ps = parts.filter((p) => p.health === h).sort((a, b) => b.routes.length - a.routes.length); return ps.length ? "<h4>" + t + "</h4>" + ps.map((p) => '<button class="prow" data-part="' + esc(p.id) + '"><i class="sh ' + h + '">' + SH[h] + '</i><span class="gr"><div class="nm">' + esc(p.name) + '</div><div class="sb">' + sub(p) + '</div></span><span class="cv">›</span></button>').join("") : ""; }).join("") + "</div>";
  } else {
    map.innerHTML = '<svg id="graph" viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '"><title>Drag a part to move it. Plain lines: uses. Dashed: reads its data. Amber: changes another part\'s data.</title>' + DEFS + '<g id="wires">' + edgeSVG() + '</g><g id="nodes">' + N.map(nodeSVG).join("") + "</g></svg>";
    map.classList.toggle("quiet", edges.length > 6);
    $("#legend").innerHTML = ["bad", "warn", "good", "none"].filter((h) => parts.some((p) => p.health === h)).map((h) => '<span><i class="sh ' + h + '">' + SH[h] + "</i>" + HL[h] + "</span>").join("") +
      (edges.some((e) => e.changes.length) ? '<span><svg width="22" height="8"><line x1="1" y1="4" x2="21" y2="4" class="edge k-changes"/></svg>changes another part\'s data</span>' : "");
  }
  if ($("#map-hint")) $("#map-hint").textContent = $("#graph") ? "· tap a part to see what it does, drag to move it" : "· tap a part to see what it does";

  // focus: light up a part, its neighbours and the lines between them
  let open = null, drag = null, moved = false;
  function focus(id) {
    const near = new Set([id, ...edges.filter((e) => e.a === id || e.b === id).flatMap((e) => [e.a, e.b])]);
    map.classList.add("hovering");
    map.querySelectorAll(".gnode").forEach((x) => x.classList.toggle("lit", near.has(x.dataset.part)));
    map.querySelectorAll("[data-a]").forEach((x) => x.classList.toggle("lit", x.dataset.a === id || x.dataset.b === id));
  }
  function unfocus() {
    if (open) return focus(open);
    map.classList.remove("hovering");
    map.querySelectorAll(".lit").forEach((x) => x.classList.remove("lit"));
  }
  if ($("#graph")) {
    map.addEventListener("mouseover", (ev) => { const n = ev.target.closest(".gnode"); if (n && !drag) focus(n.dataset.part); });
    map.addEventListener("mouseleave", () => { if (!drag) unfocus(); });
    // drag a circle to rearrange; a press without movement is a tap
    const svgPt = (ev) => { const r = $("#graph").getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }; };
    map.addEventListener("pointerdown", (ev) => { const g = ev.target.closest(".gnode"); if (!g) return; drag = { n: NI.get(g.dataset.part), g, at: svgPt(ev) }; moved = false; g.setPointerCapture(ev.pointerId); });
    map.addEventListener("pointermove", (ev) => {
      if (!drag) return;
      const pt = svgPt(ev), n = drag.n;
      if (!moved && Math.hypot(pt.x - drag.at.x, pt.y - drag.at.y) < 4) return;
      moved = true;
      n.x = Math.max(n.r, Math.min(W - n.r, pt.x)); n.y = Math.max(n.r, Math.min(H - n.r - 36, pt.y));
      drag.g.setAttribute("transform", "translate(" + n.x + "," + n.y + ")");
      for (const e of edges) if (e.a === n.id || e.b === n.id) { const w = wire(e); document.getElementById(eid(e)).setAttribute("d", w.d); const t = document.getElementById(eid(e) + "t"); t.setAttribute("x", w.mx); t.setAttribute("y", w.my - 6); }
    });
    map.addEventListener("pointerup", () => { if (!drag) return; const id = drag.n.id; drag = null; if (!moved) openPart(id); else saveLayout(); });
    map.addEventListener("keydown", (ev) => { const g = ev.target.closest(".gnode"); if (g && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); openPart(g.dataset.part); } });
  }

  // ---- a part, in a sheet: what needs fixing, what it should do, who can do what, how it connects ----
  const ORDER = { bad: 0, warn: 1, none: 2, good: 3 }, MARK = { good: "✓", bad: "!", warn: "?", none: "–" };
  const sortReqs = (rs) => [...rs].sort((a, b) => ORDER[M.statusOf(a).tone] - ORDER[M.statusOf(b).tone]);
  const reqHTML = (r, hidden) => { const t = M.ruleText(r), s = M.statusOf(r); return '<button class="req' + (hidden ? " x" : "") + '"' + (hidden ? ' data-g="' + hidden + '"' : "") + '><span class="mark ' + s.tone + '">' + MARK[s.tone] + '</span><span class="tx"><span>' + t.head + '</span><div class="why">' + esc(s.label) + (r.stale ? " · out of date" : "") + "</div>" + (t.rest ? '<div class="more">' + t.rest + "</div>" : "") + "</span></button>"; };
  const fold = (g, items, render, n, label) => items.slice(0, n).map((x) => render(x)).join("") + items.slice(n).map((x) => render(x, g)).join("") + (items.length > n ? '<button class="showall" data-unfold="' + g + '">' + label(items.length - n) + " →</button>" : "");
  const WHO = { guests: "Guests can", staff: "Staff can", owner: "The owner can", "other services": "Other services can", internal: "Internally", public: "Anyone can", auth: "Signed-in users can" };
  function partHTML(p) {
    const key = p.id.replace(/\W/g, "");
    const rs = sortReqs(p.rs), bad = rs.filter((r) => M.statusOf(r).tone === "bad"), mid = rs.filter((r) => ["warn", "none"].includes(M.statusOf(r).tone)), done = rs.filter((r) => M.statusOf(r).tone === "good");
    const rg = new Map(); for (const f of p.risks) { const g = rg.get(f.title) || { f, n: 0 }; g.n++; rg.set(f.title, g); }
    const riskHTML = [...rg.values()].map((g) => '<div class="req"><span class="mark bad">!</span><span class="tx"><span><b>' + esc(g.f.title) + "</b>" + (g.n > 1 ? ' <span class="x-n">×' + g.n + "</span>" : "") + '</span><div class="why">' + esc(g.f.why || "") + "</div></span></div>").join("");
    const reqBlock = (riskHTML ? '<div class="sub-h">Needs fixing</div>' + riskHTML + '<div class="gap"></div>' : "") + '<div class="sub-h">What it should do</div>' + (rs.length
      ? bad.map((r) => reqHTML(r)).join("") + fold("n-" + key, mid, reqHTML, bad.length ? 2 : 4, (k) => "Show " + k + " more not proven yet")
        + (done.length ? '<button class="req" data-unfold="d-' + key + '"><span class="mark good">✓</span><span class="tx"><span><b>' + (bad.length + mid.length ? plural(done.length, "more requirement") : "All " + plural(done.length, "requirement")) + '</b></span><div class="why">Proven by tests · tap to see them</div></span></button>' + done.map((r) => reqHTML(r, "d-" + key)).join("") : "")
      : '<div class="empty-req">No requirements are written for this part yet, so Veridic can\'t tell whether it does the right thing. Ask Claude to <b>write a spec for ' + esc(p.name) + "</b>.</div>");
    // things you can do, grouped by who can do them; a hollow dot = no test calls it
    const byWho = new Map(); for (const r of p.routes) { const k = M.who(r); if (!byWho.has(k)) byWho.set(k, []); byWho.get(k).push(r); }
    const actHTML = (r, hidden) => '<div class="act' + (hidden ? " x" : "") + '"' + (hidden ? ' data-g="' + hidden + '"' : "") + '><span class="k' + (p.untested.includes(r.id) ? " un" : "") + '"></span><span class="t">' + esc(M.act(r.method, r.path)) + "</span></div>";
    const acts = [...byWho].map(([k, list]) => '<div class="aud">' + esc(WHO[k] || cap(k)) + '</div><div class="acts">' + fold("a-" + key + k.replace(/\W/g, ""), list, actHTML, 5, (n) => "Show " + n + " more") + "</div>").join("") + (p.untested.length ? '<div class="acts-key"><i></i>no test calls it yet</div>' : "");
    const out = edges.filter((e) => e.a === p.id), inn = edges.filter((e) => e.b === p.id);
    const chip = (id) => '<span class="chip link" data-part="' + esc(id) + '">' + esc(P.get(id).name) + "</span>";
    const row = (warn, html, hidden) => '<div class="conn' + (warn ? " warn" : "") + (hidden ? " x" : "") + '"' + (hidden ? ' data-g="' + hidden + '"' : "") + '><span class="ci"></span><span>' + html + "</span></div>";
    const conns = [
      ...out.flatMap((e) => [e.changes.length && [true, "Changes <b>" + esc(e.changes.join(", ")) + "</b>, which belong to " + chip(e.b)], e.uses && [false, "Uses " + chip(e.b)], e.reads.length && [false, "Reads <b>" + esc(e.reads.join(", ")) + "</b> kept by " + chip(e.b)]]),
      ...inn.flatMap((e) => [e.changes.length && [true, chip(e.a) + " changes its <b>" + esc(e.changes.join(", ")) + "</b>"], e.uses && [false, chip(e.a) + " uses it"], e.reads.length && [false, chip(e.a) + " reads its <b>" + esc(e.reads.join(", ")) + "</b>"]]),
    ].filter(Boolean);
    const side = (p.routes.length ? '<div><div class="sub-h">Things you can do</div>' + acts + "</div>" : "") +
      (conns.length ? '<div><div class="sub-h">How it connects</div>' + fold("c-" + key, conns, ([w, h], hidden) => row(w, h, hidden), 6, (k) => "Show " + k + " more") + "</div>" : "");
    const nr = rg.size;
    const summary = p.health === "bad" ? [nr ? plural(nr, "risk") + " to fix" : "", p.broken.length ? plural(p.broken.length, "requirement") + " the code breaks today" : ""].filter(Boolean).join(" · ") + "."
      : p.health === "warn" ? (p.rs.length ? "Works as written; not everything is proven yet." : "Works, but nothing says how it should.")
      : p.health === "good" ? "Does everything it should, and tests prove it." : "";
    return '<div class="part-head"><div><h3><i class="sh ' + p.health + '">' + SH[p.health] + "</i>" + esc(p.name) + "</h3><p>" + summary + '</p></div><button class="close" aria-label="Close">✕</button></div><div class="cols"><div>' + reqBlock + '</div><div class="side">' + side + "</div></div>";
  }
  function openPart(id) {
    const p = P.get(id); if (!p) return;
    const panel = $("#panel");
    if (open === id && panel.classList.contains("open")) { closePart(); return; }
    map.querySelectorAll(".gnode").forEach((n) => n.classList.toggle("sel", n.dataset.part === id));
    open = id;
    if ($("#graph")) focus(id);
    $("#part").innerHTML = partHTML(p);
    panel.scrollTop = 0;
    panel.classList.add("open");
    document.body.classList.add("sheet-open");
    try { history.replaceState(null, "", "#" + encodeURIComponent(id)); } catch {}
  }
  function closePart() {
    open = null;
    if ($("#graph")) unfocus();
    $("#panel").classList.remove("open");
    document.body.classList.remove("sheet-open");
    map.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
    try { history.replaceState(null, "", location.pathname + location.search); } catch {}
  }
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && open) closePart(); });
  $("#scrim").addEventListener("click", closePart);
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t.closest("#graph")) return; // the graph opens parts on pointerup
    const pt = t.closest("[data-part]");
    if (pt) {
      if (pt.classList.contains("card")) { const n = map.querySelector('.gnode[data-part="' + CSS.escape(pt.dataset.part) + '"]'); if (n) { n.classList.remove("pulse"); void n.getBBox(); n.classList.add("pulse"); } }
      if (pt.closest(".sheet")) open = null; // a link inside the sheet switches to that part
      openPart(pt.dataset.part);
      return;
    }
    if (t.closest(".close")) { closePart(); return; }
    const uf = t.closest("[data-unfold]");
    if (uf) { document.querySelectorAll('[data-g="' + uf.dataset.unfold + '"]').forEach((x) => x.classList.remove("x")); uf.remove(); return; }
    const rq = t.closest(".req");
    if (rq) rq.classList.toggle("open");
  });

  // ---- fix first, then what can wait ----
  const card = (l, s, i, g) => '<button class="card' + (i >= 6 ? " x" : "") + '" data-g="' + g + '"' + (l.parts.length ? ' data-part="' + esc(l.parts[0]) + '"' : "") + '><i class="sh ' + s + '">' + (s === "bad" ? "!" : "?") + '</i><span><div class="t">' + l.html + (l.n > 1 ? ' <span class="x-n">×' + l.n + "</span>" : "") + '</div><div class="w">' + l.w + "</div>" + (l.parts.length ? '<div class="p">' + esc(M.whereOf(l.parts)) + " →</div>" : "") + "</span></button>";
  const deal = (sec, id, list, s) => {
    if (!list.length) { $(sec).remove(); return; }
    $("#" + id).innerHTML = list.map((l, i) => card(l, s, i, id)).join("");
    if (list.length > 6) $("#" + id).insertAdjacentHTML("afterend", '<button class="showall" data-unfold="' + id + '" style="margin-top:14px">Show all ' + list.length + " →</button>");
  };
  deal("#fix-sec", "fix", M.fix, "bad");
  deal("#later-sec", "later", M.later, "warn");
  if ($("#fix-n")) $("#fix-n").textContent = M.fix.length > 1 && M.nFix > M.fix.length ? "· " + plural(M.nFix, "problem") + " of " + M.fix.length + " kinds" : "";
  if (parts.length && !M.fix.length && !M.later.length) $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">Nothing to fix. Every part does what it should, and tests prove it.</div>');
  if (!parts.length) $("#foot").insertAdjacentHTML("beforebegin", '<div class="allgood">Veridic found no routes and no specs here yet. Ask Claude to <b>write a spec</b> for a part of this app, then run <code>veridic report</code> again.</div>');
  const errs = D.errors || [];
  $("#foot").innerHTML = "<span>" + esc(M.title) + " · " + [plural(parts.length, "part"), D.routes && D.routes.length ? plural(D.routes.length, "action") : "", M.proven.total ? plural(M.proven.total, "requirement") : ""].filter(Boolean).join(" · ") + "</span><span>Veridic · " + ago(D.generated).toLowerCase() + "</span>" +
    (errs.length ? '<details class="errs"><summary>' + plural(errs.length, "thing") + " Veridic couldn't check</summary>" + errs.map((e) => "<div>" + esc(e) + "</div>").join("") + "</details>" : "");

  // ---- theme: the system's by default; the toggle pins light or dark ----
  const dark = () => (document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
  const t0 = store.get("theme"); if (t0 === "light" || t0 === "dark") document.documentElement.dataset.theme = t0;
  const paint = () => { $("#theme").innerHTML = dark() ? SUN : MOON; $("#theme").title = dark() ? "Light mode" : "Dark mode"; };
  $("#theme").onclick = () => { const t = dark() ? "light" : "dark"; document.documentElement.dataset.theme = t; store.set("theme", t); paint(); };
  paint();

  // ---- motion: rings fill, numbers count; confetti when there's nothing to fix ----
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
  if (parts.length && !M.fix.length && !M.later.length && !calm) {
    const c = $("#confetti"), cl = ["#4cc38a", "#e3a73c", "#d97757", "#7aa7e8", "#c68be0"];
    c.innerHTML = [...Array(60)].map(() => '<i style="left:' + Math.random() * 100 + "vw;background:" + cl[(Math.random() * cl.length) | 0] + ";animation-delay:" + Math.random() * 0.8 + "s;transform:rotate(" + Math.random() * 360 + 'deg)"></i>').join("");
    setTimeout(() => (c.innerHTML = ""), 4000);
  }
  if (location.hash.length > 1) openPart(decodeURIComponent(location.hash.slice(1)));
})();
