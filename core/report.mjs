// The report: everything Veridic knows about a repo, gathered once and rendered as
// one self-contained HTML page (no server, no network, no LLM). Tabs: overview,
// specs (requirements with their cited code, tests and freshness), routes (what
// each really does and who can call it), findings (each with a suggested fix),
// tests (what they check), and the change in progress (claim, strays, untested).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openGraph } from "./graph.mjs";
import { routeInventory } from "./routes.mjs";
import { effectManifest, readiness } from "./effects.mjs";
import { auditTests, testCoverage } from "./tests.mjs";
import { metrics, defaultSpecs, isSpecFile } from "./metrics.mjs";
import { checkCitations, repoFiles } from "./citations.mjs";
import { screenGroups } from "./screens.mjs";
import { staleness } from "./staleness.mjs";
import { doneWithoutSpec, loadClaim } from "./seam.mjs";
import { findModules } from "./modules.mjs";
import { linkUi } from "./ui.mjs";
import { findTables, routeData, dataByModule } from "./data.mjs";
import { modularity, duplication } from "./structure.mjs";
import { testsReaching } from "./tests.mjs";

const MAX_SNIPPET = 40; // lines of cited code shown per citation

// What to do about each kind of finding. Deterministic: the same finding always
// gets the same advice; the evidence lines say where.
export const FIXES = {
  "get-that-writes": "Make it a POST/PUT/DELETE, or move the write out of the GET. Crawlers, prefetchers and AI agents treat GET as safe to call.",
  "money-not-scoped": "Load the order/payment with the caller's id in the query (e.g. where: { id, userId: req.user.id }) before moving money.",
  "user-id-from-url": "Use the signed-in user's id (req.user.id) instead of the one in the URL, or reject when they differ.",
  "identity-from-request-body": "Take who the action is for from the session, not the request body; ignore or reject a body field that names another user.",
  "id-param-without-caller-scope": "Scope the lookup to the caller (where: { id, ownerId: caller }) or add an ownership guard before acting on the id.",
  "id-param-scoped-by-client-values": "The ids that scope this come from the client; derive them from the session instead.",
  "policy-mismatch": "The guard on this route disagrees with the intended access policy: change the guard, or update the policy if the code is right.",
  unasserted: "This test runs code but checks nothing, so it passes even when the code is broken. Add an assertion on what its title promises.",
  empty: "This test has no body. Write it, or remove it.",
  weak: "Only loose checks (toBeDefined, toBeTruthy, called at all). Assert the actual value or arguments.",
  stray: "This change edits code another route runs. Revert it, or claim that route too (veridic claim) if it belongs to the task.",
  untested: "No asserting test reaching this code names the route or the changed function. Add one before calling it done.",
  stale: "The cited code changed since the spec was written. Re-read it and update the requirement (veridic stale --fix moves citations that only shifted).",
  unresolved: "This citation doesn't resolve to code. Fix the path or line range.",
};

// Each kind of finding in plain words: a title anyone can read, and why it matters.
export const KINDS = {
  "get-that-writes": { title: "GET request changes data", why: "Browsers prefetch GETs, crawlers follow them and AI agents call them freely, so data can change by accident." },
  "money-not-scoped": { title: "Moves money on IDs it doesn't check", why: "A signed-in user could pay, refund or move money on someone else's order." },
  "user-id-from-url": { title: "Trusts the user ID in the URL", why: "Anyone signed in can read or change another user's data by editing the URL." },
  "identity-from-request-body": { title: "Trusts who it's for from the request body", why: "A caller can act as, or for, someone else by sending their ID." },
  "id-param-without-caller-scope": { title: "Acts on any record by ID", why: "It never checks the record belongs to the caller, so knowing or guessing an ID is enough." },
  "id-param-scoped-by-client-values": { title: "Checks ownership with values the client sends", why: "The values meant to prove ownership come from the client, who can send anyone's." },
  "policy-mismatch": { title: "Access differs from the intended policy", why: "Who can call this route isn't who the access policy says should." },
  "test asserts nothing": { title: "Test checks nothing", why: "It runs the code but asserts nothing, so it passes even when the code is broken." },
  "empty test": { title: "Empty test", why: "It has no body, so it tests nothing." },
  "weak test": { title: "Test only checks loosely", why: "Checks like toBeDefined or toHaveBeenCalled() pass for almost any value." },
  "stale requirement": { title: "Spec out of date with the code", why: "The code this requirement cites changed after the spec was written." },
  "citation doesn't resolve": { title: "Spec points at code that isn't there", why: "The cited file or lines don't exist, so the requirement can't be checked." },
  "stray edit": { title: "Edit outside the task", why: "The change touches code another route runs, which the task didn't claim." },
  untested: { title: "Changed code without a test", why: "No asserting test that reaches the change names the route or the changed function." },
  "a changed test asserts nothing": { title: "New or changed test checks nothing", why: "The test added with this change asserts nothing, so it can't catch a regression." },
};

