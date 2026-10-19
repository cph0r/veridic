// Veridic report page. Reads the JSON embedded in the page and renders it; no
// network, no dependencies. Quiet by design: each view shows the few things that
// matter, and the rest opens on a click. Views: Home (the app's health, then
// everything app-wide in tabs) and a module's page (its spec and its health together). An observability tool: it
// shows the state of the repo and links to the code; it never acts on it.
(() => {
  "use strict";
  const D = JSON.parse(document.getElementById("data").textContent);
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get: (k) => { try { return localStorage.getItem("veridic-" + k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem("veridic-" + k, v); } catch {} },
  };
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  // ---- icons: only the few the chrome needs ----
  const P = {
    logo: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    pulse: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    blocks: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    branch: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6M18 11a6 6 0 0 1-6 6H9"/>',
    sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    db: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  };
  // A ring gauge: the share done, in the status colour.
  const ring = (p, c, size, label) => { const w = 5, r = (size - w) / 2, C = 2 * Math.PI * r, len = (Math.max(0, Math.min(100, p)) / 100) * C; return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '" aria-hidden="true"><circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="var(--line)" stroke-width="' + w + '"/><circle class="arc" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" fill="none" stroke="var(--' + (c || "faint") + ')" stroke-width="' + w + '" stroke-linecap="round" stroke-dasharray="0 ' + C + '" data-dash="' + len + " " + C + '" transform="rotate(-90 ' + size / 2 + " " + size / 2 + ')"/>' + (label != null ? '<text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle">' + label + "</text>" : "") + "</svg>"; };
  const ic = (n, cls) => '<svg class="i ' + (cls || "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[n] || "") + "</svg>";

  // ---- vocabulary: plain words for every state ----
  const rank = (s) => ({ high: 0, medium: 1, low: 2 })[s] ?? 3;
  const SEVC = { high: "high", medium: "med", low: "" };
  const EFF = { read: "reads", write: "changes data", destructive: "deletes data" };
  const ACC = { public: "Anyone", auth: "Signed-in users", role: "Admins or set roles" };
  const OWN = { yes: "Checks the data is the caller's", no: "Doesn't check whose data it is", weak: "Checks with values the client sends" };
  const REQ = {
    passing: ["Tested, passing", "ok"], covered: ["Tested", "ok"], failing: ["Test failing", "high"], unasserted: ["Its test checks nothing", "high"],
    tagged_only: ["Its test misses the code", "med"], todo: ["Test is a todo", ""], none: ["No test yet", "med"],
    broken: ["Broken, proven", "high"], // an expected-failure test shows the code breaks the rule
    marker_stale: ["Fixed: make its test a normal one", "med"], // the expected-failure test now fails
  };
  const tested = (r) => r.status === "passing" || r.status === "covered";

  // ---- data ----
  const F = D.findings || [];
  const ROUTES = D.routes || [];
  const SPECS = D.specs || [];
  const MODS = D.modules || [];
  const MOD = new Map(MODS.map((m) => [m.id, m]));
  const T = D.tests && D.tests.summary;
  const GROUPS = (() => {
    const m = new Map();
    for (const f of F) {
      const k = f.area + "|" + f.kind;
      if (!m.has(k)) m.set(k, { key: k, kind: f.kind, area: f.area, title: f.title || f.kind, why: f.why || "", fix: f.fix, severity: f.severity, items: [] });
      const g = m.get(k);
      g.items.push(f);
      if (rank(f.severity) < rank(g.severity)) g.severity = f.severity;
    }
    return [...m.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || b.items.length - a.items.length);
  })();
  const issuesByRoute = new Map();
  for (const f of F) if (f.area === "API" && f.severity !== "low") issuesByRoute.set(f.where, (issuesByRoute.get(f.where) || []).concat(f));
  const specReqs = (s) => s.requirements.filter((r) => r.requirement);
  const specName = (s) => {
    const parts = s.path.split("/");
    const base = parts.pop().replace(/\.md$/, "");
    const name = /^spec$/i.test(base) && parts.length ? parts.pop() : base.replace(/[-_.]?spec$/i, "") || base;
    return name.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  };
  const specTitle = (s) => (s.doc && s.doc.title) || specName(s);

  // ---- links, copy buttons ----
  let ED = store.get("editor") || "vscode";
  const LOC = /^([^\s:()]+\.[\w]+):(\d+)(?:-\d+)?/;
  const hrefOf = (t) => {
    const m = String(t).match(LOC);
    if (!m || ED === "none") return null;
    const abs = (D.repo + "/" + m[1]).replace(/\/+/g, "/");
    return ED + "://file" + encodeURI(abs.startsWith("/") ? abs : "/" + abs) + ":" + m[2];
  };
  const loc = (t, label, cls) => { const h = hrefOf(t); return h ? '<a class="loc ' + (cls || "") + '" href="' + h + '">' + esc(label || t) + "</a>" : '<span class="mono">' + esc(label || t) + "</span>"; };
  const fileLine = (f) => { const i = f.lastIndexOf("/"); return '<div class="fname">' + loc(f + ":1", f.slice(i + 1)) + '</div><div class="fdir">' + esc(f.slice(0, i + 1)) + "</div>"; };
  const modLink = (id) => { const m = MOD.get(id); return m ? '<button class="link" data-mod="' + esc(id) + '">' + esc(m.name) + "</button>" : esc(id); };
  const match = () => true; // no search: every list shows everything (its own filters aside)

  // Markdown, the little the specs and READMEs use: `code` (file:line becomes a link), **bold**, lists.
  const md = (t) => String(t ?? "").split(/`([^`]+)`/).map((p, i) => (i % 2 ? (LOC.test(p) ? loc(p) : "<code>" + esc(p) + "</code>") : esc(p).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"))).join("");
  const mdBlock = (t) => String(t ?? "").split(/\n\s*\n/).map((b) => {
    const ls = b.split("\n");
    if (ls.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) { const ol = /^\s*\d+\./.test(ls[0]); return "<" + (ol ? "ol" : "ul") + ">" + ls.map((l) => "<li>" + md(l.replace(/^\s*([-*]|\d+\.)\s+/, "")) + "</li>").join("") + "</" + (ol ? "ol" : "ul") + ">"; }
    return "<p>" + md(b) + "</p>";
  }).join("");

  // ---- the building blocks: a row, a row that opens, a section, a short list ----
  let seq = 0;
  const li = (main, end, attrs) => "<div class=\"li\"" + (attrs || "") + '><div class="main">' + main + "</div>" + (end ? '<div class="end">' + end + "</div>" : "") + "</div>";
  const liBtn = (main, end, attrs) => "<button class=\"li\"" + (attrs || "") + '><div class="main">' + main + "</div>" + (end ? '<div class="end">' + end + "</div>" : "") + "</button>";
  const liOpen = (main, end, detail, cls) => { const id = "d" + seq++; return '<div class="li click ' + (cls || "") + '" data-d="' + id + '"><div class="main">' + main + '</div><div class="end">' + (end || "") + ic("chev", "sm chev") + '</div></div><div class="detail" id="' + id + '" hidden>' + detail + "</div>"; };
  const section = (id, title, count, act) => '<h2 id="sec-' + id + '">' + title + (count != null ? '<span class="count">' + count + "</span>" : "") + (act ? '<span class="act">' + act + "</span>" : "") + "</h2>";
  const dot = (c) => '<span class="dot ' + (c || "") + '"></span>';
  const two = (title, sub) => '<div class="title">' + title + "</div>" + (sub ? '<div class="sub">' + sub + "</div>" : "");
  // A list shows a few rows; "Show all" opens the rest, paged.
  let PAGE = Number(store.get("page-size")) || 25;
  const PAGE_SIZE = PAGE;
  function few(key, list, n, render, cls) {
    if (!list.length) return "";
    const open = state.open.has(key) || list.length <= n + 1;
    let items = list.slice(0, n), tail = "";
    if (open && list.length > PAGE) {
      const pages = Math.ceil(list.length / PAGE), p = Math.min(state.pages[key] || 0, pages - 1);
      items = list.slice(p * PAGE, (p + 1) * PAGE);
      tail = '<div class="pager"><span>' + (p * PAGE + 1) + "–" + Math.min(list.length, (p + 1) * PAGE) + " of " + list.length + '</span><button data-page="' + key + '" data-p="' + (p - 1) + '"' + (p ? "" : " disabled") + ' aria-label="Previous page">←</button><button data-page="' + key + '" data-p="' + (p + 1) + '"' + (p < pages - 1 ? "" : " disabled") + ' aria-label="Next page">→</button></div>';
    } else if (open) items = list;
    else tail = '<button class="more" data-open="' + key + '">Show all ' + list.length + "</button>";
    return '<div class="list ' + (cls || "") + '">' + items.map(render).join("") + "</div>" + tail;
  }
  const empty = (text, action) => '<div class="empty"><div class="grow">' + text + "</div>" + (action || "") + "</div>";

  // Syntax tint for cited code: comments, strings, keywords, numbers.
  const KW = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(const|let|var|function|return|if|else|await|async|export|import|from|new|throw|try|catch|for|of|in|while|class|extends|default|switch|case|break|continue|typeof|null|undefined|true|false|this)\b|\b(\d+(?:\.\d+)?)\b/g;
  const hl = (line) => { let out = "", last = 0, m; KW.lastIndex = 0; while ((m = KW.exec(line))) { out += esc(line.slice(last, m.index)) + '<span class="' + (m[1] ? "k4" : m[2] ? "k3" : m[3] ? "k1" : "k2") + '">' + esc(m[0]) + "</span>"; last = KW.lastIndex; } return out + esc(line.slice(last)); };
  const codeBlock = (c) => '<pre class="code">' + c.code.split("\n").map((l, i) => '<span class="l"><span class="ln">' + (c.start + i) + "</span>" + hl(l) + "</span>").join("") + (c.truncated ? '<span class="l"><span class="ln">…</span></span>' : "") + "</pre>";

  const modRoutes = (m) => ROUTES.filter((r) => r.module === m.id);
  const modFindings = (m) => F.filter((f) => f.module === m.id);
  const screensOf = (m) => (m.screens || []).map((x) => x.file);
  const filesOf = (m) => [...m.files, ...m.code.filter((f) => !m.files.includes(f)), ...screensOf(m)];
  const nameOf = (id) => (MOD.get(id) || { name: id }).name;

  // ---- state ----
  const NAV = [
    { k: "modules", t: "Home", i: "home" },
  ];
  const fromHash = () => { const h = location.hash.slice(1).split("/"); return h[0] === "module" && h[1] ? { view: "module", mod: decodeURIComponent(h[1]), jump: h[2] } : NAV.some((n) => n.k === h[0]) ? { view: h[0] } : { view: "modules" }; };
  const state = { ...fromHash(), sub: "attention", sev: ["high", "medium"], area: "all", rf: "all", spec: -1, sf: "all", aboutOpen: false, openGroup: null, pages: {}, open: new Set() };

  // The sidebar's dot: only a module's own problems. Red: a serious issue or a call to an endpoint
  // that doesn't exist. Amber: issues to review, or it shares a table or a loop with another module.
  // App-wide gaps (no tests anywhere) are the home page's to say, not every module's.
  const sideDot = (m) => {
    if (m.stats.high || BROKEN.some((b) => b.module === m.id)) return "high";
    if (m.stats.medium || MODU.problems.some((p) => p.kind !== "hub" && p.modules.includes(m.id))) return "med";
    return null;
  };
  // A module's one status: its worst open issue, else "no tests" when it changes data untested. Most have none.
  const statusOf = (m) => {
    const s = m.stats;
    if (s.high) return { c: "high", t: plural(s.high + s.medium, "issue") };
    if (s.medium) return { c: "med", t: plural(s.medium, "issue") };
    if (s.writes + s.destructive && m.tests.untested.length === s.routes) return { c: "", t: "no tests" };
    return null;
  };

  // ---- Indicators: one word and a dot each, backed by a number ----
  const IND = { good: ["ok", "Good"], care: ["med", "Needs work"], risk: ["high", "At risk"] };
  const inModules = MODS.reduce((n, m) => n + m.stats.routes, 0);
  const untestedAll = MODS.reduce((n, m) => n + m.tests.untested.length, 0);
  const specsOf = (m) => SPECS.filter((sp) => m.specs.includes(sp.path));
  // A module's specs, its own first (specs/<module>/…); and the module a spec belongs to.
  const ownFirst = (m) => (a, b) => (b.path.includes("/" + m.id + "/") ? 1 : 0) - (a.path.includes("/" + m.id + "/") ? 1 : 0);
  const specOwner = (sp) => MODS.find((m) => sp.path.includes("/" + m.id + "/")) ?? MODS.find((m) => m.specs.includes(sp.path)) ?? null;
  function indicators(m) {
    const fs = m ? modFindings(m) : F;
    const hi = fs.filter((f) => f.severity === "high").length, me = fs.filter((f) => f.severity === "medium").length;
    const routes = m ? m.stats.routes : inModules || ROUTES.length;
    const tp = pct(routes - (m ? m.tests.untested.length : untestedAll), routes);
    const sp = pct(m ? m.specified : ROUTES.filter((r) => r.specs && r.specs.length).length, m ? m.stats.routes : ROUTES.length);
    // Out-of-date rules count toward the module that owns the spec, not every module it cites.
    const stale = (m ? SPECS.filter((x) => specOwner(x) === m) : SPECS).flatMap(specReqs).filter((r) => r.stale).length;
    const safe = pct(routes - new Set(fs.filter((f) => f.severity !== "low" && f.area === "API").map((f) => f.where)).size, routes);
    return [
      { k: "Safety", i: "shield", s: hi ? "risk" : me ? "care" : "good", p: safe, v: hi ? hi + " serious" : me ? me + " to review" : "of routes safe" },
      { k: "Tests", i: "flask", s: tp >= 70 ? "good" : tp >= 30 ? "care" : "risk", p: tp, v: "routes tested" },
      // The ring, its colour and its word all follow coverage; out-of-date rules are noted under it.
      { k: "Rules", i: "doc", s: sp >= 80 ? "good" : sp ? "care" : "risk", p: sp, v: (sp ? "routes covered" : "none written") + (stale ? " · " + stale + " out of date" : "") },
      ...(!m && ST.modularity ? [{ k: "Modularity", i: "blocks", s: MODU.pct >= 80 ? "good" : MODU.pct >= 50 ? "care" : "risk", p: MODU.pct, v: MODU.clean + "/" + MODU.modules + " separate" }] : []),
      ...(!m && ST.duplication ? [{ k: "Duplication", i: "copy", s: DUP.pct < 5 ? "good" : DUP.pct < 12 ? "care" : "risk", p: Math.round(DUP.pct), big: DUP.pct + "%", v: "of code copied" }] : []),
      ...(m && ST.modularity ? (() => { const ps = MODU.problems.filter((p) => p.kind !== "hub" && p.modules.includes(m.id)), ds = dupsOf(m).filter((b) => b.lines >= 10); const n = ps.length + ds.length; return [{ k: "Structure", i: "blocks", s: ps.some((p) => p.kind === "cycle") ? "risk" : n ? "care" : "good", p: n ? Math.max(10, 100 - n * 20) : 100, big: n ? String(n) : "✓", v: n ? (n === 1 ? "problem" : "problems") : "separate" }]; })() : []),
      // The change in progress: only while there is one. Without a claim it can't be checked.
      ...(!m && D.change && D.change.files.length ? [(() => { const c = D.change, claimed = c.claims.length; return { k: "Change", i: "branch", s: !c.done ? "risk" : claimed ? "good" : "care", p: c.done ? 100 : 0, big: !c.done ? String(c.problems.length) : claimed ? "✓" : String(c.files.length), v: !c.done ? "to finish" : claimed ? "in scope, tested" : plural(c.files.length, "file") + " changed, not claimed" }; })()] : []),
    ];
  }
  const indRow = (list) => '<div class="inds">' + list.map((i) => { const c = IND[i.s][0]; return "<" + (i.nav ? 'button data-nav="' + i.nav + '"' : "div") + ' class="ind">' + ring(i.p, c, 56, i.big != null ? esc(i.big) : i.p + "%") + '<div><div class="ik">' + ic(i.i, "sm") + i.k + '</div><div class="iv t-' + c + '">' + IND[i.s][1] + '</div><div class="id2">' + esc(i.v) + "</div></div></" + (i.nav ? "button" : "div") + ">"; }).join("") + "</div>";

  const riskOrder = (a, b) => (b.risk || 0) - (a.risk || 0);
  // What needs attention, most serious first: each an observation backed by an indicator, and a link to where it is.
  const ST = D.structure || {};
  const MODU = ST.modularity || { problems: [] };
  const DUP = ST.duplication || { blocks: [] };
  const dupsOf = (m) => DUP.blocks.filter((b) => b.a.module === m.id || b.b.module === m.id);
  const BROKEN = (D.ui && D.ui.broken) || [];
  const UNCALLED = D.uncalled || [];
  const base = (f) => f.split("/").pop();
  // On a module page each item opens in place to what it's about; on Home it leads to the module.
  const rowsOf = (items) => '<div class="list compact">' + items.join("") + "</div>";
  const DETAIL = {
    issues: (fs) => fs.map((f) => '<div class="aitem"><div class="title">' + dot(SEVC[f.severity]) + " " + esc(f.title || f.kind) + ' <span class="mono faint">' + esc(f.where) + "</span></div>" + issueDetail(f) + "</div>").join(""),
    stale: (rs) => rowsOf(rs.map((r) => li('<button class="link mono" data-req="' + esc(r.id) + '">' + esc(r.id) + "</button> " + esc(String(r.text).slice(0, 140)) + (String(r.text).length > 140 ? "…" : ""), r.cites.slice(0, 2).map((c) => loc(c.cite)).join(" ")))),
    writes: (p) => '<p class="small muted">Owned by ' + modLink(p.owner) + ". Writing it outside the owner means its rules live in two places.</p>" + rowsOf(Object.entries(p.at).flatMap(([o, locs]) => locs.map((l) => li(loc(l), '<span class="tag">' + esc(nameOf(o)) + "</span>")))),
    cycle: (p) => rowsOf(Object.entries(p.via).flatMap(([o, files]) => files.map((f) => li(loc(f + ":1"), '<span class="tag">' + esc(nameOf(o)) + " uses the other here</span>")))),
    broken: (br) => rowsOf(br.map((b) => li('<span class="mono">' + esc(b.url) + "</span>", loc(b.file + ":" + b.line, base(b.file) + ":" + b.line)))),
    uncalled: (un) => rowsOf(un.map((u) => li('<span class="mono">' + esc(u.route) + "</span>", loc(u.handler, base(u.handler.split(":")[0]))))),
    copies: (bs) => rowsOf(bs.map((b) => li(loc(b.a.file + ":" + b.a.start, base(b.a.file) + ":" + b.a.start) + '<span class="sep">=</span>' + loc(b.b.file + ":" + b.b.start, base(b.b.file) + ":" + b.b.start), '<span class="tag">' + b.lines + " lines</span>"))),
    untested: (m) => rowsOf(m.tests.untested.map((id) => { const r = ROUTES.find((x) => x.id === id); return li('<span class="mono">' + esc(id) + "</span>", r ? loc(r.handler, base(r.handler.split(":")[0])) : ""); })),
  };
  function attention(scope) {
    const out = [];
    const mods = scope ? [scope] : [...MODS].sort(riskOrder);
    const go = (m) => (scope ? "" : ' data-mod="' + esc(m.id) + '"');
    const c = D.change;
    if (!scope && c && !c.done) out.push({ k: "change", i: "branch", c: "high", t: "The change in progress isn't done", why: c.problems.slice(0, 2).join("; ") + " · run veridic done for the details" });
    for (const m of mods) {
      const fs = modFindings(m).filter((f) => f.severity === "high");
      if (fs.length) out.push({ k: "high", i: "shield", c: "high", t: plural(fs.length, "serious issue") + (scope ? "" : " in " + m.name), why: [...new Set(fs.map((f) => f.title || f.kind))].join("; "), go: go(m), d: scope && DETAIL.issues(fs) });
    }
    for (const [sp, si] of SPECS.map((x, i) => [x, i]).filter(([x]) => !scope || specOwner(x) === scope)) {
      const st = specReqs(sp).filter((r) => r.stale);
      if (st.length) out.push({ k: "stale", i: "doc", c: "med", t: plural(st.length, "rule") + " out of date", why: specTitle(sp) + ": the code behind " + st.map((r) => r.id).join(", ") + " changed since they were written", go: scope || !specOwner(sp) ? "" : ' data-mod="' + esc(specOwner(sp).id) + '" data-to="rules"', d: scope && DETAIL.stale(st) });
    }
    for (const m of mods) {
      const fs = modFindings(m).filter((f) => f.severity === "medium" && f.area !== "Spec");
      if (fs.length && !modFindings(m).some((f) => f.severity === "high")) out.push({ k: "med", i: "shield", c: "med", t: plural(fs.length, "issue") + " to review" + (scope ? "" : " in " + m.name), why: [...new Set(fs.map((f) => f.title || f.kind))].join("; "), go: go(m), d: scope && DETAIL.issues(fs) });
    }
    for (const p of MODU.problems.filter((p) => p.kind !== "hub" && (!scope || p.modules.includes(scope.id))).slice(0, scope ? 4 : 3)) {
      if (p.kind === "shared-writes") { const locs = Object.values(p.at).flat(); out.push({ k: "writes", i: "branch", c: "med", t: p.names.slice(1).join(", ") + " also write" + (p.names.length > 2 ? "" : "s") + " " + p.table, why: "Owned by " + p.names[0] + "; written outside it at " + locs.slice(0, 2).map(base).join(", "), go: go(MOD.get(p.owner)), d: scope && DETAIL.writes(p) }); }
      else out.push({ k: "cycle", i: "branch", c: "med", t: p.names.join(" and ") + " depend on each other", why: "A change to either can break the other", go: go(MOD.get(p.modules[0])), d: scope && DETAIL.cycle(p) });
    }
    const br = BROKEN.filter((b) => !scope || b.module === scope.id);
    if (br.length) out.push({ k: "broken", i: "route", c: "high", t: plural(br.length, "call") + " to endpoints that don't exist", why: [...new Set(br.map((b) => b.url))].slice(0, 3).join(", ") + " · in " + [...new Set(br.map((b) => base(b.file)))].slice(0, 2).join(", "), go: scope ? "" : ' data-sub="structure"', d: scope && DETAIL.broken(br) });
    const un = UNCALLED.filter((u) => !scope || u.module === scope.id);
    if (un.length) out.push({ k: "uncalled", i: "route", c: "", t: plural(un.length, "endpoint") + " nothing in the repo calls", why: un.slice(0, 3).map((u) => u.route).join(", ") + (un.length > 3 ? ", …" : "") + " · no screen or test uses them", go: scope ? "" : ' data-sub="structure"', d: scope && DETAIL.uncalled(un) });
    const blocks = (scope ? dupsOf(scope) : DUP.blocks).filter((b) => b.lines >= 10);
    if (blocks.length) { const b = blocks[0]; out.push({ k: "copies", i: "copy", c: "", t: plural(blocks.length, "block") + " of copied code" + (scope ? "" : ", " + DUP.pct + "% of the code"), why: "Largest: " + b.lines + " lines in " + base(b.a.file) + " and " + base(b.b.file), go: scope ? "" : ' data-sub="structure"', d: scope && DETAIL.copies(blocks) }); }
    const needTests = mods.filter((m) => m.tests.untested.length && m.stats.writes + m.stats.destructive + m.stats.money).slice(0, scope ? 1 : 2);
    for (const m of needTests) out.push({ k: "untested", i: "flask", c: m.stats.money ? "high" : "med", t: (scope ? "" : m.name + ": ") + m.tests.untested.length + " of " + plural(m.stats.routes, "route") + " untested", why: m.stats.money ? "It moves money" : m.stats.destructive ? "It deletes data" : "It changes data", go: go(m), d: scope && DETAIL.untested(m) });
    for (const m of mods.filter((m) => !m.specified).slice(0, 1)) out.push({ k: "norules", i: "doc", c: "", t: (scope ? "No" : m.name + " has no") + " written rules", why: "Nothing says what its routes must do, so a bug and an intended change look the same", go: scope ? "" : ' data-mod="' + esc(m.id) + '"' });
    if (!scope && T && T.unasserted + T.empty) out.push({ k: "tests", i: "flask", c: "med", t: plural(T.unasserted + T.empty, "test") + " check nothing", why: "They pass even when the code is broken", go: ' data-sub="tests"' });
    return out;
  }
  // Home's list: one card per module with problems (its items in one line, worst first), then
  // the few things that belong to no module. The module's page has each item in detail.
  const RANKC = { high: 0, med: 1, "": 2 };
  // A module's problems as short counts, in the order they matter.
  function summary(m, items) {
    const n = (k) => items.filter((x) => x.k === k).length;
    const f = (sev) => modFindings(m).filter((x) => x.severity === sev && x.area !== "Spec").length;
    const st = SPECS.filter((x) => specOwner(x) === m).flatMap(specReqs).filter((r) => r.stale).length;
    const parts = [
      n("high") && f("high") + " serious",
      n("med") && f("medium") + " to review",
      n("broken") && plural(BROKEN.filter((b) => b.module === m.id).length, "broken call"),
      n("stale") && plural(st, "rule") + " out of date",
      n("writes") && plural(n("writes"), "shared table"),
      n("cycle") && "a dependency loop",
      n("uncalled") && plural(UNCALLED.filter((u) => u.module === m.id).length, "uncalled endpoint"),
      n("copies") && plural(dupsOf(m).filter((b) => b.lines >= 10).length, "copied block"),
      n("untested") && m.tests.untested.length + "/" + m.stats.routes + " untested",
      n("norules") && "no rules",
    ];
    return parts.filter(Boolean).join(" · ");
  }
  function homeAttention() {
    const out = [];
    const c = D.change;
    if (c && !c.done) out.push({ i: "branch", c: "high", t: "The change in progress isn't done", why: c.problems.slice(0, 2).join("; ") + " · run veridic done for the details", w: -1 });
    for (const m of MODS) {
      const items = attention(m);
      if (!items.length) continue;
      const worst = items.reduce((a, x) => (RANKC[x.c || ""] < RANKC[a.c || ""] ? x : a), items[0]);
      out.push({ i: worst.i, c: worst.c, t: m.name, why: summary(m, items), go: ' data-mod="' + esc(m.id) + '"', w: RANKC[worst.c || ""] * 1000 - items.length * 10 - (m.risk || 0) / 1e4 });
    }
    const loose = BROKEN.filter((b) => !b.module);
    if (loose.length) out.push({ i: "route", c: "high", t: plural(loose.length, "call") + " to endpoints that don't exist, in shared code", why: [...new Set(loose.map((b) => b.url))].slice(0, 3).join(", ") + " · in " + [...new Set(loose.map((b) => base(b.file)))].slice(0, 2).join(", "), go: ' data-sub="structure"', w: 500 });
    if (T && T.unasserted + T.empty) out.push({ i: "flask", c: "med", t: plural(T.unasserted + T.empty, "test") + " check nothing", why: "They pass even when the code is broken", go: ' data-sub="tests"', w: 1500 });
    return out.sort((a, b) => a.w - b.w);
  }
  const attList = (items, n) => items.length
    ? '<div class="steps">' + items.slice(0, n).map((s) => {
      const body = '<span class="sico ' + (s.c || "none") + '">' + ic(s.i) + '</span><div class="main"><div class="title">' + esc(s.t) + '</div><div class="sub" title="' + esc(s.why) + '">' + esc(s.why) + "</div></div>";
      if (s.d) { const id = "d" + seq++; return '<div class="stepwrap"><div class="stepc click" data-d="' + id + '">' + body + ic("chev", "sm faint chev") + '</div><div class="sdetail" id="' + id + '" hidden>' + s.d + "</div></div>"; }
      return "<" + (s.go ? "button" : "div") + ' class="stepc' + (s.go ? " go" : "") + '"' + (s.go || "") + ">" + body + (s.go ? ic("chev", "sm faint") : "") + "</" + (s.go ? "button" : "div") + ">";
    }).join("") + "</div>"
    : empty("Nothing needs attention. Every route is checked, tested and covered by rules.");

  // ---- Home: the repo in a glance, and what to do next ----
  function vModules() {
    const A = D.app;
    let h = "<h1>" + esc((A && A.title) || D.name) + "</h1>";
    h += A ? '<div class="about clamp">' + mdBlock(A.about.split(/\n\s*\n/)[0]) + "</div>" : '<p class="lead">No README describes this app yet.</p>';
    h += indRow(indicators(null));
    // Everything app-wide, one tab at a time; what needs attention first.
    const items = homeAttention();
    const subs = [["attention", "Needs attention", items.length || null], ["modules", "Modules", MODS.length || null], ["findings", "Findings", F.filter((f) => f.severity !== "low").length], ["routes", "Routes", ROUTES.length], ["tests", "Tests", T ? T.tests : null], ["structure", "Structure", null]];
    h += '<div class="tabs" id="sec-tabs">' + subs.map(([k, t, n]) => '<button class="tab" data-f="sub" data-v="' + k + '" aria-pressed="' + (state.sub === k) + '">' + t + (n ? '<span class="n">' + n.toLocaleString() + "</span>" : "") + "</button>").join("") + "</div>";
    const tab = { attention: () => attList(items, state.open.has("steps") ? 99 : 6) + (items.length > 6 && !state.open.has("steps") ? '<button class="more" data-open="steps">Show all ' + items.length + "</button>" : "") + (D.errors && D.errors.length ? section("errors", "Couldn't check") + '<p class="muted small">' + D.errors.map(esc).join("<br>") + "</p>" : ""), modules: oModules, findings: oFindings, routes: oRoutes, tests: oTests, structure: oStructure };
    return h + (tab[state.sub] || tab.attention)();
  }

  // ---- A module: a glance, its next steps, and a box to change it. The detail is the agent's, behind "Details" ----
  function vModule() {
    const m = MOD.get(state.mod);
    if (!m) { state.view = "modules"; return vModules(); }
    let h = '<button class="back" data-nav="modules">' + ic("back", "sm") + "Home</button>";
    h += "<h1>" + esc(m.name) + "</h1>";
    // Its purpose: the spec's title when it has one; otherwise what its routes let callers do.
    const own = specsOf(m).sort(ownFirst(m))[0];
    if (own) h += '<p class="lead">' + esc(specTitle(own)) + "</p>";
    else if (m.does.length) h += '<p class="lead">Lets callers ' + m.does.slice(0, 4).map(esc).join(", ") + (m.does.length > 4 ? ", and more" : "") + ".</p>";
    h += '<div class="mgrid"><div class="mcol">' + indRow(indicators(m));
    h += section("next", "Needs attention");
    h += attList(attention(m), 8) + moduleRules(m) + '</div><aside class="mside">' + shape(m) + "</aside></div>";
    h += '<details class="details"' + (state.open.has("details") ? " open" : "") + ' data-details><summary>Details<span class="faint"> · ' + plural(m.stats.routes, "route") + ((m.data && m.data.owns.length) ? ", " + plural(m.data.owns.length, "table") : "") + ((m.screens || []).length ? ", " + plural(m.screens.length, "screen") : "") + "</span></summary>" + moduleDetails(m) + "</details>";
    return h;
  }
  // The module's shape, as pictures: what its routes do, its data, its screens, its neighbours.
  function shape(m) {
    const st = m.stats, d = m.data || { owns: [], uses: [] };
    const segs = [["money", st.money, "high", "move money"], ["del", st.destructive, "med", "delete"], ["write", Math.max(0, st.writes - st.money), "text-2", "change data"], ["read", st.reads, "faint", "read"]].filter((x) => x[1]);
    const tot = segs.reduce((n, x) => n + x[1], 0) || 1;
    let h = '<div class="card"><div class="ik">' + ic("route", "sm") + plural(st.routes, "route") + '</div><div class="sbar">' + segs.map((x) => '<span style="background:var(--' + x[2] + ')" data-w="' + (x[1] / tot) * 100 + '" title="' + x[1] + " " + x[3] + '"></span>').join("") + '</div><div class="slegend">' + segs.map((x) => '<span>' + '<i style="background:var(--' + x[2] + ')"></i>' + x[1] + " " + x[3] + "</span>").join("") + "</div></div>";
    if (d.owns.length || d.uses.length) h += '<div class="card"><div class="ik">' + ic("db", "sm") + "Data</div>" + '<div class="chips">' + d.owns.map((t) => '<span class="chip own" title="Owns: read by ' + t.reads + ", written by " + t.writes + ", deleted by " + t.deletes + (t.alsoWrittenBy.length ? "; also changed by " + t.alsoWrittenBy.map(nameOf).join(", ") : "") + '">' + esc(t.table) + (t.alsoWrittenBy.length ? '<b class="t-med">●</b>' : "") + "</span>").join("") + d.uses.slice(0, 10).map((t) => '<span class="chip" title="Reads; owned by ' + esc(nameOf(t.owner)) + '">' + esc(t.table) + "</span>").join("") + (d.uses.length > 10 ? '<span class="chip faint">+' + (d.uses.length - 10) + "</span>" : "") + '</div><div class="slegend"><span><i class="solid"></i>owns</span><span><i class="hollow"></i>reads</span>' + (d.owns.some((t) => t.alsoWrittenBy.length) ? '<span><b class="t-med">●</b> shared writes</span>' : "") + "</div></div>";
    const sc = m.screens || [];
    if (sc.length) { const by = {}; for (const x of sc) by[x.kind] = (by[x.kind] || 0) + 1; h += '<div class="card"><div class="ik">' + ic("monitor", "sm") + "Screens</div>" + '<div class="bignums">' + Object.entries(by).map(([k, n]) => '<div><div class="v">' + n + '</div><div class="k">' + k + (n > 1 ? "s" : "") + "</div></div>").join("") + "</div></div>"; }
    if (m.usedBy.length || m.uses.length) h += '<div class="card"><div class="ik">' + ic("branch", "sm") + "Connected</div>" + (m.usedBy.length ? '<div class="clabel">Used by</div><div class="chips">' + m.usedBy.map((u) => '<button class="chip link2" data-mod="' + esc(u.module) + '">' + esc(nameOf(u.module)) + "</button>").join("") + "</div>" : "") + (m.uses.length ? '<div class="clabel">Uses</div><div class="chips">' + m.uses.map((u) => '<button class="chip link2" data-mod="' + esc(u.module) + '">' + esc(nameOf(u.module)) + "</button>").join("") + "</div>" : "") + "</div>";
    return h;
  }
  // The module's rules, from its spec (and any other spec citing its code): status at a glance,
  // the whole spec one click away.
  // A spec's rules as a table: the rule (clamped; full text, checks, tests and code on open),
  // whether a test checks it, whether its code changed, and any open question it carries.
  const QUESTION = /\s*\[NEEDS CLARIFICATION:\s*([^\]]+)\]/i;
  function rulesTable(key, s, list, size) {
    return pagedTable(key, list, [["ID", "76px"], "Rule", ["Test", "96px"], ["Code", "80px"], ["", "112px"]], (r) => {
      const st = REQ[r.status] || REQ.none, q = String(r.text).match(QUESTION);
      return [
        '<span class="id mono">' + esc(r.id) + "</span>",
        '<div class="rtext">' + md(String(r.text).replace(QUESTION, "")) + "</div>",
        tested(r) ? '<span class="t-ok">' + ic("check", "sm") + " tested</span>" : '<span class="' + (st[1] === "high" ? "t-high" : "faint") + '">' + esc(st[0] === "No test yet" ? "no test" : st[0].toLowerCase()) + "</span>",
        r.stale ? '<span class="t-med">changed</span>' : '<span class="faint">current</span>',
        q ? '<span class="t-med" title="' + esc(q[1]) + '">open question</span>' : "",
      ];
    }, (r) => { const q = String(r.text).match(QUESTION); return '<p class="rfull">' + md(String(r.text).replace(QUESTION, "")) + "</p>" + (q ? '<div class="fix"><b>Open question.</b> ' + md(q[1]) + "</div>" : "") + reqDetail(s, r); }, size, (r) => "req-" + cssId(r.id));
  }
  // The module's spec, the parts a person reads: what it should do (stories, each opening to its
  // scenarios), then its rules as a table. The full spec.md is a click away in the editor.
  const RULES = {}; // table key -> the rules it lists, to find a rule's page
  function moduleRules(m) {
    // Its own specs (those that belong to it); others that also cite its code get one line.
    const touching = SPECS.map((sp, i) => [sp, i]).filter(([sp]) => m.specs.includes(sp.path)).sort(([a], [b]) => ownFirst(m)(a, b));
    const specs = touching.filter(([sp]) => specOwner(sp) === m);
    const others = touching.filter(([sp]) => specOwner(sp) !== m);
    const also = others.length ? '<p class="small muted" style="margin-top:10px">Also covered by ' + others.map(([sp]) => { const o = specOwner(sp); return o ? '<button class="link" data-mod="' + esc(o.id) + '" data-to="rules">' + esc(o.name) + "'s spec</button>" : loc(sp.path + ":1", specName(sp)); }).join(", ") + ".</p>" : "";
    if (!specs.length) return section("rules", "Rules") + empty("No spec yet. Nothing written says what these routes must do, so nothing can tell a bug from an intended change." + (m.stats.money ? " It moves money, so it's a good one to start with." : "") + " <code>/veridic:specs " + esc(m.id) + "</code> in Claude Code writes one.") + also;
    const stories = specs.flatMap(([sp]) => ((sp.doc && sp.doc.stories) || []));
    let h = "";
    if (stories.length) {
      h += section("stories", "What it should do", stories.length);
      h += few("stories", stories, 5, (st) => liOpen(two(md(st.title), st.why ? md(st.why) : ""), st.scenarios.length ? '<span class="tag hide-sm">' + plural(st.scenarios.length, "scenario") + "</span>" : "",
        st.scenarios.map((sc) => '<dl class="gwt"><dt>Given</dt><dd>' + md(sc.given) + "</dd><dt>When</dt><dd>" + md(sc.when) + "</dd><dt>Then</dt><dd>" + md(sc.then) + (sc.refs.length ? ' <span class="faint">' + sc.refs.map((r) => '<button class="link mono" data-req="' + esc(r) + '">' + esc(r) + "</button>").join(" ") + "</span>" : "") + "</dd></dl>").join("") || '<p class="muted small">No scenarios written.</p>'));
    }
    for (const [sp, si] of specs) {
      const shown = specReqs(sp);
      RULES["rules-" + si] = shown;
      h += section("rules", specs.length > 1 ? "Rules · " + esc(specName(sp)) : "Rules", shown.length, loc(sp.path + ":1", "spec.md", "plain"));
      h += rulesTable("rules-" + si, sp, shown, 10);
    }
    return h + also;
  }
  function moduleDetails(m) {
    const s = m.stats, rs = modRoutes(m), fs = modFindings(m).filter((f) => f.severity !== "low");
    let h = "";

    // Issues: only when there are some.
    if (fs.length) {
      h += section("issues", "Issues", fs.length, "");
      h += few("issues", fs.sort((a, b) => rank(a.severity) - rank(b.severity)), 3, (f) => liOpen(
        '<div style="display:flex;gap:12px;align-items:baseline">' + dot(SEVC[f.severity]) + '<div style="min-width:0">' + two(esc(f.title || f.kind), '<span class="mono">' + esc(f.where) + "</span>") + "</div></div>", "", issueDetail(f)));
    }

    // Routes.
    h += section("routes", "Routes", rs.length);
    h += few("mod-routes", rs.filter((r) => match(r.id)), 8, (r) => routeRow(r, m));

    // Data: the tables it owns, and those it only reads.
    const d = m.data || { owns: [], uses: [] };
    if (d.owns.length || d.uses.length) {
      h += section("data", "Data");
      h += few("owns", d.owns, 6, (t) => li(
        two('<span class="mono">' + esc(t.table) + "</span>", [t.reads && "read by " + plural(t.reads, "route"), t.writes && "written by " + t.writes, t.deletes && "deleted by " + t.deletes].filter(Boolean).join(", ") +
          (t.alsoWrittenBy.length ? '<span class="sep">·</span>also changed by ' + (t.alsoWrittenBy.length > 3 ? plural(t.alsoWrittenBy.length, "other module") : t.alsoWrittenBy.map((x) => (MOD.get(x) || { name: x }).name).join(", ")) : "")),
        t.at ? '<span class="hide-sm">' + loc(t.at, "schema", "plain") + "</span>" : ""), "compact");
      if (d.uses.length) h += '<p class="small muted" style="margin-top:10px">Also reads ' + d.uses.slice(0, 8).map((t) => '<span class="mono">' + esc(t.table) + "</span>" + (t.owner ? " (" + modLink(t.owner) + ")" : "")).join(", ") + (d.uses.length > 8 ? ", and " + (d.uses.length - 8) + " more" : "") + ".</p>";
    }

    // Screens.
    const sc = (m.screens || []).filter((x) => match(x.file));
    if (sc.length || (m.calledFrom || []).length) {
      h += section("screens", "Screens", sc.length || null);
      h += few("screens", sc, 6, (x) => li(fileLine(x.file), '<span class="hide-sm">' + x.kind + '</span><span class="sep hide-sm">·</span>' + plural(x.routes.length, "call")), "compact");
      if ((m.calledFrom || []).length) h += '<p class="small muted" style="margin-top:10px">Also called from ' + m.calledFrom.slice(0, 4).map((x) => loc(x.file + ":1", x.file.split("/").pop()) + (x.module ? " (" + modLink(x.module) + ")" : "")).join(", ") + (m.calledFrom.length > 4 ? ", and " + (m.calledFrom.length - 4) + " more" : "") + ".</p>";
    }

    // Tests: one sentence and one action.
    const nT = s.routes - m.tests.untested.length;
    h += section("tests", "Tests");
    h += '<div class="li" style="border-top:1px solid var(--line)"><div class="main"><div>' + (nT === s.routes ? "Every route has a test." : nT + " of " + plural(s.routes, "route") + " have a test.") + '</div><div class="meter"><span data-w="' + pct(nT, s.routes) + '"></span></div></div><div class="end">' + "" + "</div></div>";
    if (m.tests.files.length) h += few("testfiles", m.tests.files, 3, (t) => li(fileLine(t.file), plural(t.tests, "test")), "compact");

    // Calls to endpoints that don't exist, and endpoints nothing calls.
    const mb = BROKEN.filter((b) => b.module === m.id), mu = UNCALLED.filter((u) => u.module === m.id);
    if (mb.length) { h += section("broken", "Calls to endpoints that don't exist", mb.length); h += '<div class="list compact">' + mb.map((b) => li(two('<span class="mono">' + esc(b.url) + "</span>", loc(b.file + ":" + b.line, base(b.file) + ":" + b.line)), '<span class="tag high">no such route</span>')).join("") + "</div>"; }
    if (mu.length) { h += section("uncalled", "Endpoints nothing in the repo calls", mu.length); h += '<div class="list compact">' + mu.map((u) => li('<span class="mono">' + esc(u.route) + "</span>", loc(u.handler, "handler", "plain"))).join("") + "</div>"; }

    // Copied code that touches this module.
    const ds = dupsOf(m);
    if (ds.length) { h += section("dups", "Copied code", ds.length); h += few("mdups", ds, 4, (b) => li(two(loc(b.a.file + ":" + b.a.start, base(b.a.file) + ":" + b.a.start) + '<span class="sep">=</span>' + loc(b.b.file + ":" + b.b.start, base(b.b.file) + ":" + b.b.start), ""), '<span class="tag">' + b.lines + " lines</span>"), "compact"); }

    // Connected modules.
    if (m.usedBy.length || m.uses.length) {
      h += section("connected", "Connected");
      h += '<div class="list compact">' +
        (m.usedBy.length ? li('<span class="muted">Used by</span> ' + m.usedBy.map((u) => modLink(u.module)).join(", "), '<span class="faint small hide-sm">re-check these after a change</span>') : "") +
        (m.uses.length ? li('<span class="muted">Uses</span> ' + m.uses.map((u) => modLink(u.module)).join(", ")) : "") + "</div>";
    }
    return h;
  }
  function issueDetail(f) {
    const ev = (f.evidence || []).filter((e) => LOC.test(e));
    return (f.why ? "<p>" + esc(f.why) + "</p>" : "") + '<p class="muted small" style="margin-top:6px">' + esc(f.text) + "</p>" +
      (f.fix ? '<div class="fix"><b>Fix.</b> ' + esc(f.fix) + "</div>" : "") +
      (ev.length ? '<p class="small">' + ev.slice(0, 4).map((e) => loc(e)).join('<span class="sep">·</span>') + "</p>" : "");
  }
  function routeRow(r, m) {
    const iss = issuesByRoute.get(r.id) || [];
    const untested = m && m.tests.untested.includes(r.id);
    const end = (iss.length ? dot(SEVC[iss[0].severity]) : "") + '<span class="tag hide-sm">' + (r.moves_money ? "moves money" : EFF[r.effect] || EFF.read) + "</span>" + (!m ? '<span class="faint small hide-sm">' + esc(r.module ? (MOD.get(r.module) || { name: "" }).name : "") + "</span>" : "");
    return liOpen('<div style="display:flex;gap:10px;align-items:baseline;min-width:0"><span class="method">' + esc(r.method) + '</span><span class="path">' + esc(r.path) + "</span></div>", end, routeDetail(r, iss, untested));
  }
  function routeDetail(r, iss, untested) {
    const own = r.access === "public" && r.effect === "read" ? null : OWN[r.scoped];
    const tables = r.tables || [];
    const byOp = (op) => tables.filter((t) => t.op === op).map((t) => '<span class="mono">' + esc(t.table) + "</span>").join(", ");
    let h = '<dl class="kv">' +
      "<dt>Does</dt><dd>" + [EFF[r.effect] || EFF.read, r.moves_money && "moves money", r.notifies && "sends a notification", r.external && "calls an outside service"].filter(Boolean).join(", ") + "</dd>" +
      "<dt>Who can call</dt><dd>" + esc(ACC[r.access] || r.access) + "</dd>" +
      (own ? "<dt>Whose data</dt><dd" + (r.scoped === "no" ? ' class="t-high"' : "") + ">" + own + "</dd>" : "") +
      (tables.length ? "<dt>Tables</dt><dd>" + [["delete", "deletes"], ["write", "writes"], ["read", "reads"]].map(([op, w]) => byOp(op) && w + " " + byOp(op)).filter(Boolean).join("; ") + "</dd>" : "") +
      (untested != null ? "<dt>Test</dt><dd>" + (untested ? '<span class="t-med">none calls or names it</span>' : "tested") + "</dd>" : "") +
      "<dt>Spec</dt><dd>" + (r.specs && r.specs.length ? r.specs.map(esc).join(", ") : '<span class="muted">none</span>') + "</dd>" +
      "<dt>Code</dt><dd>" + loc(r.handler) + "</dd>" +
      (r.evidence.length ? "<dt>Why</dt><dd>" + r.evidence.slice(0, 4).map((x) => esc(x.kind.replace(/_/g, " ")) + " at " + loc(x.at)).join("<br>") + (r.evidence.length > 4 ? '<br><span class="muted">and ' + (r.evidence.length - 4) + " more</span>" : "") + "</dd>" : "") +
      "</dl>";
    for (const f of iss) h += '<div class="fix"><b>' + esc(f.title) + ".</b> " + esc(f.why) + (f.fix ? " <span class=\"muted\">Fix: " + esc(f.fix) + "</span>" : "") + "</div>";
    return h;
  }

  // ---- Specs: a map of which modules have written rules, and the one picked below it ----
  function reqDetail(s, r, onlyCode) {
    let h = "";
    if (!onlyCode) {
      if (r.checks && r.checks.length) h += '<dl class="kv"><dt>What proves it</dt><dd>' + r.checks.map((v) => '<span class="mono faint">' + esc(v.id) + "</span> " + md(v.text)).join("<br>") + "</dd></dl>";
      h += '<dl class="kv"><dt>Checked by</dt><dd>' + (r.tests.length ? r.tests.map((t) => loc(t)).join("<br>") : '<span class="t-med">no test yet</span>') + "</dd></dl>";
      const acts = r.stale ? '<span class="t-med small">The code it cites changed since it was written.</span>' : "";
      if (acts) h += '<div class="actions" style="margin:0 0 12px;gap:16px">' + acts + "</div>";
    }
    h += r.cites.map((c) => '<div style="margin-top:10px">' + (c.resolves ? loc(c.file + ":" + c.start + (c.end !== c.start ? "-" + c.end : "")) : '<span class="mono t-high">' + esc(c.cite) + "</span> <span class=\"small t-high\">" + esc(c.problem) + "</span>") + (c.code != null ? codeBlock(c) : "") + "</div>").join("");
    return h;
  }
  const cssId = (s) => String(s).replace(/[^\w-]/g, "_");

  // ---- Overview: everything app-wide, for when one module isn't the question ----
  function oFindings() {
    const areas = ["all", ...new Set(F.map((f) => f.area))];
    const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((f) => state.sev.includes(f.severity) && (state.area === "all" || f.area === state.area) && match(g.title + " " + f.where + " " + f.text)) })).filter((g) => g.items.length);
    let h = '<div class="filters">' + ["high", "medium", "low"].map((s) => '<button class="filter" data-f="sev" data-v="' + s + '" aria-pressed="' + state.sev.includes(s) + '">' + s[0].toUpperCase() + s.slice(1) + '<span class="n">' + F.filter((f) => f.severity === s).length + "</span></button>").join("") +
      '<span style="width:12px"></span>' + areas.map((a) => '<button class="filter" data-f="area" data-v="' + esc(a) + '" aria-pressed="' + (state.area === a) + '">' + (a === "all" ? "All areas" : esc(a)) + "</button>").join("") + "</div>";
    if (!groups.length) return h + empty("No findings match these filters.");
    return h + few("findings", groups, 40, (g) => liOpen('<div style="display:flex;gap:12px;align-items:baseline">' + dot(SEVC[g.severity]) + '<div style="min-width:0">' + two(esc(g.title), esc(g.why)) + "</div></div>", plural(g.items.length, "place"), groupDetail(g), "grp-" + cssId(g.key)));
  }
  function groupDetail(g) {
    let h = g.fix ? '<div class="fix"><b>Fix.</b> ' + esc(g.fix) + "</div>" : "";
    h += '<div class="list compact">' + g.items.slice(0, 100).map((f) => li((LOC.test(f.where) ? loc(f.where) : '<span class="mono">' + esc(f.where) + "</span>") + '<div class="sub wrap">' + esc(f.text) + (f.module && MOD.get(f.module) ? '<span class="sep">·</span>' + modLink(f.module) : "") + "</div>")).join("") + "</div>" + (g.items.length > 100 ? '<p class="muted small">and ' + (g.items.length - 100) + " more</p>" : "");
    return h;
  }
  function oRoutes() {
    const has = (rt) => issuesByRoute.has(rt.id);
    const FL = { all: () => true, issues: has, write: (rt) => rt.effect !== "read", money: (rt) => rt.moves_money, public: (rt) => rt.access === "public" };
    const names = { all: "All", issues: "Has issues", write: "Changes data", money: "Moves money", public: "Anyone can call" };
    let h = '<div class="filters">' + Object.keys(FL).map((k) => '<button class="filter" data-f="rf" data-v="' + k + '" aria-pressed="' + (state.rf === k) + '">' + names[k] + '<span class="n">' + ROUTES.filter(FL[k]).length + "</span></button>").join("") + "</div>";
    const list = ROUTES.filter((rt) => FL[state.rf](rt) && match(rt.id + " " + rt.handler));
    if (!list.length) return h + empty("Nothing matches.");
    const untested = new Set(MODS.flatMap((m) => m.tests.untested));
    const WHO = { public: "Anyone", auth: "Signed in", role: "Admins" };
    const own = (r) => (r.access === "public" && r.effect === "read") || !r.scoped ? '<span class="faint">—</span>' : r.scoped === "yes" ? "checked" : r.scoped === "weak" ? '<span class="t-med">client values</span>' : '<span class="t-high">not checked</span>';
    return h + pagedTable("routes", list, [["Method", "70px"], "Path", ["Does", "120px"], ["Who can call", "104px"], ["Whose data", "112px"], ["Module", "130px"], ["Test", "56px"]], (r) => {
      const iss = issuesByRoute.get(r.id) || [];
      return [
        '<span class="method">' + esc(r.method) + "</span>",
        '<span class="path">' + esc(r.path) + "</span>" + (iss.length ? " " + dot(SEVC[iss[0].severity]) : ""),
        r.moves_money ? '<span class="t-high">moves money</span>' : esc(EFF[r.effect] || EFF.read),
        esc(WHO[r.access] || r.access),
        own(r),
        r.module ? esc(nameOf(r.module)) : '<span class="faint">—</span>',
        untested.has(r.id) ? '<span class="faint">none</span>' : '<span class="t-ok">' + ic("check", "sm") + "</span>",
      ];
    }, (r) => routeDetail(r, issuesByRoute.get(r.id) || [], untested.has(r.id)));
  }
  // A table with numbered pages; a row opens to its detail.
  function pagedTable(key, list, cols, cells, detail, size, rowCls) {
    const PAGE = size || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(list.length / PAGE)), p = Math.min(state.pages[key] || 0, pages - 1);
    const rows = list.slice(p * PAGE, (p + 1) * PAGE).map((x) => { const id = "d" + seq++; return '<tr class="trow ' + (rowCls ? rowCls(x) : "") + '" data-d="' + id + '">' + cells(x).map((c) => "<td>" + c + "</td>").join("") + '<td class="chevcell">' + ic("chev", "sm chev") + '</td></tr><tr class="tdetail" id="' + id + '" hidden><td colspan="' + (cols.length + 1) + '"><div class="detail">' + detail(x) + "</div></td></tr>"; }).join("");
    const shown = [...new Set([0, pages - 1, p - 1, p, p + 1].filter((i) => i >= 0 && i < pages))].sort((a, b) => a - b);
    let nums = "", prev = -1;
    for (const i of shown) { if (i - prev > 1) nums += '<span class="gap">…</span>'; nums += '<button data-page="' + key + '" data-p="' + i + '"' + (i === p ? ' aria-current="page"' : "") + ">" + (i + 1) + "</button>"; prev = i; }
    const pager = pages > 1 ? '<div class="pager"><span>' + (p * PAGE + 1) + "–" + Math.min(list.length, (p + 1) * PAGE) + " of " + list.length + '</span><span class="grow"></span><button data-page="' + key + '" data-p="' + (p - 1) + '"' + (p ? "" : " disabled") + ' aria-label="Previous page">←</button>' + nums + '<button data-page="' + key + '" data-p="' + (p + 1) + '"' + (p < pages - 1 ? "" : " disabled") + ' aria-label="Next page">→</button></div>' : "";
    // Columns are "Label" or ["Label", width]; fixed widths keep an opened row from widening the table.
    const head = cols.map((c) => (Array.isArray(c) ? '<th style="width:' + c[1] + '">' + c[0] + "</th>" : "<th>" + c + "</th>")).join("");
    return '<div class="tablewrap"><table class="plain dtable"><thead><tr>' + head + '<th style="width:28px"></th></tr></thead><tbody>' + rows + "</tbody></table></div>" + pager;
  }
  // Every module side by side: one row each, a dot and a number per indicator, riskiest first.
  function oModules() {
    if (!MODS.length) return empty("No modules found.");
    const cell = (i) => '<td><span class="mcell">' + dot(IND[i.s][0]) + '<span class="mv">' + esc(i.big != null ? i.big : i.p + "%") + '</span><span class="faint hide-sm">' + esc(i.v) + "</span></span></td>";
    const rows = MODS.filter((m) => match(m.name)).map((m) => {
      const [sf, ts, rl, sr] = indicators(m);
      return '<tr class="mrow" data-mod="' + esc(m.id) + '"><td><div class="title" style="font-weight:550">' + esc(m.name) + '</div><div class="faint small">' + plural(m.stats.routes, "route") + "</div></td>" + cell(sf) + cell(ts) + cell(rl) + (sr ? cell(sr) : "<td></td>") + "</tr>";
    }).join("");
    return '<div class="tablewrap"><table class="plain mtable"><thead><tr><th>Module</th><th>' + ic("shield", "sm") + ' Safety</th><th>' + ic("flask", "sm") + ' Tests</th><th>' + ic("doc", "sm") + ' Rules</th><th>' + ic("blocks", "sm") + " Structure</th></tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<div class="legend">' + dot("ok") + "good" + dot("med") + "needs work" + dot("high") + "at risk</div>" +
      // A spec no module claims (its module was renamed or split): say so, with the file.
      ((() => { const lost = SPECS.filter((sp) => !specOwner(sp)); return lost.length ? section("lost", "Specs not tied to a module", lost.length) + '<div class="list compact">' + lost.map((sp) => li(two(esc(specTitle(sp)), loc(sp.path + ":1", sp.path)), '<span class="tag">' + plural(specReqs(sp).length, "rule") + "</span>")).join("") + "</div>" : ""; })());
  }
  // Structure: modules that reach into each other's data or depend on each other, and copied code.
  function oStructure() {
    let h = indRow(indicators(null).filter((i) => i.k === "Modularity" || i.k === "Duplication"));
    const ps = MODU.problems.filter((p) => p.kind !== "hub");
    h += section("mod", "Between modules", ps.length || null);
    h += ps.length ? few("modp", ps, 8, (p) => p.kind === "shared-writes"
      ? liOpen(two('<span class="mono">' + esc(p.table) + "</span> is written outside " + esc(p.names[0]), "by " + esc(p.names.slice(1).join(", "))), "", '<dl class="kv"><dt>Owner</dt><dd>' + modLink(p.owner) + "</dd>" + Object.entries(p.at).map(([o, locs]) => "<dt>Written by " + esc(nameOf(o)) + "</dt><dd>" + locs.map((l) => loc(l)).join("<br>") + "</dd>").join("") + "</dl>")
      : liOpen(two(esc(p.names.join(" and ")) + " depend on each other", "A change to either can break the other"), "", '<dl class="kv">' + Object.entries(p.via).map(([o, files]) => "<dt>" + esc(nameOf(o)) + " uses the other through</dt><dd>" + files.map((f) => loc(f + ":1")).join("<br>") + "</dd>").join("") + "</dl>")) : empty("Every module keeps to its own tables, and none depend on each other in a loop.");
    const hubs = MODU.problems.filter((p) => p.kind === "hub");
    if (hubs.length) h += '<p class="muted small" style="margin-top:10px">Most of the app depends on ' + hubs.map((p) => modLink(p.modules[0])).join(", ") + ": a change there reaches far.</p>";
    h += section("broken", "Calls to endpoints that don't exist", BROKEN.length || null);
    h += BROKEN.length ? few("broken", BROKEN, 8, (b) => li(two('<span class="mono">' + esc(b.url) + "</span>", loc(b.file + ":" + b.line, base(b.file) + ":" + b.line) + (b.module ? '<span class="sep">·</span>' + esc(nameOf(b.module)) : "")), '<span class="tag high">no such route</span>')) : empty("Every API call in the UI matches a route.");
    h += section("uncalled", "Endpoints nothing in the repo calls", UNCALLED.length || null);
    h += UNCALLED.length ? few("uncalled", UNCALLED, 8, (u) => li(two('<span class="mono">' + esc(u.route) + "</span>", loc(u.handler, base(u.handler.split(":")[0])) + (u.module ? '<span class="sep">·</span>' + esc(nameOf(u.module)) : "")), '<span class="tag">no screen or test</span>')) + '<p class="faint small" style="margin-top:8px">Something outside the repo (a mobile app, an email link) may still call them; if nothing does, they are code to maintain and secure for no one.</p>' : empty("Every endpoint is called by a screen or a test, or is a webhook or callback.");
    h += section("dup", "Copied code", DUP.blocks.length || null);
    h += DUP.blocks.length ? few("dups", DUP.blocks.filter((b) => match(b.a.file + b.b.file)), 10, (b) => li(two(loc(b.a.file + ":" + b.a.start, base(b.a.file) + ":" + b.a.start) + '<span class="sep">=</span>' + loc(b.b.file + ":" + b.b.start, base(b.b.file) + ":" + b.b.start), (b.a.module ? esc(nameOf(b.a.module)) : "shared") + (b.a.module !== b.b.module ? " and " + (b.b.module ? esc(nameOf(b.b.module)) : "shared") : "") + (b.copies > 2 ? '<span class="sep">·</span>' + b.copies + " copies" : "")), '<span class="tag">' + b.lines + " lines</span>")) : empty("No copied blocks found.");
    return h;
  }
  function oTests() {
    if (!T) return empty("No tests found. Veridic looks for *.test.* and *.spec.* files.");
    const nothing = T.unasserted + T.empty;
    const fact = (v, k) => '<div class="fact"><div class="v">' + v.toLocaleString() + '</div><div class="k">' + k + "</div></div>";
    let h = '<div class="facts">' + fact(T.tests, "tests") + fact(T.strong, "check real values") + fact(T.weak, "only loose checks") + fact(nothing, "check nothing") + fact(T.skipped, "skipped") + "</div>";
    const fl = D.tests.flagged || {};
    const rows = [...(fl.empty || []).map((t) => ({ ...t, k: "empty", c: "high" })), ...(fl.unasserted || []).map((t) => ({ ...t, k: "checks nothing", c: "high" })), ...(fl.weak || []).map((t) => ({ ...t, k: "loose checks", c: "" }))].filter((t) => match(t.at + " " + t.title));
    if (rows.length) {
      h += section("fixtests", "Tests to fix", rows.length);
      h += few("tests", rows, 20, (t) => li(two(esc(t.title), loc(t.at)), '<span class="tag ' + t.c + '">' + t.k + "</span>"));
    }
    return h;
  }

  const VIEWS = { modules: vModules, module: vModule };

  // Open a rule on its module's page: turn its table to the right page, open the row, show it.
  function showReq(key, id) {
    if (key && RULES[key]) state.pages[key] = Math.floor(RULES[key].findIndex((x) => x.id === id) / 10);
    render(true);
    const r = $("#main .req-" + cssId(id));
    if (r) { if (!r.classList.contains("open")) toggle(r); r.scrollIntoView({ block: "center", behavior: "smooth" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 1400); }
  }

  // ---- shell and rendering ----
  const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };
  function shell() {
    $("#app").innerHTML = '<div class="shell"><button class="iconbtn menu-btn" id="menu" aria-label="Menu">' + ic("menu") + '</button><aside class="side"><div class="brand"><span class="mark">' + ic("logo") + '</span><span>Veridic</span><span class="repo">' + esc(D.name) + "</span></div>" +
      '<nav class="nav" id="nav"></nav>' +
      '<div class="sidefoot"><span class="grow" title="' + esc(new Date(D.generated).toLocaleString()) + '">' + esc(ago(D.generated)) + '</span><select class="pick" id="editor" title="Where file links open"><option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="none">No links</option></select>' +
      '<button class="iconbtn" id="theme" aria-label="Toggle light or dark"></button></div></aside>' +
      '<div class="content"><main class="page" id="main"></main></div></div>';
    $("#editor").value = ED;
  }
  // The sidebar: Home, then Modules with every module nested under it (collapsible), then the rest.
  let modsOpen = store.get("mods-open") !== "0";
  function nav() {
    const cur = state.view;
    // Every row: an icon, the label, then one fixed slot on the right (a dot, or the chevron).
    const slot = (x) => '<span class="slot">' + (x || "") + "</span>";
    const item = (n) => '<button class="item" data-nav="' + n.k + '"' + (n.k === cur ? ' aria-current="page"' : "") + ">" + ic(n.i, "sm") + '<span class="grow">' + n.t + "</span>" + slot(n.dot ? dot(n.dot) : "") + "</button>";
    const group = MODS.length
      ? '<button class="item group" data-modtoggle aria-expanded="' + modsOpen + '">' + ic("blocks", "sm") + '<span class="grow">Modules</span><span class="meta">' + MODS.length + "</span>" + slot(ic("chev", "sm chev")) + "</button>" +
        (modsOpen ? '<div class="sublist">' + MODS.map((m) => '<button class="item sub' + (cur === "module" && state.mod === m.id ? " on" : "") + '" data-mod="' + esc(m.id) + '"><span class="grow">' + esc(m.name) + "</span>" + slot(sideDot(m) ? dot(sideDot(m)) : "") + "</button>").join("") + "</div>" : "")
      : "";
    $("#nav").innerHTML = item(NAV[0]) + group + NAV.slice(1).map(item).join("");
  }
  function render(keepScroll) {
    seq = 0;
    const main = $("#main");
    main.className = "page fade wide";
    main.innerHTML = VIEWS[state.view]();
    void main.offsetWidth;
    requestAnimationFrame(() => { $$("#main [data-w]").forEach((el) => (el.style.width = el.dataset.w + "%")); $$("#main [data-dash]").forEach((el) => el.setAttribute("stroke-dasharray", el.dataset.dash)); });
    if (state.openGroup) {
      const r = $("#main .grp-" + cssId(state.openGroup));
      if (r) { toggle(r); r.scrollIntoView({ block: "center" }); }
      state.openGroup = null;
    } else if (state.jump) {
      const el = document.getElementById("sec-" + state.jump);
      state.jump = null;
      if (el) el.scrollIntoView({ block: "start" });
    } else if (!keepScroll) window.scrollTo(0, 0);
  }
  function setView(k) {
    if (!VIEWS[k]) return;
    state.view = k;

    state.pages = {};
    state.open = new Set();
    $(".shell").classList.remove("menu");
    try { history.pushState(null, "", "#" + (k === "module" ? "module/" + encodeURIComponent(state.mod) : k)); } catch {}
    nav();
    render();
  }
  const openModule = (id, jump) => { state.mod = id; state.jump = jump || null; setView("module"); };
  window.addEventListener("popstate", () => { Object.assign(state, { view: "modules", mod: null, jump: null }, fromHash()); state.pages = {}; state.open = new Set(); nav(); render(); });
  function toggle(row) {
    const d = document.getElementById(row.dataset.d);
    if (!d) return;
    d.hidden = !d.hidden;
    row.classList.toggle("open", !d.hidden);
  }
  // Theme: the system's by default; the toggle pins light or dark.
  const effective = () => { const t = store.get("theme"); return t === "light" || t === "dark" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; };
  function applyTheme() {
    const t = store.get("theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    $("#theme").innerHTML = ic(effective() === "dark" ? "sun" : "moon", "sm");
    $("#theme").title = effective() === "dark" ? "Light mode" : "Dark mode";
  }
  const toastEl = $("#toast");
  function toast(msg) { toastEl.innerHTML = ic("check", "sm") + esc(msg); toastEl.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove("on"), 1800); }

  shell();
  applyTheme();
  nav();
  render();

  document.addEventListener("click", (e) => {
    const t = e.target;
    const md0 = t.closest("[data-mod]");
    if (md0) { openModule(md0.dataset.mod, md0.dataset.to); return; }
    if (t.closest("[data-about]")) { state.aboutOpen = !state.aboutOpen; render(true); return; }
    const op = t.closest("[data-open]");
    if (op) { state.open.add(op.dataset.open); render(true); return; }
    const rq = t.closest("[data-req]");
    if (rq) { const id = rq.dataset.req; showReq(Object.keys(RULES).find((k) => RULES[k].some((x) => x.id === id)), id); return; }
    const pg = t.closest("[data-page]");
    if (pg) { if (pg.disabled) return; state.pages[pg.dataset.page] = +pg.dataset.p; render(true); return; }
    const sb = t.closest("[data-sub]");
    if (sb) { state.sub = sb.dataset.sub; state.sev = ["high", "medium"]; setView("modules"); setTimeout(() => { const el = document.getElementById("sec-tabs"); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); }, 0); return; }
    const n = t.closest("[data-nav]");
    if (n) { setView(n.dataset.nav); return; }
    const f = t.closest("[data-f]");
    if (f) {
      const name = f.dataset.f, v = f.dataset.v;
      if (name === "sev") state.sev = state.sev.includes(v) ? state.sev.filter((x) => x !== v) : [...state.sev, v];
      else state[name] = v;
      state.pages = {};
      render(true);
      return;
    }
    const g = t.closest("[data-group]");
    if (g) { state.openGroup = g.dataset.group; state.sev = ["high", "medium", "low"]; state.area = "all"; state.sub = "findings"; state.open.add("findings"); if (state.view !== "modules") setView("modules"); else render(true); return; }
    if (t.closest("[data-modtoggle]")) { modsOpen = !modsOpen; store.set("mods-open", modsOpen ? "1" : "0"); nav(); return; }
    if (t.closest("#menu")) { $(".shell").classList.toggle("menu"); return; }
    if (t.closest("a, button, select, input, label, pre, textarea, summary")) return;
    const row = t.closest(".li[data-d], tr[data-d], .stepc[data-d]");
    if (row) toggle(row);
  });
  $("#editor").addEventListener("change", (e) => { ED = e.target.value; store.set("editor", ED); render(true); });
  $("#theme").addEventListener("click", () => { store.set("theme", effective() === "dark" ? "light" : "dark"); applyTheme(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "t") $("#theme").click();
  });
})();
