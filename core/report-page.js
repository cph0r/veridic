// Veridic report page. Reads the JSON embedded in the page and renders it; no
// network, no dependencies. Quiet by design: each view shows the few things that
// matter, and the rest opens on a click. Views: Modules (home), a module's page,
// Specs, Overview (everything app-wide), Current task. Buttons copy prompts or
// open the editor: a static page never runs anything itself.
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
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
  };
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
  const CLIP = [];
  const clip = (text) => CLIP.push(text) - 1;
  const btn = (label, text, cls) => '<button class="btn ' + (cls || "") + '" data-copy="' + clip(text) + '">' + esc(label) + "</button>";
  const textBtn = (label, text, cls) => '<button class="text-btn ' + (cls || "") + '" data-copy="' + clip(text) + '">' + esc(label) + "</button>";
  const fileLine = (f) => { const i = f.lastIndexOf("/"); return '<div class="fname">' + loc(f + ":1", f.slice(i + 1)) + '</div><div class="fdir">' + esc(f.slice(0, i + 1)) + "</div>"; };
  const modLink = (id) => { const m = MOD.get(id); return m ? '<button class="link" data-mod="' + esc(id) + '">' + esc(m.name) + "</button>" : esc(id); };
  const q = () => (state.q || "").toLowerCase();
  const match = (text) => !q() || String(text).toLowerCase().includes(q());

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

  // ---- prompts handed to the agent ----
  const TAIL = "Before editing, run `veridic claim` with the route(s) or file(s) you will change. Make the smallest change that fixes it, add or fix a test that asserts the behavior, then run `veridic done` and keep going until it says DONE.";
  const promptFor = (f) => f.area === "Tests"
    ? "Fix this test in " + D.name + ": " + f.where + ' ("' + f.text + '"). ' + (f.why || "") + "\nSuggested fix: " + (f.fix || "") + "\nRead the code it exercises, assert what the title promises, and make sure the test would fail if that behavior broke. Run the test, then `veridic done`."
    : "Fix this Veridic finding in " + D.name + ":\n\n" + f.severity.toUpperCase() + ": " + (f.title || f.kind) + " at " + f.where + "\n" + f.text + ((f.evidence || []).length ? "\nEvidence: " + f.evidence.join(", ") : "") + (f.fix ? "\nSuggested fix: " + f.fix : "") + "\n\nFirst confirm it is real by reading the evidence lines; if it is not, say why and stop. " + TAIL;
  const promptAll = (list) => "Fix these " + list.length + " Veridic findings in " + D.name + ", one at a time, most severe first. For each: confirm it is real by reading the evidence (skip it and say why if not), then fix it.\n\n" + list.map((f, i) => (i + 1) + ". " + f.severity.toUpperCase() + ": " + (f.title || f.kind) + " at " + f.where + ": " + f.text + ((f.evidence || []).length ? " (evidence: " + f.evidence.join(", ") + ")" : "") + (f.fix ? "\n   Suggested fix: " + f.fix : "")).join("\n") + "\n\n" + TAIL;
  const citesOf = (r) => r.cites.map((c) => c.cite).join(", ");
  const promptTest = (s, r) => "In " + D.name + ", requirement " + r.id + " of " + s.path + " has no test that checks it:\n\n" + r.id + ": " + r.text + "\n\nIts code: " + citesOf(r) + "\n\nWrite a test with " + r.id + " in its title that asserts exactly this behavior and would fail if it broke. Run it, then `veridic tests` to confirm " + r.id + " shows as tested.";
  const promptStale = (s, r) => "In " + D.name + ", the code behind requirement " + r.id + " of " + s.path + " changed since the spec was written:\n\n" + r.id + ": " + r.text + "\n\nCited: " + citesOf(r) + "\n\nRun `veridic stale` to see what changed. If only lines moved, run `veridic stale --fix`. If the behavior changed, decide whether the code or the requirement is right, update the other, then run `veridic check`.";
  const promptSpec = (s) => {
    const gaps = specReqs(s).filter((r) => !tested(r) || r.stale);
    return gaps.length
      ? "Close the gaps in " + s.path + " (" + D.name + "):\n\n" + gaps.map((r) => "- " + r.id + ": " + (r.stale ? "its code changed (" + citesOf(r) + "); re-check it. " : "") + (!tested(r) ? "needs a test named with " + r.id + ". " : "") + r.text).join("\n") + "\n\nFor stale ones run `veridic stale` (and `--fix` if lines only moved). Write each missing test with the requirement id in its title. Finish with `veridic check` and `veridic tests`."
      : "Every requirement in " + s.path + " is tested and matches the code. Run `veridic metrics --card` to confirm.";
  };
  const modRoutes = (m) => ROUTES.filter((r) => r.module === m.id);
  const modFindings = (m) => F.filter((f) => f.module === m.id);
  const screensOf = (m) => (m.screens || []).map((x) => x.file);
  const filesOf = (m) => [...m.files, ...m.code.filter((f) => !m.files.includes(f)), ...screensOf(m)];
  const promptModuleSpec = (m) => "Use veridic to write a spec for the " + m.name + " module of " + D.name + ". It does: " + m.does.join(", ") + ".\nIts routes:\n" + modRoutes(m).map((r) => "- " + r.id + " (" + (EFF[r.effect] || EFF.read) + (r.moves_money ? ", moves money" : "") + ") " + r.handler).join("\n") + "\nIts code: " + filesOf(m).join(", ") +
    ((m.data && m.data.owns.length) ? "\nThe tables it owns: " + m.data.owns.map((t) => t.table).join(", ") + "." : "") +
    "\n\nStart with the riskiest behavior (money, deletes, writes). Write user stories with Given/When/Then scenarios, requirements backed by [evidence: file:line] citations to the code that does them, and the invariants that must always hold. Save it as specs/" + m.id + "/spec.md, then run `veridic check` and `veridic tests`.";
  const promptModuleTests = (m) => { const ids = m.tests.untested; return "In " + D.name + ", these routes of the " + m.name + " module have no test that calls them or names them:\n" + ids.map((x) => "- " + x).join("\n") + "\n\nRun `veridic claim " + ids.slice(0, 8).map((x) => JSON.stringify(x)).join(" ") + "` first. Then, starting with the routes that move money or change data, write tests that call each route and assert its real effect (status, body, and what changed in the data). Make each test fail if the behavior broke. Run them, then `veridic done`."; };
  const claimOf = (m) => "veridic claim " + [...m.routes, ...screensOf(m)].map((x) => JSON.stringify(x)).join(" ");
  const promptTask = (m) => "I'm going to work on the " + m.name + " module of " + D.name + " (it does: " + m.does.join(", ") + ").\n\nFirst run `" + claimOf(m) + "` so stray edits outside it (backend or UI) get caught. Read its code before changing anything: " + filesOf(m).join(", ") + ".\n" +
    ((m.data && m.data.owns.length) ? "It owns these tables: " + m.data.owns.map((t) => t.table + (t.alsoWrittenBy.length ? " (also changed by " + t.alsoWrittenBy.map((x) => (MOD.get(x) || { name: x }).name).join(", ") + ")" : "")).join(", ") + ". Tables it only reads belong to other modules: change them there.\n" : "") +
    (m.usedBy.length ? "Other modules depend on it, so re-check them after the change: " + m.usedBy.map((u) => (MOD.get(u.module) || { name: u.module }).name + " (through " + u.via.join(", ") + ")").join("; ") + ".\n" : "") +
    "When the change is done, run `veridic done` and keep going until it says DONE.\n\nThe task: <describe what you want to change here>";

  // ---- state ----
  const NAV = [
    { k: "modules", t: "Modules" },
    { k: "spec", t: "Specs" },
    ...(D.change ? [{ k: "change", t: "Current task", dot: D.change.done ? "ok" : "high" }] : []),
    { k: "overview", t: "Overview" },
  ];
  const fromHash = () => { const h = location.hash.slice(1).split("/"); return h[0] === "module" && h[1] ? { view: "module", mod: decodeURIComponent(h[1]), jump: h[2] } : NAV.some((n) => n.k === h[0]) ? { view: h[0] } : { view: "modules" }; };
  const state = { ...fromHash(), sub: "summary", q: "", sev: ["high", "medium"], area: "all", rf: "all", spec: 0, sf: "all", aboutOpen: false, openGroup: null, pages: {}, open: new Set() };

  // A module's one status: its worst open issue, else "no tests" when it changes data untested. Most have none.
  const statusOf = (m) => {
    const s = m.stats;
    if (s.high) return { c: "high", t: plural(s.high + s.medium, "issue") };
    if (s.medium) return { c: "med", t: plural(s.medium, "issue") };
    if (s.writes + s.destructive && m.tests.untested.length === s.routes) return { c: "", t: "no tests" };
    return null;
  };

  // ---- Modules (home): what the app is, what needs attention, its parts ----
  function vModules() {
    const A = D.app;
    let h = "<h1>" + esc((A && A.title) || D.name) + "</h1>";
    if (A) h += '<div class="about' + (state.aboutOpen ? "" : " clamp") + '">' + mdBlock(A.about) + "</div>" + (A.about.length > 180 ? '<button class="text-btn" data-about style="margin-top:6px">' + (state.aboutOpen ? "Less" : "More") + "</button>" : "");
    else h += '<p class="lead">No README describes this app yet.</p>';

    // Needs attention: the few most serious things, one per kind and module.
    const seen = new Set();
    const ranked = F.filter((f) => f.severity !== "low").sort((a, b) => rank(a.severity) - rank(b.severity));
    // One per module first, so three items show three places, then the rest.
    const top = [...ranked.filter((f) => { const k = f.module || f.where; return !seen.has(k) && seen.add(k); }), ...ranked];
    if (top.length) {
      const total = F.filter((f) => f.severity !== "low").length;
      h += section("attention", "Needs attention", null, total > 3 ? '<button class="text-btn" data-sub="findings">All ' + total + "</button>" : "");
      h += '<div class="list">' + top.slice(0, 3).map((f) => li(
        '<div style="display:flex;gap:12px;align-items:baseline">' + dot(SEVC[f.severity]) + "<div style=\"min-width:0\">" + two(esc(f.title || f.kind), (f.module && MOD.get(f.module) ? esc(MOD.get(f.module).name) + '<span class="sep">·</span>' : "") + '<span class="mono">' + esc(f.where) + "</span>") + "</div></div>",
        '<span class="hover-only">' + textBtn("Copy fix prompt", promptFor(f)) + "</span>" + (f.module ? '<button class="text-btn" data-mod="' + esc(f.module) + '" data-to="issues">Open</button>' : ""),
      )).join("") + "</div>";
    }

    h += section("modules", "Modules", MODS.length);
    if (!MODS.length) return h + empty("Veridic finds modules from the app's routes. Run <code>veridic init</code> in the repo so it can index the code.");
    const list = MODS.filter((m) => match(m.name + " " + m.does.join(" ") + " " + filesOf(m).join(" ")));
    h += few("modules", list, 40, (m) => { const st = statusOf(m); return liBtn(two(esc(m.name), esc(m.does.slice(0, 3).join(", "))), st ? '<span class="tag ' + st.c + '">' + st.t + "</span>" : "", ' data-mod="' + esc(m.id) + '"'); }) || empty("Nothing matches.");
    const screens = MODS.reduce((n, m) => n + (m.screens || []).length, 0);
    h += '<p class="faint small" style="margin-top:20px">' + [plural(ROUTES.length, "route"), D.data ? plural(D.data.tables, "table") : "", screens ? plural(screens, "screen") : "", plural(SPECS.length, "spec")].filter(Boolean).join('<span class="sep">·</span>') + "</p>";
    return h;
  }

  // ---- A module: everything needed to work on it without learning the rest ----
  function vModule() {
    const m = MOD.get(state.mod);
    if (!m) { state.view = "modules"; return vModules(); }
    const s = m.stats, rs = modRoutes(m), fs = modFindings(m).filter((f) => f.severity !== "low");
    let h = '<button class="back" data-nav="modules">' + ic("back", "sm") + "Modules</button>";
    h += "<h1>" + esc(m.name) + "</h1>";
    if (m.does.length) h += '<p class="lead">Lets callers ' + m.does.slice(0, 5).map(esc).join(", ") + (m.does.length > 5 ? ", and more" : "") + ".</p>";
    h += '<div class="actions">' + btn("Start a task", promptTask(m), "primary") + btn("Copy claim", claimOf(m), "quiet") + (!m.specified ? btn("Draft a spec", promptModuleSpec(m), "quiet") : "") + "</div>";

    // Issues: only when there are some.
    if (fs.length) {
      h += section("issues", "Issues", fs.length, fs.length > 1 ? textBtn("Copy prompt to fix all", promptAll(fs)) : "");
      h += few("issues", fs.sort((a, b) => rank(a.severity) - rank(b.severity)), 3, (f) => liOpen(
        '<div style="display:flex;gap:12px;align-items:baseline">' + dot(SEVC[f.severity]) + '<div style="min-width:0">' + two(esc(f.title || f.kind), '<span class="mono">' + esc(f.where) + "</span>") + "</div></div>", "", issueDetail(f)));
    }

    // Rules: the spec, or the lack of one.
    const specs = SPECS.map((sp, i) => [sp, i]).filter(([sp]) => m.specs.includes(sp.path));
    if (specs.length) {
      const mine = new Set(filesOf(m));
      for (const [sp, si] of specs) {
        const reqs = specReqs(sp).filter((r) => r.cites.some((c) => mine.has(c.file)));
        const shown = reqs.length ? reqs : specReqs(sp);
        h += section("rules", "Rules", shown.length, '<button class="text-btn" data-spec="' + si + '">' + esc(specTitle(sp)) + " →</button>");
        h += few("rules-" + si, shown, 6, (r) => { const st = REQ[r.status] || REQ.none; const c = r.stale ? "med" : st[1]; return li('<div class="req" style="display:flex;gap:12px;align-items:baseline"><span class="id">' + esc(r.id) + '</span><span>' + md(r.text) + "</span></div>", '<span class="tag ' + (c === "ok" ? "" : c) + '">' + (r.stale ? "code changed" : st[0].toLowerCase()) + "</span>"); }, "compact");
        if (m.specified < s.routes) h += '<p class="small muted" style="margin-top:8px">' + plural(s.routes - m.specified, "route") + " not covered yet. " + textBtn("Draft the rest", promptModuleSpec(m), "accent") + "</p>";
      }
    } else {
      h += section("rules", "Rules");
      h += empty("No spec yet. Nothing written says what these routes must do, so nothing can tell a bug from an intended change." + (s.money ? " It moves money, so it's a good one to start with." : ""), btn("Draft a spec", promptModuleSpec(m)));
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
    h += '<div class="li" style="border-top:1px solid var(--line)"><div class="main"><div>' + (nT === s.routes ? "Every route has a test." : nT + " of " + plural(s.routes, "route") + " have a test.") + '</div><div class="meter"><span data-w="' + pct(nT, s.routes) + '"></span></div></div><div class="end">' + (m.tests.untested.length ? textBtn("Write the missing tests", promptModuleTests(m), "accent") : "") + "</div></div>";
    if (m.tests.files.length) h += few("testfiles", m.tests.files, 3, (t) => li(fileLine(t.file), plural(t.tests, "test")), "compact");

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
      (ev.length ? '<p class="small">' + ev.slice(0, 4).map((e) => loc(e)).join('<span class="sep">·</span>') + "</p>" : "") +
      '<div class="actions" style="margin-top:12px">' + btn("Copy fix prompt", promptFor(f), "primary") + "</div>";
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
    for (const f of iss) h += '<div class="fix"><b>' + esc(f.title) + ".</b> " + esc(f.why) + (f.fix ? " <span class=\"muted\">Fix: " + esc(f.fix) + "</span>" : "") + '<div style="margin-top:6px">' + textBtn("Copy fix prompt", promptFor(f), "accent") + "</div></div>";
    return h;
  }

  // ---- Specs ----
  function vSpec() {
    const sel = SPECS[state.spec] ? state.spec : 0;
    const without = MODS.filter((m) => !m.specified);
    let h = "<h1>Specs</h1><p class=\"lead\">The rules the code must follow, each tied to the lines that do it and the tests that check it.</p>";
    h += '<div class="split"><nav class="toc">' + (SPECS.length ? '<div class="label">Specs</div>' + SPECS.map((s, i) => '<button class="item' + (i === sel ? " on" : "") + '" data-spec="' + i + '"><span class="grow">' + esc(specTitle(s)) + "</span></button>").join("") : "") +
      (without.length ? '<div class="label">No spec yet</div>' + without.slice(0, 12).map((m) => '<button class="item" data-mod="' + esc(m.id) + '"><span class="grow muted">' + esc(m.name) + "</span></button>").join("") + (without.length > 12 ? '<div class="label">and ' + (without.length - 12) + " more</div>" : "") : "") +
      '</nav><section style="min-width:0">' + (SPECS.length ? specPane(SPECS[sel], sel) : empty("No spec yet. Open a module and use <b>Draft a spec</b>; it copies a prompt that writes one from the code.")) + "</section></div>";
    return h;
  }
  function specPane(s, si) {
    const rs = specReqs(s), other = s.requirements.filter((r) => !r.requirement), doc = s.doc || { meta: {}, stories: [], tables: [], notes: [] };
    const nT = rs.filter(tested).length, nStale = rs.filter((r) => r.stale).length;
    let h = '<p class="faint small mono">' + esc(s.path) + '</p><h2 style="font-size:20px;margin:4px 0 6px">' + esc(specTitle(s)) + "</h2>" + (doc.meta.status ? '<p class="muted small">' + md(doc.meta.status) + "</p>" : "");
    h += '<div class="facts" style="margin-top:18px"><div class="fact"><div class="v">' + rs.length + '</div><div class="k">rules</div></div><div class="fact"><div class="v">' + pct(nT, rs.length) + '%</div><div class="k">have a test</div></div><div class="fact"><div class="v">' + pct(rs.length - nStale, rs.length) + '%</div><div class="k">match the code</div></div></div>';
    if (nT < rs.length || nStale) h += '<div class="actions">' + btn("Copy prompt to close the gaps", promptSpec(s), "primary") + "</div>";
    if (doc.stories.length) {
      h += section("stories", "What should happen", doc.stories.length);
      h += '<div class="list">' + doc.stories.map((st) => '<div class="story"><div class="title" style="font-weight:500">' + md(st.title) + "</div>" + (st.why ? '<div class="muted small">' + md(st.why) + "</div>" : "") +
        st.scenarios.slice(0, state.open.has("sc" + st.title) ? 99 : 1).map((sc) => '<dl class="gwt"><dt>Given</dt><dd>' + md(sc.given) + "</dd><dt>When</dt><dd>" + md(sc.when) + "</dd><dt>Then</dt><dd>" + md(sc.then) + (sc.refs.length ? ' <span class="faint">' + sc.refs.map((r) => '<button class="link mono" data-req="' + esc(r) + '">' + esc(r) + "</button>").join(" ") + "</span>" : "") + "</dd></dl>").join("") +
        (st.scenarios.length > 1 && !state.open.has("sc" + st.title) ? '<button class="text-btn" data-open="sc' + esc(st.title) + '" style="margin-top:6px">' + plural(st.scenarios.length - 1, "more scenario") + "</button>" : "") + "</div>").join("") + "</div>";
    }
    h += section("reqs", "Rules", rs.length);
    h += '<div class="filters">' + [["all", "All", rs.length], ["untested", "Need a test", rs.length - nT], ["stale", "Code changed", nStale]].map(([k, t, n]) => '<button class="filter" data-f="sf" data-v="' + k + '" aria-pressed="' + (state.sf === k) + '">' + t + '<span class="n">' + n + "</span></button>").join("") + "</div>";
    const list = rs.filter((r) => match(r.id + " " + r.text) && (state.sf === "all" || (state.sf === "untested" ? !tested(r) : r.stale)));
    h += few("reqs" + si, list, 30, (r) => { const st = REQ[r.status] || REQ.none; const c = r.stale ? "med" : st[1]; return liOpen('<div style="display:flex;gap:12px;align-items:baseline"><span class="req"><span class="id">' + esc(r.id) + "</span></span><span>" + md(r.text) + "</span></div>", '<span class="tag ' + (c === "ok" ? "" : c) + ' hide-sm">' + (r.stale ? "code changed" : st[0].toLowerCase()) + "</span>", reqDetail(s, r), "req-" + cssId(r.id)); }) || empty("Nothing matches.");
    for (const t of doc.tables) {
      const note = doc.notes.find((x) => x.section === t.section);
      h += section("t" + cssId(t.heading), md(t.heading)) + (note ? '<p class="muted small">' + md(note.text) + "</p>" : "") + '<div class="tablewrap"><table class="plain"><thead><tr>' + t.header.map((c) => "<th>" + md(c) + "</th>").join("") + "</tr></thead><tbody>" + t.rows.map((r) => "<tr>" + r.map((c) => "<td>" + md(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div>";
    }
    for (const x of doc.notes.filter((x) => !doc.tables.some((t) => t.section === x.section))) h += section("n" + cssId(x.section), md(x.section)) + '<p class="muted">' + md(x.text) + "</p>";
    if (other.length) h += section("other", "Other evidence", other.length) + few("other" + si, other.filter((r) => match(r.id + r.text)), 4, (r) => liOpen(md(r.id), r.stale ? '<span class="tag med">code changed</span>' : "", reqDetail(s, r, true)));
    return h;
  }
  function reqDetail(s, r, onlyCode) {
    let h = "";
    if (!onlyCode) {
      if (r.checks && r.checks.length) h += '<dl class="kv"><dt>What proves it</dt><dd>' + r.checks.map((v) => '<span class="mono faint">' + esc(v.id) + "</span> " + md(v.text)).join("<br>") + "</dd></dl>";
      h += '<dl class="kv"><dt>Checked by</dt><dd>' + (r.tests.length ? r.tests.map((t) => loc(t)).join("<br>") : '<span class="t-med">no test yet</span>') + "</dd></dl>";
      const acts = (!tested(r) ? textBtn("Copy prompt to write the test", promptTest(s, r), "accent") : "") + (r.stale ? textBtn("Copy prompt to re-check it", promptStale(s, r), "accent") : "");
      if (acts) h += '<div class="actions" style="margin:0 0 12px;gap:16px">' + acts + "</div>";
    }
    h += r.cites.map((c) => '<div style="margin-top:10px">' + (c.resolves ? loc(c.file + ":" + c.start + (c.end !== c.start ? "-" + c.end : "")) : '<span class="mono t-high">' + esc(c.cite) + "</span> <span class=\"small t-high\">" + esc(c.problem) + "</span>") + (c.code != null ? codeBlock(c) : "") + "</div>").join("");
    return h;
  }
  const cssId = (s) => String(s).replace(/[^\w-]/g, "_");

  // ---- Overview: everything app-wide, for when one module isn't the question ----
  function vOverview() {
    const subs = [["summary", "Summary"], ["findings", "Findings", F.filter((f) => f.severity !== "low").length], ["routes", "Routes", ROUTES.length], ["tests", "Tests", T ? T.tests : null]];
    let h = "<h1>Overview</h1><p class=\"lead\">The whole app at once: every finding, route and test.</p>";
    h += '<div class="tabs">' + subs.map(([k, t, n]) => '<button class="tab" data-f="sub" data-v="' + k + '" aria-pressed="' + (state.sub === k) + '">' + t + (n ? '<span class="n">' + n.toLocaleString() + "</span>" : "") + "</button>").join("") + "</div>";
    return h + ({ summary: oSummary, findings: oFindings, routes: oRoutes, tests: oTests }[state.sub] || oSummary)();
  }
  function oSummary() {
    const r = D.readiness || {};
    const top = F.filter((f) => f.severity !== "low");
    const hi = F.filter((f) => f.severity === "high").length;
    const unsafe = new Set(top.filter((f) => f.area === "API").map((f) => f.where)).size;
    const fact = (v, k, meter) => '<div class="fact"><div class="v">' + v + '</div><div class="k">' + k + "</div>" + (meter != null ? '<div class="meter"><span data-w="' + meter + '"></span></div>' : "") + "</div>";
    let h = '<div class="facts">' + fact(ROUTES.length, "routes, " + ((r.writes || 0) + (r.destructive || 0)) + " change data") +
      fact(r.move_money || 0, "move money") + fact(pct(ROUTES.length - unsafe, ROUTES.length) + "%", "safe for AI agents", pct(ROUTES.length - unsafe, ROUTES.length)) +
      (T ? fact(pct(T.strong + T.weak, T.tests) + "%", "of tests check something", pct(T.strong + T.weak, T.tests)) : "") + "</div>";
    h += section("fix", hi ? plural(hi, "high-risk issue") : "Fix first", null, top.length ? textBtn("Copy prompt to fix all " + top.length, promptAll(top)) : "");
    const g = GROUPS.filter((x) => x.severity !== "low").slice(0, 6);
    h += g.length ? '<div class="list">' + g.map((x) => liBtn('<div style="display:flex;gap:12px;align-items:baseline">' + dot(SEVC[x.severity]) + '<div style="min-width:0">' + two(esc(x.title), esc(x.why)) + "</div></div>", plural(x.items.length, "place"), ' data-group="' + esc(x.key) + '"')).join("") + "</div>" : empty("Nothing high or medium.");
    if (D.errors && D.errors.length) h += section("errors", "Couldn't check") + '<p class="muted small">' + D.errors.map(esc).join("<br>") + "</p>";
    return h;
  }
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
    h += '<div class="actions" style="margin:6px 0 10px">' + btn(g.items.length === 1 ? "Copy fix prompt" : "Copy prompt to fix all " + g.items.length, g.items.length === 1 ? promptFor(g.items[0]) : promptAll(g.items), "primary") + "</div>";
    h += '<div class="list compact">' + g.items.slice(0, 100).map((f) => li((LOC.test(f.where) ? loc(f.where) : '<span class="mono">' + esc(f.where) + "</span>") + '<div class="sub wrap">' + esc(f.text) + (f.module && MOD.get(f.module) ? '<span class="sep">·</span>' + modLink(f.module) : "") + "</div>", '<span class="hover-only">' + textBtn("Copy fix prompt", promptFor(f)) + "</span>")).join("") + "</div>" + (g.items.length > 100 ? '<p class="muted small">and ' + (g.items.length - 100) + " more</p>" : "");
    return h;
  }
  function oRoutes() {
    const has = (rt) => issuesByRoute.has(rt.id);
    const FL = { all: () => true, issues: has, write: (rt) => rt.effect !== "read", money: (rt) => rt.moves_money, public: (rt) => rt.access === "public" };
    const names = { all: "All", issues: "Has issues", write: "Changes data", money: "Moves money", public: "Anyone can call" };
    let h = '<div class="filters">' + Object.keys(FL).map((k) => '<button class="filter" data-f="rf" data-v="' + k + '" aria-pressed="' + (state.rf === k) + '">' + names[k] + '<span class="n">' + ROUTES.filter(FL[k]).length + "</span></button>").join("") + "</div>";
    const list = ROUTES.filter((rt) => FL[state.rf](rt) && match(rt.id + " " + rt.handler));
    return h + (few("routes", list, 40, (r) => routeRow(r, null)) || empty("Nothing matches."));
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
      h += few("tests", rows, 20, (t) => { const f = F.find((x) => x.where === t.at) || { area: "Tests", where: t.at, text: t.title, fix: "", why: "" }; return li(two(esc(t.title), loc(t.at)), '<span class="hover-only">' + textBtn("Copy fix prompt", promptFor(f)) + '</span><span class="tag ' + t.c + '">' + t.k + "</span>"); });
    }
    return h;
  }

  // ---- Current task ----
  function vChange() {
    const c = D.change;
    let h = "<h1>" + (c.done ? "Done" : "Not done yet") + '</h1><p class="lead">' + (c.done ? "The change stays within its claim, and the routes it changed have tests that check them." : "Your uncommitted change, checked against what the task claimed. " + plural(c.problems.length, "thing") + " to finish.") + "</p>";
    if (c.problems.length) h += '<div class="actions">' + btn("Copy prompt to finish it", "Finish the current change in " + D.name + ". `veridic done` reports:\n\n" + c.problems.map((p) => "- " + p).join("\n") + "\n\nFix each, then run `veridic done` again until it says DONE.", "primary") + "</div>";
    h += section("claim", "Claimed", c.claims.length || null);
    h += c.claims.length ? '<p class="mono small">' + c.claims.map(esc).join("<br>") + "</p>" : empty("Nothing claimed. Run <code>veridic claim &lt;route&gt;</code> before editing, so stray edits can be caught.");
    if (c.problems.length) h += section("problems", "To finish", c.problems.length) + '<div class="list">' + c.problems.map((p) => li('<div style="display:flex;gap:12px;align-items:baseline">' + dot("high") + "<span>" + esc(p) + "</span></div>")).join("") + "</div>";
    h += section("files", "Changed files", c.files.length);
    h += few("changed", c.files, 12, (f) => liOpen(fileLine(f.file), (f.untested_routes || []).length ? '<span class="tag high">untested</span>' : f.in_seam === false ? '<span class="tag high">outside the claim</span>' : '<span class="tag">ok</span>',
      '<dl class="kv"><dt>Routes it reaches</dt><dd>' + ((f.routes || []).map((r) => '<span class="mono">' + esc(r) + "</span>").join("<br>") || '<span class="muted">none</span>') + "</dd><dt>Tests that reach it</dt><dd>" + ((f.tests || []).map((t) => loc(t + ":1")).join("<br>") || '<span class="muted">none</span>') + "</dd></dl>"));
    return h;
  }
  const VIEWS = { modules: vModules, module: vModule, spec: vSpec, overview: vOverview, change: vChange };

  // ---- shell and rendering ----
  const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };
  function shell() {
    $("#app").innerHTML = '<div class="shell"><button class="iconbtn menu-btn" id="menu" aria-label="Menu">' + ic("menu") + '</button><aside class="side"><div class="brand"><span class="mark">' + ic("logo") + '</span><span>Veridic</span><span class="repo">' + esc(D.name) + "</span></div>" +
      '<label class="search">' + ic("search", "sm") + '<input id="q" placeholder="Search" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>' +
      '<nav class="nav" id="nav"></nav><div class="mods" id="mods"></div>' +
      '<div class="sidefoot"><span class="grow" title="' + esc(new Date(D.generated).toLocaleString()) + '">' + esc(ago(D.generated)) + '</span><select class="pick" id="editor" title="Where file links open"><option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="none">No links</option></select>' +
      '<button class="iconbtn" id="refresh" title="Copy the command that refreshes this report">' + ic("refresh", "sm") + '</button><button class="iconbtn" id="theme" aria-label="Toggle light or dark"></button></div></aside>' +
      '<div class="content"><main class="page" id="main"></main></div></div>';
    $("#editor").value = ED;
  }
  function nav() {
    const cur = state.view === "module" ? "modules" : state.view;
    $("#nav").innerHTML = NAV.map((n) => '<button class="item" data-nav="' + n.k + '"' + (n.k === cur && !(state.view === "module") ? ' aria-current="page"' : "") + '><span class="grow">' + n.t + "</span>" + (n.dot ? dot(n.dot) : "") + "</button>").join("");
    $("#mods").innerHTML = MODS.length ? '<div class="label">Modules</div>' + MODS.map((m) => { const st = statusOf(m); return '<button class="item' + (state.view === "module" && state.mod === m.id ? " on" : "") + '" data-mod="' + esc(m.id) + '"><span class="grow">' + esc(m.name) + "</span>" + (st && st.c ? dot(st.c) : "") + "</button>"; }).join("") : "";
  }
  function render(keepScroll) {
    CLIP.length = 0;
    seq = 0;
    const main = $("#main");
    main.className = "page fade" + (state.view === "spec" || state.view === "overview" ? " wide" : "");
    main.innerHTML = VIEWS[state.view]();
    void main.offsetWidth;
    requestAnimationFrame(() => $$("#main [data-w]").forEach((el) => (el.style.width = el.dataset.w + "%")));
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
    // The search box searches the current view: a new view starts unfiltered.
    state.q = "";
    state.pages = {};
    state.open = new Set();
    $("#q").value = "";
    $(".shell").classList.remove("menu");
    try { history.pushState(null, "", "#" + (k === "module" ? "module/" + encodeURIComponent(state.mod) : k)); } catch {}
    nav();
    render();
  }
  const openModule = (id, jump) => { state.mod = id; state.jump = jump || null; setView("module"); };
  window.addEventListener("popstate", () => { Object.assign(state, { view: "modules", mod: null, jump: null }, fromHash()); state.q = ""; state.pages = {}; state.open = new Set(); $("#q").value = ""; nav(); render(); });
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
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); } catch { const a = document.createElement("textarea"); a.value = text; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); }
    toast(msg || "Copied. Paste it into Claude Code.");
  }

  shell();
  applyTheme();
  nav();
  render();

  document.addEventListener("click", (e) => {
    const t = e.target;
    const c = t.closest("[data-copy]");
    if (c) { e.preventDefault(); e.stopPropagation(); copy(CLIP[+c.dataset.copy]); return; }
    const md0 = t.closest("[data-mod]");
    if (md0) { openModule(md0.dataset.mod, md0.dataset.to); return; }
    const sp = t.closest("[data-spec]");
    if (sp) { state.spec = +sp.dataset.spec; state.sf = "all"; if (state.view !== "spec") setView("spec"); else { state.pages = {}; state.open = new Set(); render(); } return; }
    if (t.closest("[data-about]")) { state.aboutOpen = !state.aboutOpen; render(true); return; }
    const op = t.closest("[data-open]");
    if (op) { state.open.add(op.dataset.open); render(true); return; }
    const rq = t.closest("[data-req]");
    if (rq) { state.sf = "all"; state.q = ""; $("#q").value = ""; state.open.add("reqs" + state.spec); render(true); const r = $("#main .req-" + cssId(rq.dataset.req)); if (r) { if (!r.classList.contains("open")) toggle(r); r.scrollIntoView({ block: "center", behavior: "smooth" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 1400); } return; }
    const pg = t.closest("[data-page]");
    if (pg) { if (pg.disabled) return; state.pages[pg.dataset.page] = +pg.dataset.p; render(true); return; }
    const sb = t.closest("[data-sub]");
    if (sb) { state.sub = sb.dataset.sub; state.sev = ["high", "medium"]; setView("overview"); return; }
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
    if (g) { state.openGroup = g.dataset.group; state.sev = ["high", "medium", "low"]; state.area = "all"; state.sub = "findings"; state.open.add("findings"); render(true); return; }
    if (t.closest("#menu")) { $(".shell").classList.toggle("menu"); return; }
    if (t.closest("a, button, select, input, label, pre")) return;
    const row = t.closest(".li[data-d]");
    if (row) toggle(row);
  });
  $("#q").addEventListener("input", (e) => { state.q = e.target.value; state.pages = {}; render(true); });
  $("#editor").addEventListener("change", (e) => { ED = e.target.value; store.set("editor", ED); render(true); });
  $("#theme").addEventListener("click", () => { store.set("theme", effective() === "dark" ? "light" : "dark"); applyTheme(); });
  $("#refresh").addEventListener("click", () => copy("cd " + JSON.stringify(D.repo) + " && veridic report", "Command copied. Run it in a terminal."));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if (e.key === "Escape" && typing) { const i = $("#q"); i.value = ""; state.q = ""; i.blur(); render(true); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "/") { e.preventDefault(); $("#q").focus(); }
    else if (e.key === "t") $("#theme").click();
  });
})();