const readLines = (repo, file) => {
  try {
    return fs.readFileSync(path.join(repo, file), "utf8").split("\n");
  } catch {
    return null;
  }
};

// The parts of a spec a reader needs, from its Markdown: title and status, user
// stories with their scenarios, each requirement's section and verification
// checks, and its tables (decision tables, state machine, risks).
const REQ_ID = "(?:FR|SC|NFR|R|AC|INV|D)-?\\d+[a-z]?";
export function specDoc(text) {
  const lines = text.split("\n");
  const doc = { title: null, meta: {}, stories: [], tables: [], notes: [], reqs: {} };
  let h2 = null, h3 = null, cur = null, story = null;
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = l.match(/^#\s+(.*)/))) { doc.title = m[1].replace(/^(?:feature\s+)?spec(?:ification)?\s*:\s*/i, "").trim(); continue; }
    if ((m = l.match(/^##\s+(.*)/))) { h2 = m[1].trim(); h3 = null; cur = null; story = null; continue; }
    if ((m = l.match(/^###\s+(.*)/))) {
      h3 = m[1].trim();
      cur = null;
      const st = h3.match(/^user story\s*(\d+)\s*[-–:]\s*(.*?)\s*(?:\(priority:\s*(P\d)\))?\s*$/i);
      story = st ? { n: Number(st[1]), title: st[2], priority: st[3] ?? null, why: "", scenarios: [] } : null;
      if (story) doc.stories.push(story);
      continue;
    }
    // Before the first section: "**Status**: … · **Seeds**: …".
    if (!h2) {
      for (const mm of l.matchAll(/\*\*([\w ]+)\*\*:\s*([^·]+)/g)) doc.meta[mm[1].trim().toLowerCase()] = mm[2].trim();
      continue;
    }
    if (/^\s*\|/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const header = cells(l), rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      doc.tables.push({ heading: h3 ?? h2, section: h2, header, rows });
      continue;
    }
    if (story) {
      if ((m = l.match(/^\*\*why this priority\*\*:\s*(.*)/i))) story.why = m[1].trim();
      else if ((m = l.match(/^\s*\d+\.\s*\*\*given\*\*\s*(.*?),?\s*\*\*when\*\*\s*(.*?),?\s*\*\*then\*\*\s*(.*)$/i))) {
        const refs = [...m[3].matchAll(new RegExp(REQ_ID, "g"))].map((x) => x[0]);
        story.scenarios.push({ given: m[1].trim(), when: m[2].trim(), then: m[3].replace(new RegExp(`\\s*\\((?:${REQ_ID}(?:,\\s*)?)+\\)\\s*$`), "").trim(), refs });
      }
      continue;
    }
    if ((m = l.match(new RegExp(`^\\s*[-*]\\s*\\*\\*(${REQ_ID})\\*\\*\\s*(?:\\(holds:\\s*([\\w-]+)\\))?`)))) { cur = m[1]; doc.reqs[cur] = { section: h3 ?? h2, holds: m[2] ?? null, vcs: [] }; continue; }
    if (cur && (m = l.match(/^\s+[-*]\s*(VC\d+)\.\s*(.*)/))) { doc.reqs[cur].vcs.push({ id: m[1], text: m[2].trim() }); continue; }
    // A section's lead sentence (e.g. the contract summary), once per section.
    if (l.trim() && !/^[-*>_]|^\d+\.|^\*\*/.test(l.trim()) && !doc.notes.some((n) => n.section === h2) && !/^requirements$|^user scenarios/i.test(h2)) doc.notes.push({ section: h2, text: l.trim() });
  }
  return doc;
}

// What the app is, in its authors' words: the README's (or a similar file's)
// title and first paragraph, plus the list that follows it.
export function appOverview(repo) {
  for (const f of ["README.md", "readme.md", "Readme.md", "replit.md", "AGENTS.md", "CLAUDE.md", "docs/README.md"]) {
    let text;
    try {
      text = fs.readFileSync(path.join(repo, f), "utf8");
    } catch {
      continue;
    }
    // Markdown read as words: an image or a link becomes its text, HTML tags go.
    const plain = (t) => t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, "").replace(/[*_`]/g, "").trim();
    const title = plain(text.match(/^#\s+(.+)$/m)?.[1] ?? "") || null;
    const blocks = text.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/).map((b) => b.split("\n").map((l) => l.replace(/^\s*>\s*(#+\s*)?/, "")).filter((l) => !/^\s*#/.test(l) && !/^\s*(!\[|<|\[!\[)/.test(l)).join("\n").trim()).filter(Boolean);
    const i = blocks.findIndex((b) => !/^\s*([-*]|\d+\.)\s/.test(b) && b.replace(/\s+/g, " ").length > 40);
    if (i < 0) continue;
    const about = [blocks[i], ...(/^\s*([-*]|\d+\.)\s/.test(blocks[i + 1] ?? "") ? [blocks[i + 1]] : [])].join("\n\n");
    return { title, about: about.length > 1500 ? about.slice(0, 1500).replace(/\s+\S*$/, "") + "…" : about, source: f };
  }
  try {
    const p = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    if (p.description) return { title: p.name, about: p.description, source: "package.json" };
  } catch {}
  return null;
}

// The app's areas, from its route paths: /api/public/orders/:id/pay -> public/orders.
const SCOPE = new Set(["admin", "public", "internal", "private", "me", "account"]);
export function areaOf(p) {
  const segs = p.split("/").filter((x) => x && !/^[:{*]/.test(x));
  while (segs.length > 1 && /^(?:api|v\d+|rest)$/i.test(segs[0])) segs.shift();
  if (!segs.length) return "/";
  return SCOPE.has(segs[0]) && segs[1] ? `${segs[0]}/${segs[1]}` : segs[0];
}

function specSection(repo, file, m) {
  const text = fs.readFileSync(file, "utf8");
  const doc = specDoc(text);
  const cite = checkCitations(repo, text);
  let cov = { requirements: [] };
  try {
    cov = testCoverage(repo, text, { specPath: file });
  } catch {}
  let stale = new Set();
  try {
    stale = new Set((staleness(repo, text, { range: "HEAD" }).summary.stale_requirements ?? []).map((x) => x.fr ?? x));
  } catch {}
  const citesBy = new Map();
  for (const c of cite.citations ?? []) (citesBy.get(c.fr) ?? citesBy.set(c.fr, []).get(c.fr)).push(c);
  const ids = [...new Set([...cov.requirements.map((r) => r.id), ...citesBy.keys()])];
  const reqs = ids.map((id) => {
    const r = cov.requirements.find((x) => x.id === id) ?? {};
    const cites = (citesBy.get(id) ?? []).map((c0) => {
      // A resolved citation carries its lines as range: [start, end].
      const c = { ...c0, start: c0.start ?? c0.range?.[0], end: c0.end ?? c0.range?.[1] };
      const lines = c.resolves ? readLines(repo, c.file) : null;
      return {
        cite: c.cite,
        file: c.file ?? null,
        start: c.start,
        end: c.end,
        resolves: !!c.resolves,
        problem: c.problem ?? null,
        code: lines ? lines.slice(c.start - 1, Math.min(c.end, c.start - 1 + MAX_SNIPPET)).join("\n") : null,
        truncated: lines ? c.end - c.start + 1 > MAX_SNIPPET : false,
      };
    });
    // Citations under a heading (a decision table, a contract section) aren't requirements.
    const requirement = /^(?:FR|SC|NFR|R|AC|INV|D)-?\d+[a-z]?$/.test(id);
    const text = (r.text ?? "").replace(/^\*\*[\w-]+\*\*\s*(?:\([^)]*\))?\s*:?\s*/, "").replace(/^#{1,6}\s+[\w-]+\s*[:.\-–—]\s*/, "");
    const extra = doc.reqs[id] ?? {};
    return { id, requirement, text, section: extra.section ?? null, holds: extra.holds ?? null, checks: extra.vcs ?? [], status: r.status ?? "none", tests: (r.tests ?? []).map((t) => (typeof t === "string" ? t : t.at ?? `${t.file}:${t.line}`)), stale: stale.has(id), cites };
  });
  const { reqs: _, ...rest } = doc;
  return { spec: m.spec, path: path.relative(repo, file), numbers: m, doc: rest, requirements: reqs };
}

function untrackedSpecs(repo) {
  try {
    return execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "*spec.md"], { cwd: repo, encoding: "utf8" }).split("\n").filter(Boolean).map((f) => path.join(repo, f)).filter(isSpecFile);
  } catch {
    return [];
  }
}

/** Everything the report shows, as data (also what `veridic report --json` prints). */
export async function collectReport(repo, { specs: specFiles } = {}) {
  const out = { repo, name: path.basename(repo), generated: new Date().toISOString(), errors: [] };
  const note = (where, e) => out.errors.push(`${where}: ${e.message ?? e}`);

  // Routes: effect, access, evidence.
  let g, inv;
  try {
    g = openGraph(repo);
    inv = routeInventory(g);
    const manifest = effectManifest(g, inv);
    const r = readiness(manifest);
    out.routes = manifest.map((t) => ({ id: t.tool, method: t.method, path: t.path, effect: t.effect, moves_money: t.moves_money, external: t.external, notifies: t.notifies, access: t.requires.access, scoped: t.requires.scoped_to_caller, handler: t.handler, evidence: t.evidence.map((e) => ({ kind: e.kind, at: e.at, via: e.via ?? null })), flags: t.access_flags }));
    out.readiness = r.summary;
    out.findings = r.issues.map((i) => ({ area: "API", severity: i.severity, kind: i.kind, where: i.tool, text: i.text, evidence: i.evidence, fix: FIXES[i.kind] ?? null }));
  } catch (e) {
    note("routes", e);
    out.routes = [];
    out.findings = [];
  }

  // Tests: strength across the repo.
  try {
    const a = auditTests(repo);
    out.tests = { summary: a.summary, flagged: a.flagged };
    for (const k of ["empty", "unasserted"]) for (const t of a.flagged[k] ?? []) out.findings.push({ area: "Tests", severity: "medium", kind: k === "empty" ? "empty test" : "test asserts nothing", where: t.at, text: t.title, evidence: [t.at], fix: FIXES[k] });
    for (const t of (a.flagged.weak ?? []).slice(0, 200)) out.findings.push({ area: "Tests", severity: "low", kind: "weak test", where: t.at, text: t.title, evidence: [t.at], fix: FIXES.weak });
  } catch (e) {
    note("tests", e);
  }

  // Specs: requirements, citations with code, tests, freshness.
  // Committed specs, and new ones not committed yet (a spec under review is often new).
  const files = specFiles?.length ? specFiles : [...new Set([...defaultSpecs(repo), ...untrackedSpecs(repo)])];
  out.specs = [];
  if (files.length) {
    try {
      const m = metrics(repo, files, { mutate: false });
      files.forEach((f, i) => {
        try {
          const s = specSection(repo, f, m.specs[i]);
          out.specs.push(s);
          for (const r of s.requirements) {
            if (r.stale) out.findings.push({ area: "Spec", severity: "medium", kind: "stale requirement", where: `${s.path} ${r.id}`, text: r.text, evidence: r.cites.map((c) => c.cite), fix: FIXES.stale });
            for (const c of r.cites.filter((c) => !c.resolves)) out.findings.push({ area: "Spec", severity: "medium", kind: "citation doesn't resolve", where: `${s.path} ${r.id}`, text: `${c.cite}: ${c.problem}`, evidence: [c.cite], fix: FIXES.unresolved });
          }
        } catch (e) {
          note(`spec ${f}`, e);
        }
      });
      out.coverage = m.coverage;
      // Which spec covers each route: it cites the handler's lines, or names the route as a seed.
      for (const r of out.routes) {
        const h = r.handler.match(/^(.*):(\d+)-(\d+)$/);
        r.specs = out.specs.filter((s) => (s.doc.meta.seeds ?? "").includes(`\`${r.id}\``) || (h && s.requirements.some((q) => q.cites.some((c) => c.resolves && c.file === h[1] && c.start <= Number(h[3]) && c.end >= Number(h[2]))))).map((s) => s.path);
      }
      out.attention = m.attention;
    } catch (e) {
      note("specs", e);
    }
  }

  // What the app is, and its modules: the features found from the code (see modules.mjs),
  // each with what it does, its risks, its spec, its tests and its neighbours.
  out.app = appOverview(repo);
  out.modules = [];
  if (g && inv?.routes.length) {
    try {
      const mods = findModules(g, inv);
      // The UI: which screens call which routes (see ui.mjs).
      let ui = { files: [] };
      try {
        ui = linkUi(repo, inv.routes, mods);
      } catch (e) {
        note("ui", e);
      }
      out.ui = { scanned: ui.scanned ?? 0, linked: ui.files.length, shared: ui.files.filter((f) => !f.module).map((f) => ({ file: f.file, kind: f.kind, routes: f.routes.length, modules: f.modules })), broken: ui.broken ?? [] };
      // The data: which tables each module owns and which it only uses (see data.mjs).
      let data = null;
      try {
        const tables = findTables(repo, g);
        if (tables.length) {
          const uses = routeData(g, inv.routes, tables);
          data = dataByModule(mods, uses, tables);
          for (const r of out.routes) if (uses.get(r.id)?.length) r.tables = uses.get(r.id).map((u) => ({ table: u.table, op: u.op }));
          out.data = { tables: tables.length, kinds: [...new Set(tables.map((t) => t.kind))], shared: data.shared, unused: data.unused, at: Object.fromEntries(tables.map((t) => [t.name, t.at])) };
        }
      } catch (e) {
        note("data", e);
      }
      const routeById = new Map(out.routes.map((r) => [r.id, r]));
      const invById = new Map(inv.routes.map((r) => [r.id, r]));
      const uiOf = (id) => ui.files.filter((f) => f.module === id);
      const targets = [...new Set([...mods.flatMap((m) => [...m.files, ...m.code]), ...ui.files.filter((f) => f.module).map((f) => f.file)])];
      let reaching = new Map();
      try {
        reaching = testsReaching(repo, targets);
      } catch (e) {
        note("module tests", e);
      }
      // Asserting tests anywhere that call a route by URL (supertest, e2e): `/api/orders/${id}`.
      let urlTests = [];
      try {
        urlTests = (await import("./tests.mjs")).testFilesOf(repo).map((f) => (g.text(f) ?? "")).filter((t) => /['"`]\/[\w-]+\//.test(t));
      } catch {}
      const callsUrl = (p) => {
        const parts = p.split("/").filter(Boolean);
        if (!parts.some((x) => !/^[:{*]/.test(x))) return false;
        const re = new RegExp(`["'\`]/${parts.map((x) => (/^[:{*]/.test(x) ? "(?:[^/\\s'\"\`]+|\\$\\{[^}]+\\})" : x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}(?:[?'"\`]|$)`);
        return urlTests.some((t) => re.test(t));
      };
      const testText = new Map();
      const textOf = (f) => (testText.has(f) ? testText.get(f) : testText.set(f, (g.text(f) ?? "").toLowerCase()).get(f));
      for (const m of mods) {
        const rs = m.routes.map((id) => routeById.get(id)).filter(Boolean);
        for (const r of rs) r.module = m.id;
        const tests = new Map();
        for (const f of [...m.files, ...m.code]) for (const t of reaching.get(f) ?? []) tests.set(t.file, t);
        const screens = uiOf(m.id);
        const uiTests = new Map();
        for (const f of screens) for (const t of reaching.get(f.file) ?? []) if (!tests.has(t.file)) uiTests.set(t.file, t);
        const asserting = [...tests.values()].filter((t) => t.asserting > 0);
        // A route counts as tested when an asserting test calls its URL, or reaches its
        // handler and names the URL's last word.
        const untested = rs.filter((r) => {
          const last = r.path.split("/").filter((x) => x && !/^[:{*]/.test(x)).pop()?.toLowerCase();
          const reachingHandler = (reaching.get(invById.get(r.id)?.file) ?? []).filter((t) => t.asserting > 0);
          if (last && reachingHandler.some((t) => textOf(t.file).includes(last))) return false;
          return !callsUrl(r.path);
        });
        const issues = out.findings.filter((f) => f.area === "API" && m.routes.includes(f.where));
        for (const f of issues) f.module = m.id;
        // What it does, in a few verb phrases from its routes: writes first, then reads.
        const sing = (w) => (w.length > 4 ? w.replace(/ies$/, "y").replace(/(?<![sui])s$/, "") : w);
        const phrase = (r) => {
          const segs = r.path.split("/").filter((x) => x && !/^[:{*]/.test(x) && !/^(?:api|v\d+|admin|public|owner|internal|private)$/i.test(x)).map((x) => x.replace(/[-_.]+/g, " ").toLowerCase());
          const last = segs.at(-1) ?? "", prev = segs.length > 1 ? sing(segs.at(-2)) : "";
          const plural = !/\s/.test(last) && /[^su]s$/.test(last);
          const withPrev = (x) => (prev && !/\s/.test(x) && !x.includes(prev) ? `${prev} ${x}` : x);
          if (/webhook|callback/.test(last + prev)) return `receive ${withPrev(last)}`;
          if (r.method === "GET" || r.method === "HEAD") return plural ? `list ${last}` : `view ${withPrev(last)}`;
          if (r.method === "DELETE") return `delete ${plural ? sing(last) : withPrev(last)}`;
          if (r.method === "PUT" || r.method === "PATCH") return `update ${plural ? sing(last) : withPrev(last)}`;
          return plural ? `create ${sing(last)}` : /\s/.test(last) ? last : `${last} ${prev}`.trim();
        };
        const order = (r) => (r.moves_money ? 0 : r.effect === "destructive" ? 1 : r.effect === "write" ? 2 : 3);
        const actions = [...new Set([...rs].sort((a, b) => order(a) - order(b)).map(phrase).filter(Boolean))].slice(0, 6);
        // A module with no routes (timers, WebSocket handlers) says what runs it.
        const entryWord = (e) => `${e.kind === "timer" ? "runs" : "serves a socket in"} ${e.name ?? e.file.split("/").pop().replace(/\.[^.]+$/, "")}`;
        if (!actions.length) actions.push(...[...new Set((m.entries ?? []).map(entryWord))].slice(0, 6));
        out.modules.push({
          ...m,
          does: actions,
          stats: {
            routes: rs.length,
            reads: rs.filter((r) => r.effect === "read").length,
            writes: rs.filter((r) => r.effect === "write").length,
            destructive: rs.filter((r) => r.effect === "destructive").length,
            money: rs.filter((r) => r.moves_money).length,
            public: rs.filter((r) => r.access === "public").length,
            high: issues.filter((f) => f.severity === "high").length,
            medium: issues.filter((f) => f.severity === "medium").length,
          },
          specs: [...new Set(rs.flatMap((r) => r.specs ?? []))],
          specified: rs.filter((r) => r.specs?.length).length,
          tests: { files: [...tests.values()].map((t) => ({ file: t.file, tests: t.tests, asserting: t.asserting })).sort((a, b) => b.tests - a.tests), ui: [...uiTests.values()].map((t) => ({ file: t.file, tests: t.tests, asserting: t.asserting })), asserting: asserting.length, untested: untested.map((r) => r.id) },
          // Screens: the UI files whose calls are mostly this module's; and other screens calling it.
          data: data?.byModule.get(m.id) ?? { owns: [], uses: [] },
          screens: screens.map((f) => ({ file: f.file, kind: f.kind, routes: f.routes.filter((id) => m.routes.includes(id)), other: f.routes.filter((id) => !m.routes.includes(id)).length })),
          calledFrom: ui.files.filter((f) => f.module !== m.id && f.routes.some((id) => m.routes.includes(id))).map((f) => ({ file: f.file, kind: f.kind, module: f.module, routes: f.routes.filter((id) => m.routes.includes(id)) })),
        });
      }
      // Endpoints nothing in the repo calls: no screen and no test, and not the kind outside
      // services call (webhooks, OAuth callbacks, health checks). Old features often hide here.
      const OUTSIDE = /webhook|callback|oauth|\bhooks?\b|health|ready|live|metrics|cron|\.well-known|sitemap|robots|feed|rss|deauthori[sz]e|data-deletion|unsubscribe|ping/i;
      const called = new Set(ui.files.flatMap((f) => f.routes));
      const untested = new Set(out.modules.flatMap((m) => m.tests.untested));
      out.uncalled = inv.routes.filter((r) => !called.has(r.id) && untested.has(r.id) && !OUTSIDE.test(r.path) && r.method !== "ALL").map((r) => ({ route: r.id, module: routeById.get(r.id)?.module ?? null, handler: `${r.file}:${r.start}-${r.end}` }));
      // A broken call belongs to the module of the screen that makes it.
      const screenModule = new Map(ui.files.map((f) => [f.file, f.module]));
      for (const b of out.ui.broken) b.module = screenModule.get(b.file) ?? null;
      // Riskiest first: open high issues, money, deletes, then size.
      const risk = (m) => m.stats.high * 100 + m.stats.medium * 20 + m.stats.money * 10 + m.stats.destructive * 4 + m.stats.writes + (m.specified ? 0 : 5);
      out.modules.sort((a, b) => risk(b) - risk(a) || b.stats.routes - a.stats.routes);
      for (const m of out.modules) m.risk = risk(m);
    } catch (e) {
      note("modules", e);
    }
  }
  // Findings that name a test or spec file belong to the module whose code they're about, when there is one.
  const fileModule = new Map(out.modules.flatMap((m) => [...m.files, ...m.code, ...(m.screens ?? []).map((x) => x.file)].map((f) => [f, m.id])));
  // Structure: how cleanly the modules are separated, and how much code is copied (see structure.mjs).
  try {
    const dup = duplication(repo);
    for (const b of dup.blocks) (b.a.module = fileModule.get(b.a.file) ?? null), (b.b.module = fileModule.get(b.b.file) ?? null);
    out.structure = { modularity: out.modules.length ? modularity(out.modules) : null, duplication: dup };
  } catch (e) {
    note("structure", e);
  }
  for (const m of out.modules) for (const t of m.tests.files) if (!fileModule.has(t.file)) fileModule.set(t.file, m.id);
  for (const f of out.findings)
    if (!f.module) {
      const file = [String(f.where), ...(f.evidence ?? [])].map((x) => String(x).split(":")[0].split(" ")[0]).find((x) => fileModule.has(x));
      if (file) f.module = fileModule.get(file);
    }

  // The change in progress: what the working tree changes against HEAD, checked against the claim.
  try {
    const claims = loadClaim(repo);
    const d = await doneWithoutSpec(repo, { claims });
    if (d.files?.length || d.tests?.length || claims.length) {
      out.change = { claims, done: d.done, problems: d.problems ?? [], files: d.files ?? [], seam: d.seam ?? null };
      for (const p of d.problems ?? []) {
        const kind = p.split(":")[0];
        out.findings.push({ area: "Change", severity: "high", kind: kind === "stray" ? "stray edit" : kind, where: "working tree", text: p.slice(kind.length + 1).trim(), evidence: [], fix: FIXES[kind] ?? null });
      }
    }
  } catch (e) {
    if (!/not a git|unknown revision|ambiguous argument 'HEAD'/i.test(e.message)) note("change", e);
  }

  const order = { high: 0, medium: 1, low: 2 };
  for (const f of out.findings) Object.assign(f, KINDS[f.kind] ?? { title: f.kind, why: "" });
  out.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  // The frontend's screens, grouped by who uses them, each with its own spec (see screens.mjs).
  try {
    out.screens = screenGroups(repo, { all: repoFiles(repo), routes: (out.routes ?? []).map((r) => ({ file: r.file ?? String(r.handler ?? "").replace(/:\d.*$/, "") })), specs: out.specs ?? [] });
  } catch (e) {
    out.screens = [];
    out.errors.push(`screens: ${e.message}`);
  }
  return out;
}

/** The page: data embedded as JSON, rendered by report-page.js, styled by report-page.css. */
const asset = (name) => fs.readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
export function renderReport(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const title = `Veridic · ${data.name}`.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${title}</title>
<style>${asset("report-page.css")}</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="data">${json}</script>
<script>${asset("report-page.js")}</script>
</body>
</html>
`;
}
