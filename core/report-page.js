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
  const btn = (label, text, cls) => '<button class="btn ' + (cls || "") + '" data-copy="' + clip(text) + '">' + (/Claude/.test(label) ? ic("sparkle", "sm") : "") + esc(label) + "</button>";
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
  // Everything the agent needs to know about a module: what it does, its routes and what each
  // really does, its tables, screens, tests, rules, issues and neighbours. The page stays brief; this doesn't.
  const nameOf = (id) => (MOD.get(id) || { name: id }).name;
  function ctx(m) {
    const d = m.data || { owns: [], uses: [] };
    const L = ["## Context: the " + m.name + " module of " + D.name, "It lets callers " + m.does.join(", ") + "."];
    L.push("", "Routes (what each really does, traced through the code it calls):");
    for (const r of modRoutes(m)) L.push("- " + r.id + ": " + [EFF[r.effect] || EFF.read, r.moves_money && "moves money", r.notifies && "notifies", r.external && "calls an outside service"].filter(Boolean).join(", ") + "; callable by " + (ACC[r.access] || r.access).toLowerCase() + (r.scoped && r.access !== "public" ? "; " + (OWN[r.scoped] || "").toLowerCase() : "") + ((r.tables || []).length ? "; tables: " + r.tables.map((t) => t.op + " " + t.table).join(", ") : "") + (m.tests.untested.includes(r.id) ? "; NO TEST" : "") + ". Code: " + r.handler);
    if (d.owns.length) L.push("", "Tables it owns: " + d.owns.map((t) => t.table + " (" + t.at + ")" + (t.alsoWrittenBy.length ? ", also changed by " + t.alsoWrittenBy.map(nameOf).join(", ") : "")).join("; ") + ".");
    if (d.uses.length) L.push("Tables it only reads (owned by other modules; change them there): " + d.uses.map((t) => t.table + (t.owner ? " (" + nameOf(t.owner) + ")" : "")).join(", ") + ".");
    if ((m.screens || []).length) L.push("", "Screens that call it: " + m.screens.map((x) => x.file + " (" + x.kind + ")").join(", ") + ".");
    L.push("", "Backend code: " + [...m.files, ...m.code.filter((f) => !m.files.includes(f))].join(", ") + ".");
    if (m.shared.length) L.push("Shared code it relies on (used app-wide; change only if you must): " + m.shared.slice(0, 12).join(", ") + ".");
    if (m.tests.files.length) L.push("Tests that reach it: " + m.tests.files.map((t) => t.file).join(", ") + ".");
    for (const sp of specsOf(m)) L.push("", "Its rules (" + sp.path + "):", ...specReqs(sp).map((r) => "- " + r.id + ": " + r.text + (r.stale ? " [code changed since written]" : "") + (tested(r) ? "" : " [no test]")));
    if (!m.specified) L.push("", "It has no spec yet: nothing written says what these routes must do.");
    const iss = modFindings(m).filter((f) => f.severity !== "low");
    if (iss.length) L.push("", "Open issues:", ...iss.map((f) => "- " + f.severity + ": " + (f.title || f.kind) + " at " + f.where + ": " + f.text));
    if (m.usedBy.length) L.push("", "Modules that depend on it (re-check them after a change): " + m.usedBy.map((u) => nameOf(u.module) + " via " + u.via.join(", ")).join("; ") + ".");
    if (m.uses.length) L.push("It depends on: " + m.uses.map((u) => nameOf(u.module)).join(", ") + ".");
    return L.join("\n");
  }
  function appCtx() {
    const A = D.app;
    return ["## Context: " + ((A && A.title) || D.name), A ? A.about.split(/\n\s*\n/)[0] : "", "", "Its modules (found from the code):",
      ...MODS.map((m) => "- " + m.name + ": " + m.does.slice(0, 4).join(", ") + ((m.data && m.data.owns.length) ? "; owns " + m.data.owns.map((t) => t.table).join(", ") : "") + "; code in " + m.files.slice(0, 3).join(", ")),
    ].join("\n");
  }
  const WORKFLOW = "How to work: read the code first. If this changes what the app must do, add or update the rules in the module's spec (specs/<module>/spec.md), each backed by [evidence: file:line]. Run `veridic claim` with the routes and files you will change, so edits that leak into other modules get caught. Make the change, write tests that assert the new behavior, then run `veridic done` and keep going until it says DONE.";
  const promptChange = (m, ask) => m
    ? "In " + D.name + ", change the " + m.name + " module:\n\n" + ask + "\n\nFirst run `" + claimOf(m) + "`. " + WORKFLOW + "\n\n" + ctx(m)
    : "In " + D.name + ":\n\n" + ask + "\n\nFirst work out which module(s) this belongs to from the list below, and say so. If it is new, say which existing module it sits next to, or that it is a new one. " + WORKFLOW + "\n\n" + appCtx();
  const promptModuleSpec = (m) => "Use veridic to write a spec for the " + m.name + " module of " + D.name + ". Start with the riskiest behavior (money, deletes, writes). Write user stories with Given/When/Then scenarios, requirements backed by [evidence: file:line] citations to the code that does them, and the invariants that must always hold. Save it as specs/" + m.id + "/spec.md, then run `veridic check` and `veridic tests`.\n\n" + ctx(m);
  const promptModuleTests = (m) => { const ids = m.tests.untested; return "In " + D.name + ", these routes of the " + m.name + " module have no test that calls them or names them:\n" + ids.map((x) => "- " + x).join("\n") + "\n\nRun `veridic claim " + ids.slice(0, 8).map((x) => JSON.stringify(x)).join(" ") + "` first. Then, starting with the routes that move money or change data, write tests that call each route and assert its real effect (status, body, and what changed in the data). Make each test fail if the behavior broke. Run them, then `veridic done`.\n\n" + ctx(m); };
  const claimOf = (m) => "veridic claim " + [...m.routes, ...screensOf(m)].map((x) => JSON.stringify(x)).join(" ");
  const promptTask = (m) => promptChange(m, "<describe what you want to change here>");

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

  // ---- Indicators: one word and a dot each, backed by a number ----
  const IND = { good: ["ok", "Good"], care: ["med", "Needs work"], risk: ["high", "At risk"] };
  const inModules = MODS.reduce((n, m) => n + m.stats.routes, 0);
  const untestedAll = MODS.reduce((n, m) => n + m.tests.untested.length, 0);
  const specsOf = (m) => SPECS.filter((sp) => m.specs.includes(sp.path));
  function indicators(m) {
    const fs = m ? modFindings(m) : F;
    const hi = fs.filter((f) => f.severity === "high").length, me = fs.filter((f) => f.severity === "medium").length;
    const routes = m ? m.stats.routes : inModules || ROUTES.length;
    const tp = pct(routes - (m ? m.tests.untested.length : untestedAll), routes);
    const sp = pct(m ? m.specified : ROUTES.filter((r) => r.specs && r.specs.length).length, m ? m.stats.routes : ROUTES.length);
    const stale = (m ? specsOf(m) : SPECS).flatMap(specReqs).filter((r) => r.stale).length;
    const safe = pct(routes - new Set(fs.filter((f) => f.severity !== "low" && f.area === "API").map((f) => f.where)).size, routes);
    return [
      { k: "Safety", i: "shield", s: hi ? "risk" : me ? "care" : "good", p: safe, v: "of routes safe" + (hi ? " · " + plural(hi, "serious issue") : me ? " · " + plural(me, "issue") : "") },
      { k: "Tests", i: "flask", s: tp >= 70 ? "good" : tp >= 30 ? "care" : "risk", p: tp, v: "of routes tested" },
      { k: "Rules", i: "doc", s: sp >= 50 && !stale ? "good" : "care", p: sp, v: stale ? stale + " out of date" : sp ? "of routes covered" : "none written" },
      ...(!m && D.change ? [{ k: "Change", i: "branch", s: D.change.done ? "good" : "risk", p: D.change.done ? 100 : 0, big: D.change.done ? "✓" : String(D.change.problems.length), v: D.change.done ? "done" : "to finish", nav: "change" }] : []),
    ];
  }
  const indRow = (list) => '<div class="inds">' + list.map((i) => { const c = IND[i.s][0]; return "<" + (i.nav ? 'button data-nav="' + i.nav + '"' : "div") + ' class="ind">' + ring(i.p, c, 64, i.big != null ? esc(i.big) : i.p + "%") + '<div><div class="ik">' + ic(i.i, "sm") + i.k + '</div><div class="iv t-' + c + '">' + IND[i.s][1] + '</div><div class="id2">' + esc(i.v) + "</div></div></" + (i.nav ? "button" : "div") + ">"; }).join("") + "</div>";

  // ---- Next steps: what to do, in order, each backed by an indicator and handed to Claude with full context ----
  const riskOrder = (a, b) => (b.risk || 0) - (a.risk || 0);
  function nextSteps(scope) {
    const steps = [];
    const mods = scope ? [scope] : [...MODS].sort(riskOrder);
    const c = D.change;
    if (!scope && c && !c.done) steps.push({ i: "branch", c: "high", t: "Finish the change in progress", why: plural(c.problems.length, "problem") + " from veridic done: " + c.problems.slice(0, 2).join("; "), p: "Finish the current change in " + D.name + ". `veridic done` reports:\n\n" + c.problems.map((p) => "- " + p).join("\n") + "\n\nFix each, then run `veridic done` again until it says DONE." });
    for (const m of mods) {
      const fs = modFindings(m).filter((f) => f.severity === "high");
      if (fs.length) steps.push({ i: "shield", c: "high", t: "Fix " + plural(fs.length, "serious issue") + (scope ? "" : " in " + m.name), why: [...new Set(fs.map((f) => f.title || f.kind))].join("; "), p: promptAll(fs) + "\n\n" + ctx(m) });
    }
    for (const sp of scope ? specsOf(scope) : SPECS) {
      const st = specReqs(sp).filter((r) => r.stale);
      if (st.length) steps.push({ i: "doc", c: "med", t: "Re-check " + plural(st.length, "rule") + " whose code changed", why: specTitle(sp) + ": " + st.map((r) => r.id).join(", ") + " cite code that changed since they were written", p: promptSpec(sp) });
    }
    for (const m of mods) {
      const fs = modFindings(m).filter((f) => f.severity === "medium" && f.area !== "Spec");
      if (fs.length && !modFindings(m).some((f) => f.severity === "high")) steps.push({ i: "shield", c: "med", t: "Review " + plural(fs.length, "issue") + (scope ? "" : " in " + m.name), why: [...new Set(fs.map((f) => f.title || f.kind))].join("; "), p: promptAll(fs) + "\n\n" + ctx(m) });
    }
    const needTests = mods.filter((m) => m.tests.untested.length && m.stats.writes + m.stats.destructive + m.stats.money).slice(0, scope ? 1 : 2);
    for (const m of needTests) steps.push({ i: "flask", c: m.stats.money ? "high" : "med", t: "Add tests" + (scope ? "" : " to " + m.name), why: m.tests.untested.length + " of " + plural(m.stats.routes, "route") + " untested" + (m.stats.money ? "; it moves money" : m.stats.destructive ? "; it deletes data" : "; it changes data"), p: promptModuleTests(m) });
    const needSpec = mods.filter((m) => !m.specified).slice(0, 1);
    for (const m of needSpec) steps.push({ i: "doc", c: "", t: "Write down the rules" + (scope ? "" : " for " + m.name), why: "No spec yet, so a bug and an intended change look the same" + (m.stats.money ? "; it moves money" : ""), p: promptModuleSpec(m) });
    if (!scope && T && T.unasserted + T.empty) {
      const tf = F.filter((f) => f.area === "Tests" && f.severity === "medium");
      steps.push({ i: "flask", c: "med", t: "Fix tests that check nothing", why: plural(T.unasserted + T.empty, "test") + " pass even when the code is broken", p: promptAll(tf.slice(0, 40)) });
    }
    return steps;
  }
  const stepList = (steps, n) => steps.length
    ? '<div class="steps">' + steps.slice(0, n).map((s, i) => '<div class="stepc"><span class="sico ' + (s.c || "none") + '">' + ic(s.i || "sparkle") + '</span><div class="main"><div class="title">' + esc(s.t) + '</div><div class="sub" title="' + esc(s.why) + '">' + esc(s.why) + "</div></div>" + btn("Copy for Claude", s.p, i === 0 ? "primary" : "") + "</div>").join("") + "</div>"
    : empty("Nothing pressing. Every route is checked, tested and covered by rules.");
  const composer = (key, placeholder) => '<div class="composer"><textarea id="ask-' + key + '" rows="2" placeholder="' + esc(placeholder) + '"></textarea><div class="row"><span class="faint small">Copies a prompt with everything Claude needs to know about ' + (key === "app" ? "the app" : "this module") + ".</span>" + '<button class="btn primary" data-compose="' + esc(key) + '">' + ic("sparkle", "sm") + 'Copy for Claude</button></div></div>';

  // ---- Home: the repo in a glance, and what to do next ----
  function vModules() {
    const A = D.app;
    let h = "<h1>" + esc((A && A.title) || D.name) + "</h1>";
    h += A ? '<div class="about clamp">' + mdBlock(A.about.split(/\n\s*\n/)[0]) + "</div>" : '<p class="lead">No README describes this app yet.</p>';
    h += indRow(indicators(null));
    const steps = nextSteps(null);
    h += section("next", "Next steps", null, steps.length > 5 ? '<button class="text-btn" data-open="steps">All ' + steps.length + "</button>" : "");
    h += stepList(steps, state.open.has("steps") ? 99 : 5);
    h += section("build", "Build or change something");
    h += composer("app", "Describe a feature or a change, in your own words…");
    h += section("modules", "Modules", MODS.length);
    if (!MODS.length) return h + empty("Veridic finds modules from the app's routes. Run <code>veridic init</code> in the repo so it can index the code.");
    const list = MODS.filter((m) => match(m.name + " " + m.does.join(" ")));
    h += list.length ? '<div class="tiles">' + list.map(tile).join("") + "</div>" + '<div class="legend">' + dot("ok") + "good" + dot("med") + "needs work" + dot("high") + "at risk</div>" : empty("Nothing matches.");
    return h;
  }

  // A module as a tile: its health at a glance. Three pips: safety, tests, rules.
  function tile(m) {
    const [sf, ts, rl] = indicators(m);
    const worst = [sf, ts, rl].some((x) => x.s === "risk") ? "high" : [sf, ts, rl].some((x) => x.s === "care") ? "med" : "ok";
    const pip = (x) => '<span class="pip ' + IND[x.s][0] + '" title="' + x.k + ": " + IND[x.s][1] + '">' + ic(x.i, "sm") + "</span>";
    return '<button class="tile ' + worst + '" data-mod="' + esc(m.id) + '"><div class="tname">' + esc(m.name) + '</div><div class="tsub">' + ic("route", "sm") + m.stats.routes + ((m.data && m.data.owns.length) ? ic("db", "sm") + m.data.owns.length : "") + ((m.screens || []).length ? ic("monitor", "sm") + m.screens.length : "") + '</div><div class="pips">' + pip(sf) + pip(ts) + pip(rl) + "</div></button>";
  }

  // ---- A module: a glance, its next steps, and a box to change it. The detail is the agent's, behind "Details" ----
  function vModule() {
    const m = MOD.get(state.mod);
    if (!m) { state.view = "modules"; return vModules(); }
    let h = '<button class="back" data-nav="modules">' + ic("back", "sm") + "Home</button>";
    h += "<h1>" + esc(m.name) + "</h1>";
    if (m.does.length) h += '<p class="lead">Lets callers ' + m.does.slice(0, 4).map(esc).join(", ") + (m.does.length > 4 ? ", and more" : "") + ".</p>";
    h += indRow(indicators(m));
    const steps = nextSteps(m);
    h += section("next", "Next steps");
    h += stepList(steps, 4);
    h += section("build", "Change something here");
    h += composer(m.id, "What should change in " + m.name + "?");
    h += '<details class="details"' + (state.open.has("details") ? " open" : "") + ' data-details><summary>Details<span class="faint"> · ' + plural(m.stats.routes, "route") + ((m.data && m.data.owns.length) ? ", " + plural(m.data.owns.length, "table") : "") + ((m.screens || []).length ? ", " + plural(m.screens.length, "screen") : "") + "</span></summary>" + moduleDetails(m) + "</details>";
    return h;
  }
  function moduleDetails(m) {
    const s = m.stats, rs = modRoutes(m), fs = modFindings(m).filter((f) => f.severity !== "low");
    let h = "";

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
    main.className = "page fade" + (state.view !== "module" && state.view !== "change" ? " wide" : "");
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
    const cp = t.closest("[data-compose]");
    if (cp) { const k = cp.dataset.compose, box = document.getElementById("ask-" + k), ask = box && box.value.trim(); if (!ask) { toast("Describe the change first."); if (box) box.focus(); return; } copy(promptChange(MOD.get(k) || null, ask)); return; }
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
    if (t.closest("a, button, select, input, label, pre, textarea, summary")) return;
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
