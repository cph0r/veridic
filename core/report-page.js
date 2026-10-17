// Veridic report page. Reads the JSON embedded in the page and renders it; no
// network, no dependencies. Views: Spec (first, when the repo has one), Health,
// Findings, Routes, Tests, Current change. Buttons copy prompts or open the editor:
// a static page never runs anything itself.
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

  // ---- icons (stroke, 24px grid) ----
  const P = {
    spec: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    health: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
    flask: '<path d="M9 3h6M10 3v6L4.5 18.5A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-2.5L14 9V3"/><path d="M7 15h10"/>',
    branch: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6M18 11a6 6 0 0 1-6 6H9"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>',
    check2: '<path d="m5 12 5 5L20 7"/>',
    x: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
    minus: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
    coins: '<circle cx="8" cy="8" r="6"/><path d="M18.1 10.4A6 6 0 1 1 10.3 18M7 6h1v4M16.7 13.9l.7.7-2.8 2.8"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>',
    sparkle: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z"/><path d="M14.7 6.3 17 4l3 3-2.3 2.3"/>',
    code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
    changed: '<path d="M3.05 11a9 9 0 1 1 .5 4M3 4v5h5"/><path d="M12 8v4l2 2"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 10v10M15 10v10"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    logo: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  };
  const ic = (n, cls) => '<svg class="i ' + (cls || "") + '" viewBox="0 0 24 24" aria-hidden="true">' + (P[n] || "") + "</svg>";

  // ---- vocabulary: plain words and an icon for every state ----
  const rank = (s) => ({ high: 0, medium: 1, low: 2 })[s] ?? 3;
  const SEV = { high: { t: "High", c: "high" }, medium: { t: "Medium", c: "med" }, low: { t: "Low", c: "low" } };
  const AREA = { API: { i: "route", t: "API" }, Tests: { i: "flask", t: "Tests" }, Spec: { i: "spec", t: "Spec" }, Change: { i: "branch", t: "Change" } };
  const REQ = {
    passing: { t: "Tested, passing", i: "check", c: "ok" },
    covered: { t: "Tested", i: "check", c: "ok" },
    failing: { t: "Test failing", i: "x", c: "high" },
    unasserted: { t: "Test checks nothing", i: "x", c: "high" },
    tagged_only: { t: "Test misses the code", i: "minus", c: "med" },
    todo: { t: "Test is a todo", i: "minus", c: "low" },
    none: { t: "No test yet", i: "minus", c: "med" },
  };
  const tested = (r) => r.status === "passing" || r.status === "covered";
  const EFF = { read: { t: "Reads", i: "eye", c: "info" }, write: { t: "Changes data", i: "pencil", c: "med" }, destructive: { t: "Deletes", i: "trash", c: "high" } };
  const ACC = { public: { t: "Anyone", i: "globe", c: "med" }, auth: { t: "Signed-in users", i: "user", c: "info" }, role: { t: "Admins / roles", i: "shield", c: "ok" } };
  const OWN = { yes: { t: "Checks it's the caller's", i: "lock", c: "ok" }, no: { t: "Doesn't check whose it is", i: "unlock", c: "high" }, weak: { t: "Checks with values the client sends", i: "unlock", c: "med" } };

  // ---- data ----
  const F = D.findings || [];
  const ROUTES = D.routes || [];
  const SPECS = D.specs || [];
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

  // ---- small builders ----
  let ED = store.get("editor") || "vscode";
  const LOC = /^([^\s:()]+\.[\w]+):(\d+)(?:-\d+)?/;
  const hrefOf = (t) => {
    const m = String(t).match(LOC);
    if (!m || ED === "none") return null;
    const abs = (D.repo + "/" + m[1]).replace(/\/+/g, "/");
    return ED + "://file" + encodeURI(abs.startsWith("/") ? abs : "/" + abs) + ":" + m[2];
  };
  const loc = (t) => {
    const h = hrefOf(t);
    return h ? '<a class="loc" href="' + h + '" title="Open in ' + (ED === "cursor" ? "Cursor" : "VS Code") + '">' + esc(t) + "</a>" : '<span class="mono">' + esc(t) + "</span>";
  };
  const CLIP = [];
  const btn = (label, text, cls, icon) => '<button class="btn ' + (cls || "") + '" data-copy="' + (CLIP.push(text) - 1) + '">' + ic(icon || "copy", "sm") + label + "</button>";
  const iconBtn = (icon, tip, text) => '<button class="btn ghost" data-tip="' + esc(tip) + '" data-copy="' + (CLIP.push(text) - 1) + '">' + ic(icon, "sm") + "</button>";
  const openBtn = (t) => { const h = hrefOf(t); return h ? '<a class="btn ghost" data-tip="Open in editor" href="' + h + '">' + ic("ext", "sm") + "</a>" : ""; };
  const pill = (icon, label, tone) => '<span class="pill bg-' + tone + '">' + (icon ? ic(icon, "sm") : '<span class="dot"></span>') + esc(label) + "</span>";
  const sevPill = (s) => pill(null, SEV[s].t, SEV[s].c);
  const icoBox = (icon, tone, tip) => '<span class="ic bg-' + tone + '"' + (tip ? ' data-tip="' + esc(tip) + '"' : "") + ">" + ic(icon) + "</span>";
  const labelled = (m, tone) => '<span class="lbl">' + icoBox(m.i, m.c || tone) + esc(m.t) + "</span>";
  const head = (title, sub, right) => '<div class="head in"><div><h1>' + title + "</h1>" + (sub ? "<p>" + sub + "</p>" : "") + "</div>" + (right ? '<div class="right">' + right + "</div>" : "") + "</div>";
  const empty = (icon, title, text, action) => '<div class="card in"><div class="empty"><div class="big bg-ok">' + ic(icon) + "</div><h3>" + title + "</h3><div>" + text + "</div>" + (action || "") + "</div></div>";
  const num = (v, suffix) => '<span data-count="' + v + '" data-suffix="' + (suffix || "") + '">' + (typeof v === "number" ? 0 : esc(v)) + (suffix || "") + "</span>";
  const kpi = (icon, tone, value, label, extra) => '<div class="card kpi in"><div class="ico bg-' + tone + '">' + ic(icon, "lg") + '</div><div><div class="v">' + (typeof value === "number" ? num(value) : esc(value)) + '</div><div class="k">' + label + "</div></div>" + (extra || "") + "</div>";
  const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const toneOf = (p) => (p >= 90 ? "ok" : p >= 60 ? "med" : "high");
  const ring = (p, tone, size) => donut([{ v: p, c: "var(--" + tone + ")" }, { v: 100 - p, c: "transparent" }], size || 56, "", "", 7, true);
  function donut(segs, size, center, sub, width, bare) {
    const w = width || 12, r = (size - w) / 2, C = 2 * Math.PI * r, tot = segs.reduce((n, s) => n + s.v, 0) || 1, c = size / 2;
    let off = 0;
    const arcs = segs.filter((s) => s.v > 0).map((s) => {
      const len = (s.v / tot) * C;
      const el = '<circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="' + s.c + '" stroke-width="' + w + '" stroke-dasharray="0 ' + C + '" data-dash="' + len + " " + (C - len) + '" stroke-dashoffset="' + -off + '"/>';
      off += len;
      return el;
    }).join("");
    return '<svg class="donut ring" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + " " + size + '" aria-hidden="true"><g transform="rotate(-90 ' + c + " " + c + ')"><circle cx="' + c + '" cy="' + c + '" r="' + r + '" fill="none" stroke="var(--surface-3)" stroke-width="' + w + '"/>' + arcs + "</g>" +
      (bare ? "" : '<text x="50%" y="49%" text-anchor="middle" dominant-baseline="middle" class="center">' + esc(center) + '</text><text x="50%" y="66%" text-anchor="middle" class="centerk">' + esc(sub) + "</text>") + "</svg>";
  }
  const kpiRing = (a, b, label, icon) => { const p = pctOf(a, b); const t = toneOf(p); return '<div class="card kpi in"><div class="ico bg-' + t + '">' + ic(icon, "lg") + '</div><div><div class="v">' + num(p, "%") + '</div><div class="k">' + label + '</div><div class="k">' + a + " of " + b + '</div></div><div class="ring">' + ring(p, t) + "</div></div>"; };
  const bar = (segs, thin) => '<div class="bar' + (thin ? " thin" : "") + '">' + segs.map((s) => '<span style="background:' + s.c + '" data-w="' + s.p + '"></span>').join("") + "</div>";
  const chipRow = (name, items, cur) => '<div class="chips in">' + items.map((x) => '<button class="chip" data-chip="' + name + '" data-v="' + esc(x.k) + '" aria-pressed="' + (Array.isArray(cur) ? cur.includes(x.k) : String(cur) === String(x.k)) + '">' + (x.i ? ic(x.i, "sm") : "") + esc(x.t) + (x.n != null ? ' <span class="n">' + x.n + "</span>" : "") + "</button>").join("") + "</div>";
  let rowSeq = 0;
  const row = (cells, detail, cls) => { const id = "d" + rowSeq++; return '<tr class="row ' + (cls || "") + '" data-d="' + id + '"><td class="c" style="width:28px">' + ic("chev", "sm chev") + "</td>" + cells.map((c) => "<td>" + c + "</td>").join("") + '</tr><tr class="detail" id="' + id + '" hidden><td colspan="' + (cells.length + 1) + '"><div class="inner">' + detail + "</div></td></tr>"; };
  const table = (cols, rows, more) => '<div class="card in"><div class="tablewrap"><table class="t"><thead><tr><th></th>' + cols.map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table></div>" + (more || "") + "</div>";
  const q = () => (state.q || "").toLowerCase();
  const match = (text) => !q() || String(text).toLowerCase().includes(q());

  // Pagination: one pager for every long table; the page size is remembered.
  let PAGE = Number(store.get("page-size")) || 25;
  function paginate(key, list) {
    const pages = Math.max(1, Math.ceil(list.length / PAGE));
    const p = Math.min(state.pages[key] || 0, pages - 1);
    state.pages[key] = p;
    return { items: list.slice(p * PAGE, (p + 1) * PAGE), html: pager(key, p, pages, list.length) };
  }
  function pager(key, p, pages, total) {
    if (total <= 10) return "";
    const from = p * PAGE + 1, to = Math.min(total, (p + 1) * PAGE);
    const shown = [...new Set([0, pages - 1, p - 1, p, p + 1].filter((i) => i >= 0 && i < pages))].sort((a, b) => a - b);
    let nums = "", prev = -1;
    for (const i of shown) {
      if (i - prev > 1) nums += '<span class="pg gap">…</span>';
      nums += '<button class="pg" data-page="' + key + '" data-p="' + i + '"' + (i === p ? ' aria-current="page"' : "") + ">" + (i + 1) + "</button>";
      prev = i;
    }
    return '<div class="pager"><span class="muted small">Showing <b>' + from + "–" + to + "</b> of <b>" + total.toLocaleString() + '</b></span><span class="sp"></span>' +
      '<label class="muted small hide-sm">Rows <select class="pick" data-size>' + [10, 25, 50, 100].map((n) => "<option" + (n === PAGE ? " selected" : "") + ">" + n + "</option>").join("") + "</select></label>" +
      '<button class="pg" data-page="' + key + '" data-p="' + (p - 1) + '"' + (p === 0 ? " disabled" : "") + ' aria-label="Previous page">' + ic("chev", "sm flip") + "</button>" + nums +
      '<button class="pg" data-page="' + key + '" data-p="' + (p + 1) + '"' + (p >= pages - 1 ? " disabled" : "") + ' aria-label="Next page">' + ic("chev", "sm") + "</button></div>";
  }

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
    const rs = specReqs(s);
    const gaps = rs.filter((r) => !tested(r) || r.stale);
    return gaps.length
      ? "Close the gaps in " + s.path + " (" + D.name + "):\n\n" + gaps.map((r) => "- " + r.id + ": " + (r.stale ? "its code changed (" + citesOf(r) + "); re-check it. " : "") + (!tested(r) ? "needs a test named with " + r.id + ". " : "") + r.text).join("\n") + "\n\nFor stale ones run `veridic stale` (and `--fix` if lines only moved). Write each missing test with the requirement id in its title. Finish with `veridic check` and `veridic tests`."
      : "Every requirement in " + s.path + " is tested and matches the code. Run `veridic metrics --card` to confirm.";
  };

  // ---- state ----
  const NAV = [
    { k: "modules", t: "Modules", i: "grid", n: (D.modules || []).length || null },
    { k: "spec", t: "Specs", i: "spec", n: SPECS.length || null },
    ...(D.change ? [{ k: "change", t: "Current task", i: "branch", n: D.change.problems.length || null, hot: !D.change.done }] : []),
    { k: "overview", t: "App overview", i: "health", n: F.filter((f) => f.severity !== "low").length || null, hot: F.some((f) => f.severity === "high") },
  ];
  const fromHash = () => { const h = location.hash.slice(1).split("/"); return h[0] === "module" && h[1] ? { view: "module", mod: decodeURIComponent(h[1]), jump: h[2] } : NAV.some((n) => n.k === h[0]) ? { view: h[0] } : { view: "modules" }; };
  const state = {
    ...fromHash(),
    sub: "summary",
    q: "",
    sev: ["high", "medium"],
    area: "all",
    rf: "all",
    spec: 0,
    sf: "all",
    aboutOpen: false,
    openGroup: null,
    pages: {},
  };


  // ---- views ----
  // ---- Modules: the app's features, found from its code; each one a page that is
  // everything a newcomer needs to work on it without learning the rest ----
  const MODS = D.modules || [];
  const MOD = new Map(MODS.map((m) => [m.id, m]));
  const specTitle = (s) => (s.doc && s.doc.title) || specName(s);
  // Markdown, the little the specs and READMEs use: `code` (file:line becomes a link), **bold**, lists.
  const md = (t) => String(t ?? "").split(/`([^`]+)`/).map((p, i) => (i % 2 ? (LOC.test(p) ? loc(p) : "<code>" + esc(p) + "</code>") : esc(p).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"))).join("");
  const mdBlock = (t) => String(t ?? "").split(/\n\s*\n/).map((b) => {
    const ls = b.split("\n");
    if (ls.every((l) => /^\s*([-*]|\d+\.)\s/.test(l))) { const ol = /^\s*\d+\./.test(ls[0]); return "<" + (ol ? "ol" : "ul") + ' class="mdlist">' + ls.map((l) => "<li>" + md(l.replace(/^\s*([-*]|\d+\.)\s+/, "")) + "</li>").join("") + "</" + (ol ? "ol" : "ul") + ">"; }
    return "<p>" + md(b) + "</p>";
  }).join("");
  // High risk: open high issues. Needs care: medium issues or money. Needs tests: changes data, no route tested.
  const riskOf = (m) => m.stats.high ? { t: "High risk", c: "high", i: "alert" } : m.stats.medium || m.stats.money ? { t: "Needs care", c: "med", i: "shield" }
    : m.stats.writes + m.stats.destructive && m.tests.untested.length === m.stats.routes ? { t: "Needs tests", c: "med", i: "flask" } : { t: "Low risk", c: "ok", i: "check" };
  const modRoutes = (m) => ROUTES.filter((r) => r.module === m.id);
  const modFindings = (m) => F.filter((f) => f.module === m.id);
  const modLink = (id, cls) => { const m = MOD.get(id); return m ? '<button class="linkbtn ' + (cls || "") + '" data-mod="' + esc(id) + '">' + esc(m.name) + "</button>" : esc(id); };
  const filesOf = (m) => [...m.files, ...m.code.filter((f) => !m.files.includes(f))];
  const promptModuleSpec = (m) => "Use veridic to write a spec for the " + m.name + " module of " + D.name + ". It does: " + m.does.join(", ") + ".\nIts routes:\n" + modRoutes(m).map((r) => "- " + r.id + " (" + (EFF[r.effect] || EFF.read).t.toLowerCase() + (r.moves_money ? ", moves money" : "") + ") " + r.handler).join("\n") + "\nIts code: " + filesOf(m).join(", ") +
    "\n\nStart with the riskiest behavior (money, deletes, writes). Write user stories with Given/When/Then scenarios, requirements backed by [evidence: file:line] citations to the code that does them, and the invariants that must always hold. Save it as specs/" + m.id + "/spec.md, then run `veridic check` and `veridic tests`.";
  const promptModuleTests = (m) => { const ids = m.tests.untested; return "In " + D.name + ", these routes of the " + m.name + " module have no test that calls them or names them:\n" + ids.map((x) => "- " + x).join("\n") + "\n\nRun `veridic claim " + ids.slice(0, 8).map((x) => JSON.stringify(x)).join(" ") + "` first. Then, starting with the routes that move money or change data, write tests that call each route and assert its real effect (status, body, and what changed in the data). Make each test fail if the behavior broke. Run them, then `veridic done`."; };
  const promptTask = (m) => "I'm going to work on the " + m.name + " module of " + D.name + " (it does: " + m.does.join(", ") + ").\n\nFirst run `veridic claim " + m.routes.map((x) => JSON.stringify(x)).join(" ") + "` so stray edits outside it get caught. Read its code before changing anything: " + filesOf(m).join(", ") + ".\n" +
    (m.usedBy.length ? "Other modules depend on it, so re-check them after the change: " + m.usedBy.map((u) => (MOD.get(u.module) || { name: u.module }).name + " (through " + u.via.join(", ") + ")").join("; ") + ".\n" : "") +
    "When the change is done, run `veridic done` and keep going until it says DONE.\n\nThe task: <describe what you want to change here>";

  function appHeader() {
    const A = D.app;
    const covered = ROUTES.filter((r) => r.specs && r.specs.length).length;
    const stat = (v, k, icon, tone) => '<div class="astat"><span class="ic bg-' + tone + '">' + ic(icon) + '</span><div><div class="v">' + num(v) + '</div><div class="k">' + k + "</div></div></div>";
    return '<div class="card apphead in"><div class="appmain"><div class="eyebrow">' + ic("health", "sm") + "About this app</div><h1>" + esc((A && A.title) || D.name) + "</h1>" +
      (A ? '<div class="about' + (state.aboutOpen ? "" : " clamp") + '">' + mdBlock(A.about) + '</div><div class="row-flex small muted">' + (A.about.length > 160 ? '<button class="btn ghost" data-more>' + ic("chev", "sm" + (state.aboutOpen ? " up" : " down")) + (state.aboutOpen ? "Show less" : "Read more") + "</button>" : "") + "From <span class=\"mono\">" + esc(A.source) + "</span></div>"
        : '<p class="muted">No README describes this app yet. A short one helps people and agents alike.</p>') +
      '</div><div class="appstats">' + stat(MODS.length, "modules", "grid", "violet") + stat(ROUTES.length, "routes", "route", "info") + stat(SPECS.length, SPECS.length === 1 ? "spec" : "specs", "spec", "ok") + stat(covered, "routes with a spec", "check", covered ? "ok" : "low") + "</div></div>";
  }

  function vModules() {
    let h = appHeader();
    h += head(ic("grid", "lg") + "Modules", "The app split into the features it's made of, found from its code. Pick one to see what it does, the rules it must follow, its tests, its risks, and what else it touches, so you can work on it without learning the rest. Riskiest first.");
    if (!MODS.length) return h + empty("route", "No modules found", "Veridic finds modules from the app's routes. Run <code>veridic init</code> in the repo so it can index the code.");
    const list = MODS.filter((m) => match(m.name + " " + m.does.join(" ") + " " + m.files.join(" ")));
    const pg = paginate("modules", list);
    h += '<div class="modgrid">' + pg.items.map(modCard).join("") + "</div>" + (pg.html ? '<div class="card mt">' + pg.html + "</div>" : "");
    return h;
  }
  function modCard(m) {
    const r = riskOf(m), s = m.stats;
    const tested = s.routes - m.tests.untested.length;
    return '<button class="card modcard in" data-mod="' + esc(m.id) + '"><div class="row-flex" style="flex-wrap:nowrap"><span class="ic bg-' + r.c + '">' + ic(r.i) + '</span><div style="min-width:0;flex:1"><div class="mname">' + esc(m.name) + '</div><div class="mmeta">' + plural(s.routes, "route") + " · " + plural(filesOf(m).length, "file") + "</div></div>" + pill(null, r.t, r.c) + "</div>" +
      '<div class="mdoes">' + esc(m.does.slice(0, 4).join(" · ")) + "</div>" +
      '<div class="mfacts">' +
      fact("coins", s.money, "move money", "high") + fact("trash", s.destructive, "delete", "high") + fact("pencil", s.writes, "change data", "med") + fact("eye", s.reads, "read", "info") + "</div>" +
      '<div class="mfoot"><span data-tip="' + (s.high + s.medium ? plural(s.high + s.medium, "open issue") : "No open issues") + '" class="mf ' + (s.high ? "tone-high" : s.medium ? "tone-med" : "tone-ok") + '">' + ic(s.high + s.medium ? "alert" : "check2", "sm") + (s.high + s.medium || 0) + " issues</span>" +
      '<span class="mf ' + (m.specified ? "tone-ok" : "tone-low") + '" data-tip="' + (m.specified ? m.specified + " of " + s.routes + " routes have a spec" : "No spec yet") + '">' + ic("spec", "sm") + (m.specified ? Math.round((m.specified / s.routes) * 100) + "% spec" : "no spec") + "</span>" +
      '<span class="mf ' + (tested === s.routes ? "tone-ok" : tested ? "tone-med" : "tone-high") + '" data-tip="Routes a test calls or names">' + ic("flask", "sm") + tested + "/" + s.routes + " tested</span>" +
      (m.usedBy.length ? '<span class="mf tone-info" data-tip="Modules that depend on this one">' + ic("branch", "sm") + "used by " + m.usedBy.length + "</span>" : "") + "</div></button>";
  }
  const fact = (icon, n, label, tone) => (n ? '<span class="mfact bg-' + tone + '" data-tip="' + plural(n, "route") + " " + label + '">' + ic(icon, "sm") + n + "</span>" : "");

  // A module's page, in the order a newcomer needs it.
  function vModule() {
    const m = MOD.get(state.mod);
    if (!m) { state.view = "modules"; return vModules(); }
    const r = riskOf(m), s = m.stats, rs = modRoutes(m), fs = modFindings(m);
    const tested = s.routes - m.tests.untested.length;
    const sections = [["does", "What it does", "route"], ["rules", "Rules", "spec"], ["tests", "Tests", "flask"], ["risks", "Risks", "alert"], ["neighbours", "Neighbours", "branch"], ["work", "Work on it", "wrench"]];
    let h = '<div class="crumbs in"><button class="linkbtn" data-nav="modules">' + ic("grid", "sm") + "Modules</button>" + ic("chev", "sm") + "<span>" + esc(m.name) + "</span></div>";
    h += '<div class="card modhead in"><div style="flex:1;min-width:260px"><div class="row-flex"><h1>' + esc(m.name) + "</h1>" + pill(r.i, r.t, r.c) + (m.pinned ? pill("lock", "Set in .veridic.json", "low") : "") + "</div>" +
      '<p class="purpose">' + (m.does.length ? "Lets callers <b>" + m.does.map(esc).join("</b>, <b>") + "</b>." : "") + "</p>" +
      '<div class="mfoot" style="margin-top:10px">' + fact("coins", s.money, "move money", "high") + fact("trash", s.destructive, "delete", "high") + fact("pencil", s.writes, "change data", "med") + fact("eye", s.reads, "read", "info") +
      '<span class="mf muted">' + plural(s.routes, "route") + " in " + plural(m.files.length, "file") + "</span></div></div>" +
      '<div class="modactions">' + btn("Start a task here", promptTask(m), "primary", "sparkle") + '<div class="muted small">Copies a prompt that claims this module, lists what to read, and ends with <code>veridic done</code>.</div></div></div>';
    h += '<nav class="secnav in">' + sections.map(([k, t, i]) => '<a href="#module/' + esc(m.id) + "/" + k + '" data-jump="' + k + '">' + ic(i, "sm") + t + (k === "risks" && fs.filter((f) => f.severity !== "low").length ? ' <span class="n hot">' + fs.filter((f) => f.severity !== "low").length + "</span>" : k === "tests" && m.tests.untested.length ? ' <span class="n">' + m.tests.untested.length + " untested</span>" : "") + "</a>").join("") + "</nav>";

    // 1. What it does.
    h += secHead("does", "route", "What it does", "Every route in this module: what it really does (traced through the code it calls), who can call it, and whether it checks the data is the caller's.");
    const pg = paginate("mod-routes", rs.filter((rt) => match(rt.id)));
    h += table(["Method", "Path", "Does", "Who can call", "Whose data", "Spec", "Test"], pg.items.map((rt) => {
      const iss = issuesByRoute.get(rt.id) || [], e = EFF[rt.effect] || EFF.read;
      const own = rt.access === "public" && rt.effect === "read" ? null : OWN[rt.scoped];
      return row(['<span class="method m-' + esc(rt.method) + '">' + esc(rt.method) + "</span>", '<span class="path">' + esc(rt.path) + "</span>" + (iss.length ? ' <span class="pill bg-' + SEV[iss[0].severity].c + '" data-tip="' + esc(iss[0].title) + '">' + ic("alert", "sm") + iss.length + "</span>" : ""),
        '<span class="lbl">' + icoBox(e.i, e.c) + '<span class="small">' + e.t + "</span>" + (rt.moves_money ? icoBox("coins", "high", "Moves money") : "") + "</span>",
        ACC[rt.access] ? '<span class="lbl">' + icoBox(ACC[rt.access].i, ACC[rt.access].c) + '<span class="small">' + ACC[rt.access].t + "</span></span>" : esc(rt.access),
        own ? '<span class="lbl">' + icoBox(own.i, own.c) + '<span class="small">' + (rt.scoped === "yes" ? "Checked" : rt.scoped === "weak" ? "Client values" : "Not checked") + "</span></span>" : '<span class="muted">—</span>',
        rt.specs && rt.specs.length ? '<span class="tone-ok" data-tip="Covered by a spec">' + ic("check2", "sm") + "</span>" : '<span class="muted" data-tip="No spec">—</span>',
        m.tests.untested.includes(rt.id) ? '<span class="tone-high" data-tip="No test calls or names it">' + ic("x", "sm") + "</span>" : '<span class="tone-ok" data-tip="A test calls or names it">' + ic("check2", "sm") + "</span>"], routeDetail(rt, iss));
    }), pg.html);

    // 2. The rules it must follow.
    const specs = SPECS.map((sp, i) => [sp, i]).filter(([sp]) => m.specs.includes(sp.path));
    h += secHead("rules", "spec", "Rules it must follow", "What this module must always do, from its spec, each rule tied to the code that does it.");
    if (!specs.length) h += '<div class="callout warn in">' + ic("spec", "sm") + '<div style="flex:1"><b>No spec for this module yet.</b> A spec writes down the rules these routes must follow, like <i>“an order can\'t be cancelled once it\'s paid”</i>, each tied to the code that does it. Without one, nobody can tell a bug from an intended change here.' +
      (s.money ? " <b>It moves money, so it's a good one to start with.</b>" : "") + '<div class="row-flex" style="margin-top:10px">' + btn("Draft a spec from the code", promptModuleSpec(m), "primary", "sparkle") + '<span class="muted small">Copies a prompt. Paste it into Claude Code; it reads this module\'s ' + plural(s.routes, "route") + " and writes the spec.</span></div></div></div>";
    for (const [sp, si] of specs) {
      const mine = new Set(filesOf(m));
      const reqs = specReqs(sp).filter((q) => q.cites.some((c) => mine.has(c.file)));
      const shown = reqs.length ? reqs : specReqs(sp);
      h += '<div class="card in" style="margin-bottom:12px"><div class="panel-h">' + ic("file", "sm") + esc(specTitle(sp)) + '<span class="sub">' + (m.specified < s.routes ? m.specified + " of " + s.routes + " routes covered" : "covers every route") + '</span><span class="right"><button class="btn" data-spec="' + si + '">' + ic("spec", "sm") + "Open the full spec</button></span></div>" +
        '<table class="t"><tbody>' + shown.map((q) => { const st = REQ[q.status] || REQ.none; return '<tr><td style="width:84px"><span class="mono" style="font-weight:700">' + esc(q.id) + '</span></td><td><div class="reqtext">' + md(q.text) + "</div></td><td>" + pill(st.i, st.t, st.c) + "</td><td>" + (q.stale ? pill("changed", "Code changed", "med") : pill("check2", "Up to date", "ok")) + "</td></tr>"; }).join("") + "</tbody></table></div>";
      if (m.specified < s.routes) h += '<div class="row-flex in" style="margin-bottom:12px">' + btn("Draft rules for the other " + plural(s.routes - m.specified, "route"), promptModuleSpec(m), "", "sparkle") + "</div>";
    }

    // 3. Tests.
    h += secHead("tests", "flask", "Tests", "Which of these routes a test actually calls or names, and the tests that reach this module's code.");
    h += '<div class="grid two"><div class="card in"><div class="panel-b"><div class="donutwrap">' + donut([{ v: tested, c: "var(--ok)" }, { v: s.routes - tested, c: "var(--high)" }], 120, tested + "/" + s.routes, "routes tested") +
      '<div style="flex:1;min-width:180px"><div class="title">' + (tested === s.routes ? "Every route has a test" : plural(s.routes - tested, "route") + " with no test") + '</div><div class="muted small" style="margin:4px 0 10px">A route counts as tested when a test calls its URL, or reaches its handler and names it.</div>' +
      (m.tests.untested.length ? btn("Copy prompt: write the missing tests", promptModuleTests(m), "primary", "sparkle") : "") + "</div></div></div></div>" +
      '<div class="card in"><div class="panel-h">' + ic("flask", "sm") + "Tests that reach this code<span class=\"sub\">" + m.tests.files.length + "</span></div>" + (m.tests.files.length ? '<table class="t"><tbody>' + m.tests.files.slice(0, 8).map((t) => "<tr><td>" + loc(t.file + ":1") + '</td><td class="num small">' + plural(t.tests, "test") + "</td></tr>").join("") + "</tbody></table>" + (m.tests.files.length > 8 ? '<div class="more">+' + (m.tests.files.length - 8) + " more</div>" : "") : '<div class="panel-b muted">No test reaches this module\'s code.</div>') + "</div></div>";
    if (m.tests.untested.length) h += '<div class="card in mt"><div class="panel-h">' + ic("x", "sm tone-high") + "Routes with no test</div><div class=\"panel-b\" style=\"display:flex;gap:6px;flex-wrap:wrap\">" + m.tests.untested.map((x) => { const [mm, ...p] = x.split(" "); return '<span class="chiplet"><span class="method m-' + esc(mm) + '">' + esc(mm) + '</span><span class="mono small">' + esc(p.join(" ")) + "</span></span>"; }).join("") + "</div></div>";

    // 4. Risks.
    h += secHead("risks", "alert", "Risks", "What Veridic found in this module, each with a suggested fix and a prompt to hand to Claude.");
    const groups = GROUPS.map((g2) => ({ ...g2, items: g2.items.filter((f) => f.module === m.id) })).filter((g2) => g2.items.length);
    h += groups.length ? table(["Severity", "Problem", "Where"], groups.map((g2) => row([sevPill(g2.severity), '<div class="title">' + esc(g2.title) + '</div><div class="why">' + esc(g2.why) + "</div>", '<span class="pill bg-' + SEV[g2.severity].c + '">' + plural(g2.items.length, "place") + "</span>"], groupDetail(g2))))
      : '<div class="callout ok in">' + ic("check", "sm") + "<div><b>Nothing found.</b> No route here deletes or moves money without checking whose data it is, and no GET changes data.</div></div>";

    // 5. Neighbours: what it calls, what calls it.
    h += secHead("neighbours", "branch", "Neighbours", "The other modules this one depends on, and those that depend on it. Changing this module can break the ones that use it.");
    const nb = (list, empty0) => list.length ? '<table class="t"><tbody>' + list.map((u) => '<tr><td style="width:40%">' + ic("grid", "sm") + " " + modLink(u.module) + '</td><td class="small">' + u.via.slice(0, 3).map((f) => loc(f + ":1")).join("<br>") + (u.via.length > 3 ? '<div class="muted">+' + (u.via.length - 3) + " more</div>" : "") + "</td></tr>").join("") + "</tbody></table>" : '<div class="panel-b muted">' + empty0 + "</div>";
    h += '<div class="grid two"><div class="card in"><div class="panel-h">' + ic("ext", "sm") + "Uses<span class=\"sub\">code it calls in other modules</span></div>" + nb(m.uses, "Self-contained: it calls no other module's code.") + "</div>" +
      '<div class="card in"><div class="panel-h">' + ic("alert", "sm") + "Used by<span class=\"sub\">re-check these after a change</span></div>" + nb(m.usedBy, "No other module calls its code.") + "</div></div>";
    if (m.shared.length) h += '<details class="card in mt shared"><summary class="panel-h">' + ic("code", "sm") + "Shared code it relies on<span class=\"sub\">" + m.shared.length + " files most of the app uses (logging, auth, database)</span></summary><div class=\"panel-b small\" style=\"display:grid;gap:4px\">" + m.shared.map((f) => loc(f + ":1")).join("") + "</div></details>";

    // 6. Work on it.
    h += secHead("work", "wrench", "Work on it", "Three steps, so the change stays inside this module and is checked before it's called done.");
    const claimCmd = "veridic claim " + m.routes.map((x) => JSON.stringify(x)).join(" ");
    h += '<div class="steps in">' +
      step(1, "Claim it", "Tell Veridic what this task will change, so edits that leak into other modules get caught.", '<pre class="cmd">' + esc(claimCmd.length > 160 ? claimCmd.slice(0, 157) + "…" : claimCmd) + "</pre>" + btn("Copy command", claimCmd, "", "copy")) +
      step(2, "Read, then edit", "The code this module owns. Shared code is used across the app: change it only if you must.", '<div class="small" style="display:grid;gap:3px">' + filesOf(m).slice(0, 8).map((f) => loc(f + ":1")).join("") + (filesOf(m).length > 8 ? '<span class="muted">+' + (filesOf(m).length - 8) + " more</span>" : "") + "</div>") +
      step(3, "Check it's done", "Veridic checks the change stayed in the claim and every changed route has a test that asserts something.", '<pre class="cmd">veridic done</pre>' + btn("Copy command", "veridic done", "", "copy")) + "</div>" +
      '<div class="row-flex in mt">' + btn("Or copy all three as one prompt for Claude", promptTask(m), "primary", "sparkle") + "</div>";
    return h;
  }
  const secHead = (id, icon, t, sub) => '<div class="sechead in" id="sec-' + id + '"><h2>' + ic(icon, "sm") + t + "</h2><p>" + sub + "</p></div>";
  const step = (n, t, sub, body) => '<div class="card step"><div class="stepn">' + n + '</div><div style="min-width:0;flex:1"><div class="title">' + t + '</div><div class="muted small" style="margin:2px 0 10px">' + sub + "</div>" + body + "</div></div>";

  // ---- Specs: the spec documents, and the modules still without one ----
  function vSpec() {
    const sel = SPECS[state.spec] ? state.spec : 0;
    let h = head(ic("spec", "lg") + "Specs", "The written rules the code must follow, each tied to the lines that do it and the tests that check it.");
    const without = MODS.filter((m) => !m.specified);
    h += '<div class="split"><aside class="tree card in" aria-label="Specs">' +
      '<div class="tree-g">' + ic("spec", "sm") + 'Specs<span class="n">' + SPECS.length + "</span></div>" +
      (SPECS.length ? SPECS.map((s, i) => { const rs = specReqs(s), t = rs.filter(tested).length, st = rs.filter((r) => r.stale).length; return '<button class="node' + (i === sel ? " on" : "") + '" data-spec="' + i + '"><span class="nico">' + ic("file") + '</span><span class="nbody"><span class="nlabel">' + esc(specTitle(s)) + '</span><span class="nmeta">' + plural(rs.length, "rule") + " · " + pctOf(t, rs.length) + "% tested" + (st ? " · " + st + " changed" : "") + "</span>" + bar([{ c: "var(--ok)", p: pctOf(t, rs.length) }], true) + "</span></button>"; }).join("") : '<div class="tree-empty">None yet.</div>') +
      '<div class="tree-g">' + ic("grid", "sm") + 'Modules with no spec<span class="n">' + without.length + "</span></div>" +
      without.slice(0, 40).map((m) => { const r = riskOf(m); return '<button class="node" data-mod="' + esc(m.id) + '"><span class="nico">' + ic(r.i) + '</span><span class="nbody"><span class="nlabel">' + esc(m.name) + '</span><span class="nmeta">' + plural(m.stats.routes, "route") + (m.stats.money ? " · moves money" : "") + '</span></span><span class="dot tone-' + r.c + '"></span></button>'; }).join("") +
      '</aside><section class="pane">' + (SPECS.length ? specPane(SPECS[sel], sel) : empty("spec", "No spec yet", "A spec lists what a module must do, each rule tied to the code that does it. Open a module and use <b>Draft a spec from the code</b>; the riskiest modules are listed on the left.")) + "</section></div>";
    return h;
  }

  function specPane(s, si) {
    const rs = specReqs(s), other = s.requirements.filter((r) => !r.requirement), doc = s.doc || { meta: {}, stories: [], tables: [], notes: [] };
    const nT = rs.filter(tested).length, nStale = rs.filter((r) => r.stale).length, n = s.numbers || {};
    const seeds = [...String(doc.meta.seeds || "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    let h = '<div class="pane-h in"><div><div class="eyebrow">' + ic("spec", "sm") + '<span class="mono">' + esc(s.path) + "</span></div><h2>" + esc(specTitle(s)) + "</h2>" +
      (doc.meta.status ? '<div class="row-flex" style="margin-top:6px"><span class="pill bg-ok">' + ic("check", "sm") + "Status</span><span class=\"small\">" + md(doc.meta.status) + "</span></div>" : "") +
      (seeds.length ? '<div class="row-flex" style="margin-top:8px"><span class="muted small">Starts from</span>' + seeds.map((x) => '<span class="pill bg-info mono">' + esc(x) + "</span>").join("") + "</div>" : "") +
      "</div>" + btn("Copy prompt: close the gaps", promptSpec(s), "primary", "sparkle") + "</div>";
    h += '<div class="grid kpis">' + kpi("spec", "info", rs.length, "requirements") + kpiRing(nT, rs.length, "have a test", "flask") + kpiRing(rs.length - nStale, rs.length, "match the code", "code") +
      kpi("lock", n.citations_resolving_pct === 100 ? "ok" : "med", n.citations_resolving_pct != null ? n.citations_resolving_pct + "%" : "—", "of cited lines exist") + "</div>";
    // Who it is for: the user stories and their scenarios.
    if (doc.stories.length)
      h += '<h3 class="sec in">' + ic("user", "sm") + "What should happen</h3>" + doc.stories.map((st) => '<div class="card story in"><div class="row-flex">' + (st.priority ? '<span class="pill bg-violet">' + esc(st.priority) + "</span>" : "") + "<b>" + md(st.title) + "</b></div>" + (st.why ? '<div class="muted small" style="margin-top:4px">' + md(st.why) + "</div>" : "") +
        (st.scenarios.length ? '<div class="tablewrap"><table class="gwt"><thead><tr><th>Given</th><th>When</th><th>Then</th><th></th></tr></thead><tbody>' + st.scenarios.map((sc) => "<tr><td>" + md(sc.given) + "</td><td>" + md(sc.when) + "</td><td><b>" + md(sc.then) + "</b></td><td>" + sc.refs.map((r) => '<button class="pill bg-info mono linkbtn" data-req="' + esc(r) + '">' + esc(r) + "</button>").join(" ") + "</td></tr>").join("") + "</tbody></table></div>" : "") + "</div>").join("");
    // The requirements, by section (functional requirements, invariants, …).
    h += '<h3 class="sec in">' + ic("check", "sm") + "Requirements</h3>";
    h += chipRow("sf", [{ k: "all", t: "All", n: rs.length }, { k: "untested", t: "Needs a test", i: "minus", n: rs.length - nT }, { k: "stale", t: "Code changed", i: "changed", n: nStale }, { k: "tested", t: "Tested", i: "check", n: nT }], state.sf);
    const list = rs.filter((r) => match(r.id + " " + r.text) && (state.sf === "all" || (state.sf === "tested" ? tested(r) : state.sf === "untested" ? !tested(r) : r.stale)));
    const sections = [...new Set(list.map((r) => r.section || "Requirements"))];
    h += list.length ? sections.map((sec) => {
      const items = list.filter((r) => (r.section || "Requirements") === sec);
      const pg = paginate("spec" + si + sec, items);
      return (sections.length > 1 ? '<div class="subsec in">' + esc(sec) + ' <span class="n">' + items.length + "</span></div>" : "") +
        table(["ID", "Requirement", "Checks", "Test", "Code"], pg.items.map((r) => {
          const st = REQ[r.status] || REQ.none;
          return row([
            '<span class="mono" style="font-weight:700">' + esc(r.id) + "</span>" + (r.holds ? '<div style="margin-top:4px">' + pill("shield", r.holds === "yes" ? "Holds" : "Holds: " + r.holds, r.holds === "yes" ? "ok" : "high") + "</div>" : ""),
            '<div class="reqtext">' + md(r.text) + "</div>",
            r.checks && r.checks.length ? '<span class="pill bg-info" data-tip="Verification criteria">' + ic("check2", "sm") + r.checks.length + "</span>" : '<span class="muted">—</span>',
            pill(st.i, st.t, st.c),
            (r.stale ? pill("changed", "Changed", "med") : pill("check2", "Matches", "ok")) + ' <span class="muted small">' + plural(r.cites.length, "place") + "</span>",
          ], reqDetail(s, r), (r.stale || !tested(r) ? "attn " : "") + "req-" + cssId(r.id));
        }), pg.html);
    }).join("") : empty("search", "Nothing matches", "Try another filter or search.");
    // Tables the spec carries: decision tables, the state machine, risks.
    for (const t of doc.tables) {
      const icon = /decision/i.test(t.heading) ? "table" : /state/i.test(t.heading) ? "branch" : /risk|question/i.test(t.heading) ? "alert" : "file";
      const note = doc.notes.find((x) => x.section === t.section);
      h += '<div class="card in mt"><div class="panel-h">' + ic(icon, "sm") + md(t.heading) + "</div>" + (note ? '<div class="panel-note">' + md(note.text) + "</div>" : "") +
        '<div class="tablewrap"><table class="t plain"><thead><tr>' + t.header.map((c) => "<th>" + md(c) + "</th>").join("") + "</tr></thead><tbody>" + t.rows.map((r) => "<tr>" + r.map((c) => "<td>" + md(c) + "</td>").join("") + "</tr>").join("") + "</tbody></table></div></div>";
    }
    for (const x of doc.notes.filter((x) => !doc.tables.some((t) => t.section === x.section))) h += '<div class="callout info in mt">' + ic("file", "sm") + "<div><b>" + md(x.section) + ".</b> " + md(x.text) + "</div></div>";
    if (other.length) h += '<h3 class="sec in">' + ic("code", "sm") + "Other evidence in this spec</h3>" + table(["Section", "Code"], other.filter((r) => match(r.id + r.text)).map((r) => row(['<span class="title">' + md(r.id) + "</span>", (r.stale ? pill("changed", "Changed", "med") : pill("check2", "Matches", "ok")) + ' <span class="muted small">' + plural(r.cites.length, "place") + "</span>"], reqDetail(s, r, true))));
    return h;
  }
  function reqDetail(s, r, section) {
    let h = "";
    if (!section) {
      if (r.checks && r.checks.length) h += '<div class="row-flex" style="margin-bottom:8px"><b>' + ic("check2", "sm") + " What proves it</b></div><div class=\"vcs\">" + r.checks.map((v) => '<div class="vc"><span class="pill bg-info mono">' + esc(v.id) + "</span>" + md(v.text) + "</div>").join("") + "</div>";
      h += '<div class="row-flex" style="margin:12px 0 8px"><b>' + ic("flask", "sm") + " Checked by</b>" + (r.tests.length ? "" : '<span class="muted">no test yet</span>') + '<span class="sp"></span>' +
        (!tested(r) ? btn("Copy prompt: write the test", promptTest(s, r), "primary", "sparkle") : "") + (r.stale ? btn("Copy prompt: re-check it", promptStale(s, r), "", "changed") : "") + "</div>";
      if (r.tests.length) h += '<div style="display:grid;gap:4px;margin-bottom:14px">' + r.tests.map((t) => '<div class="row-flex">' + ic("check2", "sm tone-ok") + loc(t) + "</div>").join("") + "</div>";
    }
    h += '<div class="row-flex"><b>' + ic("code", "sm") + " Backed by this code</b>" + (r.stale ? '<span class="muted small">changed since the spec was written</span>' : "") + "</div>";
    h += r.cites.map((c) => '<div style="margin-top:10px"><div class="row-flex">' + (c.resolves ? ic("file", "sm") + loc(c.file + ":" + c.start + (c.end !== c.start ? "-" + c.end : "")) + openBtn(c.file + ":" + c.start) : ic("x", "sm tone-high") + '<span class="mono">' + esc(c.cite) + '</span><span class="tone-high small">' + esc(c.problem) + "</span>") + "</div>" + (c.code != null ? codeBlock(c) : "") + "</div>").join("");
    return h;
  }

  function vHealth() {
    const hi = F.filter((f) => f.severity === "high"), me = F.filter((f) => f.severity === "medium");
    const r = D.readiness || {};
    const tone = hi.length ? "high" : me.length ? "med" : "ok";
    const title = hi.length ? plural(hi.length, "high-risk issue") + " to fix" : me.length ? "No high-risk issues · " + me.length + " to review" : "All clear";
    const top = F.filter((f) => f.severity !== "low");
    let h = head(ic("health", "lg") + "Health", "The state of " + esc(D.name) + " at a glance: what its API does, how much is safe for agents, and how much the tests really check.");
    h += '<div class="verdict in tone-' + tone + '"><div class="big bg-' + tone + (hi.length ? " pulse" : "") + '">' + ic(hi.length ? "alert" : me.length ? "shield" : "check") + "</div><div><h2>" + title + "</h2><p>" +
      ["API", "Tests", "Spec", "Change"].map((a) => [a, F.filter((f) => f.area === a && f.severity !== "low").length]).filter((x) => x[1]).map((x) => plural(x[1], x[0] === "API" ? "API finding" : x[0].toLowerCase() + " finding")).join(" · ") +
      '</p></div><div class="right">' + (top.length ? btn("Copy prompt: fix all " + top.length, promptAll(top), "primary", "sparkle") : "") + '<button class="btn" data-chip="sub" data-v="findings">' + ic("alert", "sm") + "See all findings</button></div></div>";
    const writes = (r.writes || 0) + (r.destructive || 0);
    h += '<div class="grid kpis">' + kpi("route", "info", ROUTES.length, "routes · " + writes + " change data, " + (r.destructive || 0) + " delete") + kpi("coins", (r.move_money ? "high" : "ok"), r.move_money || 0, "routes move money") +
      kpiRing(ROUTES.length - new Set(top.filter((f) => f.area === "API").map((f) => f.where)).size, ROUTES.length, "routes safe for AI agents", "shield") +
      (T ? kpiRing(T.strong + T.weak, T.tests, "tests check something", "flask") : "") + "</div>";
    // Left: fix first. Right: what the API does, and who can call it.
    const g = GROUPS.filter((x) => x.severity !== "low").slice(0, 6);
    const fixFirst = '<div class="card in"><div class="panel-h">' + ic("wrench", "sm") + 'Fix first<span class="sub">grouped by kind</span></div>' +
      (g.length ? '<table class="t"><tbody>' + g.map((x) => '<tr class="row" data-group="' + esc(x.key) + '"><td style="width:34px">' + icoBox(AREA[x.area] ? AREA[x.area].i : "alert", SEV[x.severity].c, AREA[x.area] ? AREA[x.area].t : x.area) + '</td><td><div class="title">' + esc(x.title) + '</div><div class="why">' + esc(x.why) + '</div></td><td class="num"><span class="pill bg-' + SEV[x.severity].c + '">' + x.items.length + "</span></td><td>" + ic("chev", "sm chev") + "</td></tr>").join("") + "</tbody></table>"
        : '<div class="empty"><div class="big bg-ok">' + ic("check") + "</div><h3>Nothing high or medium</h3></div>") + "</div>";
    const eff = [{ k: "read", c: "var(--info)" }, { k: "write", c: "var(--med)" }, { k: "destructive", c: "var(--high)" }].map((x) => ({ ...x, v: ROUTES.filter((rt) => rt.effect === x.k).length }));
    const acc = ["public", "auth", "role"].map((k) => ({ k, v: ROUTES.filter((rt) => rt.access === k).length }));
    const maxA = Math.max(1, ...acc.map((a) => a.v));
    const what = '<div class="card in"><div class="panel-h">' + ic("route", "sm") + 'What the API does</div><div class="panel-b"><div class="donutwrap">' + donut(eff.map((e) => ({ v: e.v, c: e.c })), 132, String(ROUTES.length), "routes") +
      '<div class="hbars" style="flex:1;min-width:180px">' + eff.map((e) => '<div class="hbar">' + icoBox(EFF[e.k].i, EFF[e.k].c) + '<div><div class="name">' + EFF[e.k].t + "</div>" + bar([{ c: e.c, p: pctOf(e.v, ROUTES.length) }], true) + '</div><div class="val">' + e.v + "</div></div>").join("") + "</div></div>" +
      '<div class="panel-h" style="padding:16px 0 10px;border:0">' + ic("user", "sm") + "Who can call them</div><div class=\"hbars\">" + acc.map((a) => '<div class="hbar">' + icoBox(ACC[a.k].i, ACC[a.k].c) + '<div><div class="name">' + ACC[a.k].t + "</div>" + bar([{ c: "var(--" + ACC[a.k].c + ")", p: pctOf(a.v, maxA) }], true) + '</div><div class="val">' + a.v + "</div></div>").join("") + "</div></div></div>";
    h += '<div class="grid two">' + fixFirst + what + "</div>";
    if (SPECS.length) {
      const all = SPECS.flatMap(specReqs);
      h += '<div class="card in mt"><div class="panel-h">' + ic("spec", "sm") + "Specs<span class=\"sub\">" + (D.coverage && D.coverage.coverage_pct != null ? D.coverage.coverage_pct + "% of routes are covered by a spec" : "") + '</span><span class="right"><button class="btn" data-nav="spec">' + ic("spec", "sm") + 'Open spec</button></span></div><div class="panel-b">' +
        bar([{ c: "var(--ok)", p: pctOf(all.filter(tested).length, all.length) }, { c: "var(--med)", p: pctOf(all.filter((x) => !tested(x)).length, all.length) }]) +
        '<div class="legend"><span><i class="dot tone-ok"></i>' + all.filter(tested).length + " tested</span><span><i class=\"dot tone-med\"></i>" + all.filter((x) => !tested(x)).length + " need a test</span><span>" + ic("changed", "sm") + all.filter((x) => x.stale).length + " changed since written</span></div></div></div>";
    }
    if (D.errors && D.errors.length) h += '<div class="card in mt"><div class="panel-h">' + ic("alert", "sm tone-med") + "Couldn't check</div><div class=\"panel-b muted\">" + D.errors.map(esc).join("<br>") + "</div></div>";
    return h;
  }

  function vFindings() {
    const areas = ["all", ...new Set(F.map((f) => f.area))];
    const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((f) => state.sev.includes(f.severity) && (state.area === "all" || f.area === state.area) && match(g.title + " " + f.where + " " + f.text)) })).filter((g) => g.items.length);
    const shown = groups.flatMap((g) => g.items);
    let h = head(ic("alert", "lg") + "Findings", "What needs a look, grouped by kind. Open one to see every place it happens, the suggested fix, and a prompt to hand to Claude.", shown.length ? btn("Copy prompt: fix these " + shown.length, promptAll(shown.slice(0, 60)), "primary", "sparkle") : "");
    h += '<div class="row-flex" style="gap:14px;flex-wrap:wrap">' + chipRow("sev", ["high", "medium", "low"].map((s) => ({ k: s, t: SEV[s].t, n: F.filter((f) => f.severity === s).length })), state.sev) +
      chipRow("area", areas.map((a) => ({ k: a, t: a === "all" ? "All areas" : a, i: AREA[a] ? AREA[a].i : null, n: a === "all" ? null : F.filter((f) => f.area === a).length })), state.area) + "</div>";
    if (!groups.length) return h + empty("check", "Nothing here", "No findings match these filters.");
    const pg = paginate("findings", groups);
    h += table(["Severity", "Problem", "Area", "Where"], pg.items.map((g) => row([
      sevPill(g.severity),
      '<div class="title">' + esc(g.title) + '</div><div class="why">' + esc(g.why) + "</div>",
      AREA[g.area] ? labelled({ i: AREA[g.area].i, t: AREA[g.area].t, c: "low" }) : esc(g.area),
      '<span class="pill bg-' + SEV[g.severity].c + '">' + plural(g.items.length, "place") + "</span>",
    ], groupDetail(g), "grp-" + cssId(g.key))), pg.html);
    return h;
  }
  const cssId = (s) => s.replace(/[^\w-]/g, "_");
  function groupDetail(g) {
    let h = g.fix ? '<div class="fixbox">' + ic("wrench", "sm") + "<div><b>Suggested fix.</b> " + esc(g.fix) + "</div></div>" : "";
    h += '<div class="row-flex mt" style="margin-top:12px"><b>' + plural(g.items.length, "place") + '</b><span class="sp"></span>' + btn("Copy prompt: fix all " + g.items.length, g.items.length === 1 ? promptFor(g.items[0]) : promptAll(g.items), "primary", "sparkle") + "</div>";
    h += '<table class="subt"><tbody>' + g.items.slice(0, 200).map((f) => {
      const ev = (f.evidence || []).filter(Boolean);
      const first = ev.find((e) => LOC.test(e)) || (LOC.test(f.where) ? f.where : null);
      return "<tr><td>" + (LOC.test(f.where) ? loc(f.where) : '<span class="mono" style="font-weight:600">' + esc(f.where) + "</span>") + '<div class="muted small">' + esc(f.text) + "</div>" + (ev.length ? '<div class="small" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:3px">' + ev.map(loc).join("") + "</div>" : "") +
        '</td><td style="width:90px;text-align:right;white-space:nowrap">' + iconBtn("sparkle", "Copy fix prompt", promptFor(f)) + (first ? openBtn(first) : "") + "</td></tr>";
    }).join("") + "</tbody></table>";
    return h;
  }

  function vRoutes() {
    if (!ROUTES.length) return head(ic("route", "lg") + "Routes", "") + empty("route", "No routes found", "Run <code>veridic init</code> in the repo so Veridic can index the code.");
    const has = (rt) => issuesByRoute.has(rt.id);
    const F_ = { all: () => true, write: (rt) => rt.effect !== "read", destructive: (rt) => rt.effect === "destructive", money: (rt) => rt.moves_money, public: (rt) => rt.access === "public", issues: has };
    const list = ROUTES.filter((rt) => F_[state.rf](rt) && match(rt.id + " " + rt.handler));
    let h = head(ic("route", "lg") + "Routes", "Every route the app serves: what it really does (traced through the code it calls), who can call it, and whether it checks the data is the caller's own.");
    h += chipRow("rf", [
      { k: "all", t: "All", n: ROUTES.length },
      { k: "issues", t: "Has issues", i: "alert", n: ROUTES.filter(has).length },
      { k: "write", t: "Changes data", i: "pencil", n: ROUTES.filter(F_.write).length },
      { k: "destructive", t: "Deletes", i: "trash", n: ROUTES.filter(F_.destructive).length },
      { k: "money", t: "Moves money", i: "coins", n: ROUTES.filter(F_.money).length },
      { k: "public", t: "Anyone can call", i: "globe", n: ROUTES.filter(F_.public).length },
    ], state.rf);
    if (!list.length) return h + empty("search", "Nothing matches", "Try another filter or search.");
    const pg = paginate("routes", list);
    h += table(["Method", "Path", "Does", "Who can call", "Whose data", "Issues"], pg.items.map((rt) => {
      const iss = issuesByRoute.get(rt.id) || [];
      const e = EFF[rt.effect] || EFF.read;
      const own = rt.access === "public" && rt.effect === "read" ? null : OWN[rt.scoped];
      return row([
        '<span class="method m-' + esc(rt.method) + '">' + esc(rt.method) + "</span>",
        '<span class="path">' + esc(rt.path) + "</span>",
        '<span class="cellicons">' + icoBox(e.i, e.c, e.t) + (rt.moves_money ? icoBox("coins", "high", "Moves money") : "") + (rt.notifies ? icoBox("bell", "violet", "Sends a notification") : "") + (rt.external ? icoBox("cloud", "info", "Calls an outside service") : "") + "</span>",
        ACC[rt.access] ? icoBox(ACC[rt.access].i, ACC[rt.access].c, ACC[rt.access].t) + ' <span class="muted small hide-sm">' + ACC[rt.access].t + "</span>" : esc(rt.access),
        own ? icoBox(own.i, own.c, own.t) : '<span class="muted">—</span>',
        iss.length ? '<span class="pill bg-' + SEV[iss.reduce((a, f) => (rank(f.severity) < rank(a) ? f.severity : a), "low")].c + '">' + ic("alert", "sm") + iss.length + "</span>" : '<span class="tone-ok">' + ic("check2", "sm") + "</span>",
      ], routeDetail(rt, iss), iss.length ? "attn" : "");
    }), pg.html);
    return h;
  }
  function routeDetail(rt, iss) {
    const e = EFF[rt.effect] || EFF.read;
    let h = '<div class="row-flex">' + labelled(e) + (rt.moves_money ? labelled({ i: "coins", t: "Moves money", c: "high" }) : "") + (ACC[rt.access] ? labelled(ACC[rt.access]) : "") + (OWN[rt.scoped] ? labelled(OWN[rt.scoped]) : "") + '<span class="sp"></span>' + ic("code", "sm") + loc(rt.handler) + openBtn(rt.handler) + "</div>";
    if (iss.length) h += iss.map((f) => '<div class="fixbox mt" style="background:var(--' + SEV[f.severity].c + '-soft)">' + ic("alert", "sm tone-" + SEV[f.severity].c) + '<div style="flex:1"><b>' + esc(f.title) + ".</b> " + esc(f.why) + (f.fix ? '<div class="small" style="margin-top:4px"><b>Fix:</b> ' + esc(f.fix) + "</div>" : "") + "</div>" + iconBtn("sparkle", "Copy fix prompt", promptFor(f)) + "</div>").join("");
    h += '<div class="row-flex mt" style="margin-top:12px"><b>' + ic("eye", "sm") + " Why Veridic says it " + e.t.toLowerCase() + "</b></div>";
    h += rt.evidence.length ? '<table class="subt"><tbody>' + rt.evidence.map((x) => "<tr><td style=\"width:130px\"><span class=\"pill bg-low\">" + esc(x.kind.replace(/_/g, " ")) + "</span></td><td>" + loc(x.at) + (x.via ? ' <span class="muted small">via ' + esc(x.via) + "</span>" : "") + "</td></tr>").join("") + "</tbody></table>" : '<div class="muted small" style="margin-top:6px">Nothing it calls writes, deletes, or calls out.</div>';
    return h;
  }

  function vTests() {
    if (!T) return head(ic("flask", "lg") + "Tests", "") + empty("flask", "No tests found", "Veridic looks for *.test.* and *.spec.* files.");
    const nothing = T.unasserted + T.empty;
    let h = head(ic("flask", "lg") + "Tests", "Whether the tests really check anything. A test that asserts nothing passes even when the code is broken.");
    const segs = [{ k: "strong", t: "Check real values", v: T.strong, c: "var(--ok)" }, { k: "weak", t: "Only loose checks", v: T.weak, c: "var(--med)" }, { k: "nothing", t: "Check nothing", v: nothing, c: "var(--high)" }, { k: "skipped", t: "Skipped", v: T.skipped, c: "var(--faint)" }];
    h += '<div class="grid two"><div class="card in"><div class="panel-h">' + ic("flask", "sm") + T.tests.toLocaleString() + ' tests in ' + T.test_files + ' files</div><div class="panel-b"><div class="donutwrap">' + donut(segs.map((s) => ({ v: s.v, c: s.c })), 150, pctOf(T.strong + T.weak, T.tests) + "%", "check something") +
      '<div class="hbars" style="flex:1;min-width:200px">' + segs.map((s) => '<div class="hbar"><span class="dot" style="color:' + s.c + ';justify-self:center"></span><div><div class="name">' + s.t + "</div>" + bar([{ c: s.c, p: pctOf(s.v, T.tests) }], true) + '</div><div class="val">' + s.v.toLocaleString() + "</div></div>").join("") + "</div></div></div></div>" +
      '<div class="card in"><div class="panel-h">' + ic("wrench", "sm") + 'What to do</div><div class="panel-b" style="display:grid;gap:12px">' +
      [["x", "high", "Fix tests that check nothing first", "They give false confidence: green even when the code is broken."], ["minus", "med", "Then tighten loose checks", "Swap toBeDefined / toHaveBeenCalled() for the actual value or arguments."], ["check", "ok", "Name tests after requirements", "Put the requirement id (FR-001) in the title, so the spec shows it as tested."]]
        .map((x) => '<div class="row-flex" style="align-items:flex-start;flex-wrap:nowrap">' + icoBox(x[0], x[1]) + "<div><b>" + x[2] + '</b><div class="muted small">' + x[3] + "</div></div></div>").join("") + "</div></div></div>";
    const fl = D.tests.flagged || {};
    const rows = [...(fl.empty || []).map((t) => ({ ...t, k: "empty test" })), ...(fl.unasserted || []).map((t) => ({ ...t, k: "test asserts nothing" })), ...(fl.weak || []).map((t) => ({ ...t, k: "weak test" }))].filter((t) => match(t.at + " " + t.title));
    let pgT;
    if (rows.length) {
      const TK = { "empty test": ["x", "high", "Empty"], "test asserts nothing": ["x", "high", "Checks nothing"], "weak test": ["minus", "med", "Loose checks"] };
      h += '<h3 class="sec in">Tests to fix</h3>' + '<div class="card in"><div class="tablewrap"><table class="t"><thead><tr><th>Status</th><th>Test</th><th>Where</th><th></th></tr></thead><tbody>' +
        (pgT = paginate("tests", rows)).items.map((t) => { const k = TK[t.k]; const f = F.find((x) => x.where === t.at) || { area: "Tests", where: t.at, text: t.title, fix: "", why: "" }; return "<tr><td>" + pill(k[0], k[2], k[1]) + '</td><td class="title">' + esc(t.title) + "</td><td>" + loc(t.at) + '</td><td style="text-align:right;white-space:nowrap">' + iconBtn("sparkle", "Copy fix prompt", promptFor(f)) + openBtn(t.at) + "</td></tr>"; }).join("") + "</tbody></table></div>" + pgT.html + "</div>";
    }
    return h;
  }

  function vChange() {
    const c = D.change;
    let h = head(ic("branch", "lg") + "Current change", "Your uncommitted work, checked against what the task claimed: did it stay in scope, and is every changed route tested?");
    h += '<div class="verdict in tone-' + (c.done ? "ok" : "high") + '"><div class="big bg-' + (c.done ? "ok" : "high pulse") + '">' + ic(c.done ? "check" : "x") + "</div><div><h2>" + (c.done ? "Done" : "Not done yet") + "</h2><p>" +
      (c.done ? "It stays within its claim, and the changed routes have tests that check them." : plural(c.problems.length, "thing") + " to finish before calling it done.") + '</p></div><div class="right">' +
      (c.problems.length ? btn("Copy prompt: finish it", "Finish the current change in " + D.name + ". `veridic done` reports:\n\n" + c.problems.map((p) => "- " + p).join("\n") + "\n\nFix each, then run `veridic done` again until it says DONE.", "primary", "sparkle") : "") + "</div></div>";
    h += '<div class="card in" style="padding:14px 16px;margin-bottom:14px"><div class="row-flex"><b>' + ic("lock", "sm") + " Claimed</b>" + (c.claims.length ? c.claims.map((x) => '<span class="pill bg-info mono">' + esc(x) + "</span>").join("") : '<span class="muted">nothing yet: run <code>veridic claim &lt;route&gt;</code> before editing, so stray edits can be caught</span>') + "</div></div>";
    if (c.problems.length) h += '<div class="card in" style="margin-bottom:14px"><table class="t"><tbody>' + c.problems.map((p) => { const k = p.split(":")[0]; return "<tr><td style=\"width:40px\">" + icoBox(k === "stray" ? "branch" : k === "untested" ? "flask" : "alert", "high") + "</td><td>" + esc(p) + "</td></tr>"; }).join("") + "</tbody></table></div>";
    h += '<div class="card in"><div class="tablewrap"><table class="t"><thead><tr><th>Changed file</th><th>Routes it reaches</th><th>Tests that reach it</th><th>Status</th></tr></thead><tbody>' +
      c.files.map((f) => "<tr><td>" + loc(f.file + ":1") + "</td><td>" + ((f.routes || []).slice(0, 6).map((r) => '<div class="mono small">' + esc(r) + "</div>").join("") || '<span class="muted">none</span>') + (f.routes && f.routes.length > 6 ? '<div class="muted small">+' + (f.routes.length - 6) + " more</div>" : "") + "</td><td>" + ((f.tests || []).slice(0, 4).map((t) => "<div>" + loc(t + ":1") + "</div>").join("") || '<span class="muted">none</span>') + "</td><td>" +
        ((f.untested_routes || []).length ? pill("minus", "Untested: " + f.untested_routes.length, "high") : f.in_seam === false ? pill("branch", "Outside claim", "high") : pill("check2", "OK", "ok")) + "</td></tr>").join("") + "</tbody></table></div></div>";
    return h;
  }

  // App overview: the app-wide numbers, and everything across all modules for power users.
  function vOverview() {
    const subs = [{ k: "summary", t: "Summary", i: "health" }, { k: "findings", t: "All findings", i: "alert", n: F.filter((f) => f.severity !== "low").length }, { k: "routes", t: "All routes", i: "route", n: ROUTES.length }, { k: "tests", t: "All tests", i: "flask", n: T ? T.tests : null }];
    const body = { summary: vHealth, findings: vFindings, routes: vRoutes, tests: vTests }[state.sub] || vHealth;
    return chipRow("sub", subs, state.sub) + body();
  }
  const VIEWS = { modules: vModules, module: vModule, spec: vSpec, overview: vOverview, change: vChange };

  // ---- shell and rendering ----
  const ago = (iso) => { const s = (Date.now() - new Date(iso)) / 1000; return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; };
  function shell() {
    $("#app").innerHTML = '<div class="shell"><aside class="side"><div class="logo"><div class="mark">' + ic("logo") + "</div><span>Veridic</span></div><nav id=\"nav\"></nav><div class=\"modlist\" id=\"modlist\"></div>" +
      '<div class="foot"><div><kbd>1</kbd>–<kbd>' + NAV.length + "</kbd> switch view</div><div><kbd>/</kbd> search · <kbd>t</kbd> theme</div><div>" + ic("lock", "sm") + " Local file · nothing uploaded</div></div></aside>" +
      '<div class="content"><div class="top"><div class="crumb"><span class="repo">' + esc(D.name) + '</span><span class="when" title="' + esc(new Date(D.generated).toLocaleString()) + '">' + ic("clock", "sm") + esc(ago(D.generated)) + "</span></div>" +
      '<label class="search">' + ic("search", "sm") + '<input id="q" placeholder="Search modules, routes, rules…" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>' +
      '<select class="pick hide-sm" id="editor" title="Where file links open"><option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="none">No editor links</option></select>' +
      '<button class="iconbtn" id="refresh" data-tip="Copy the command that refreshes this report"></button><button class="iconbtn" id="theme" aria-label="Toggle light or dark"></button></div><main id="main"></main></div></div>';
    $("#editor").value = ED;
    $("#refresh").innerHTML = ic("refresh");
  }
  function nav() {
    const cur = state.view === "module" ? "modules" : state.view;
    $("#nav").innerHTML = NAV.map((n, i) => '<button class="navbtn" data-nav="' + n.k + '" title="' + n.t + " (" + (i + 1) + ')"' + (n.k === cur ? ' aria-current="page"' : "") + ">" + ic(n.i) + "<span>" + n.t + "</span>" + (n.n ? '<span class="count' + (n.hot ? " hot" : "") + '">' + n.n.toLocaleString() + "</span>" : "") + "</button>").join("");
    // Every module, one click away from anywhere.
    const ms = D.modules || [];
    $("#modlist").innerHTML = ms.length ? '<div class="tree-g">' + ic("grid", "sm") + "Modules</div>" + ms.map((m) => {
      const r = riskOf(m).c;
      return '<button class="modlink' + (state.view === "module" && state.mod === m.id ? " on" : "") + '" data-mod="' + esc(m.id) + '"><span class="dot tone-' + r + '"></span><span class="ml">' + esc(m.name) + '</span><span class="mc">' + m.stats.routes + "</span></button>";
    }).join("") : "";
  }
  function render(keepScroll) {
    CLIP.length = 0;
    rowSeq = 0;
    $("#main").innerHTML = VIEWS[state.view]();
    $$("#main .in").forEach((el, i) => (el.style.animationDelay = Math.min(i, 10) * 35 + "ms"));
    animate();
    if (state.openGroup) {
      const r = $("#main tr.grp-" + cssId(state.openGroup));
      if (!r && state.view === "overview") {
        const i = GROUPS.findIndex((g) => g.key === state.openGroup);
        if (i >= 0 && state.pages.findings !== Math.floor(i / PAGE)) { state.pages.findings = Math.floor(i / PAGE); return render(keepScroll); }
      }
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
    $("#q").value = "";
    try { history.pushState(null, "", "#" + (k === "module" ? "module/" + encodeURIComponent(state.mod) : k)); } catch {}
    nav();
    render();
  }
  const openModule = (id, jump) => { state.mod = id; state.jump = jump || null; setView("module"); };
  window.addEventListener("popstate", () => { Object.assign(state, { view: "modules", mod: null, jump: null }, fromHash()); state.q = ""; state.pages = {}; $("#q").value = ""; nav(); render(); });
  function animate() {
    requestAnimationFrame(() => {
      $$("#main [data-w]").forEach((el) => (el.style.width = el.dataset.w + "%"));
      $$("#main [data-dash]").forEach((el) => el.setAttribute("stroke-dasharray", el.dataset.dash));
    });
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    $$("#main [data-count]").forEach((el) => {
      const to = Number(el.dataset.count), suf = el.dataset.suffix || "", dec = String(to).includes(".") ? 1 : 0;
      if (reduce || !isFinite(to)) { el.textContent = (isFinite(to) ? to.toLocaleString() : el.dataset.count) + suf; return; }
      const t0 = performance.now(), dur = 700;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur), v = to * (1 - Math.pow(1 - k, 3)); el.textContent = (dec ? v.toFixed(1) : Math.round(v).toLocaleString()) + suf; if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }
  function toggle(tr) {
    const d = document.getElementById(tr.dataset.d);
    if (!d) return;
    d.hidden = !d.hidden;
    tr.classList.toggle("open", !d.hidden);
  }
  // Theme: the system's by default; the toggle pins light or dark.
  const effective = () => { const t = store.get("theme"); return t === "light" || t === "dark" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; };
  function applyTheme() {
    const t = store.get("theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
    $("#theme").innerHTML = ic(effective() === "dark" ? "sun" : "moon");
    $("#theme").setAttribute("data-tip", effective() === "dark" ? "Light mode" : "Dark mode");
  }
  const toastEl = $("#toast");
  function toast(msg) { toastEl.innerHTML = ic("check2", "sm") + esc(msg); toastEl.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => toastEl.classList.remove("on"), 1800); }
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
    if (md0) { openModule(md0.dataset.mod); return; }
    const sp = t.closest("[data-spec]");
    if (sp) { state.spec = +sp.dataset.spec; state.sf = "all"; if (state.view !== "spec") setView("spec"); else { state.pages = {}; render(); } return; }
    const jp = t.closest("[data-jump]");
    if (jp) { e.preventDefault(); const el = document.getElementById("sec-" + jp.dataset.jump); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    if (t.closest("[data-more]")) { state.aboutOpen = !state.aboutOpen; render(true); return; }
    const rq = t.closest("[data-req]");
    if (rq) { state.sf = "all"; state.q = ""; $("#q").value = ""; render(true); const r = $("#main tr.req-" + cssId(rq.dataset.req)); if (r) { if (r.classList.contains("open") === false) toggle(r); r.scrollIntoView({ block: "center", behavior: "smooth" }); r.classList.add("flash"); setTimeout(() => r.classList.remove("flash"), 1400); } return; }
    const pg = t.closest("[data-page]");
    if (pg) { if (pg.disabled) return; state.pages[pg.dataset.page] = +pg.dataset.p; render(true); const m = $("#main .tablewrap"); if (m) m.closest(".card").scrollIntoView({ block: "start", behavior: "smooth" }); return; }
    const n = t.closest("[data-nav]");
    if (n) { setView(n.dataset.nav); return; }
    const ch = t.closest("[data-chip]");
    if (ch) {
      const name = ch.dataset.chip, v = ch.dataset.v;
      if (name === "sev") state.sev = state.sev.includes(v) ? state.sev.filter((x) => x !== v) : [...state.sev, v];
      else if (name === "spec") (state.spec = +v), (state.sf = "all");
      else state[name] = v;
      state.pages = {};
      render(true);
      return;
    }
    const g = t.closest("[data-group]");
    if (g) { state.openGroup = g.dataset.group; state.sev = ["high", "medium", "low"]; state.area = "all"; state.sub = "findings"; setView("overview"); return; }
    if (t.closest("a, button, select, input, label, pre")) return;
    const tr = t.closest("tr.row[data-d]");
    if (tr) toggle(tr);
  });
  $("#q").addEventListener("input", (e) => { state.q = e.target.value; state.pages = {}; render(true); });
  document.addEventListener("change", (e) => { if (e.target.matches("[data-size]")) { PAGE = Number(e.target.value); store.set("page-size", PAGE); state.pages = {}; render(true); } });
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
    else if (/^[1-9]$/.test(e.key) && NAV[+e.key - 1]) setView(NAV[+e.key - 1].k);
  });
})();
