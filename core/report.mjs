// The report: what Veridic knows about a repo's parts and their specs, gathered once
// (also the data behind `veridic parts`, `coverage` and `prepare`) and rendered as one
// self-contained HTML page (no server, no network, no LLM) that shows the specs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { openGraph } from "./graph.mjs";
import { routeInventory } from "./routes.mjs";
import { effectManifest, readiness } from "./effects.mjs";
import { auditTests, testCoverage, successCriteria } from "./tests.mjs";
import { parseProduct, productState, ruleRowState } from "./product.mjs";
import { metrics, defaultSpecs, isSpecFile } from "./metrics.mjs";
import { checkCitations, repoFiles } from "./citations.mjs";
import { screenGroups } from "./screens.mjs";
import { specCoverage } from "./coverage.mjs";
import { staleness } from "./staleness.mjs";
import { findModules } from "./modules.mjs";
import { linkUi } from "./ui.mjs";
import { findTables, routeData, dataByModule } from "./data.mjs";
import { modularity, duplication } from "./structure.mjs";
import { testsReaching } from "./tests.mjs";

const MAX_SNIPPET = 40; // lines of cited code shown per citation

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
/**
 * A story heading in the forms spec agents write: "User Story 2 - Pay (Priority: P1)",
 * "Story 2: Pay (P1)", "Story 2 - Pay", "US-2: Pay [P2]". -> { n, title, priority } or null.
 */
export function parseStoryHeading(h) {
  // Two linear steps (one regex with an optional suffix after a lazy title backtracks badly).
  const m = String(h).trim().match(/^(?:user\s+story|story|us)\s*-?\s*(\d+)\s*[-–—:.]\s*(\S.*)$/i);
  if (!m) return null;
  const pr = m[2].match(/[([][ \t]*(?:priority[ \t]*:[ \t]*)?(P\d)[ \t]*[)\]]$/i);
  const title = (pr ? m[2].slice(0, pr.index) : m[2]).trim();
  return title ? { n: Number(m[1]), title, priority: pr ? pr[1].toUpperCase() : null } : null;
}

/** `###` headings that look like stories but don't parse: [{ line, heading }]. */
export function storyHeadingProblems(text) {
  const out = [];
  String(text).split("\n").forEach((l, i) => {
    const m = l.match(/^###\s+(.*)$/);
    if (m && /^(?:user\s+story|story|us)\b[\s-]/i.test(m[1].trim()) && !parseStoryHeading(m[1])) out.push({ line: i + 1, heading: m[1].trim() });
  });
  return out;
}

export function specDoc(text) {
  const lines = text.split("\n");
  const doc = { title: null, meta: {}, stories: [], tables: [], notes: [], reqs: {}, criteria: successCriteria(text) };
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
      const st = parseStoryHeading(h3);
      story = st ? { ...st, why: "", scenarios: [] } : null;
      if (story) doc.stories.push(story);
      continue;
    }
    // Before the first section: "**Status**: … · **Seeds**: …".
    if (!h2) {
      for (const mm of l.matchAll(/\*\*([\w ]+)\*\*:\s*([^·]+)/g)) doc.meta[mm[1].trim().toLowerCase()] = mm[2].trim();
      continue;
    }
    // A rule's worked examples: "  - Examples:" then an indented table under it.
    if (cur && /^ {4}\|/.test(l)) {
      const c = cells(l);
      if (c.length === 3 && c[0] !== "Given" && !/^-+$/.test(c[0])) (doc.reqs[cur].examples ??= []).push({ given: c[0], then: c[1], proven_by: c[2] === "not yet" ? null : c[2].replace(/`/g, "") });
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
    // Hashed citations by their text; the rest against HEAD only when the spec itself is committed.
    stale = new Set((staleness(repo, text, { range: "HEAD", specFile: path.relative(repo, file) }).summary.stale_requirements ?? []).map((x) => x.fr ?? x));
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
    const requirement = /^(?:FR|NFR|R|AC|INV|D)-?\d+[a-z]?$/.test(id); // success criteria are listed apart
    const text = (r.text ?? "").replace(/^\*\*[\w-]+\*\*\s*(?:\([^)]*\))?\s*:?\s*/, "").replace(/^#{1,6}\s+[\w-]+\s*[:.\-–—]\s*/, "");
    const extra = doc.reqs[id] ?? {};
    return { id, requirement, text, section: extra.section ?? null, holds: extra.holds ?? null, checks: extra.vcs ?? [], status: r.status ?? "none", ...(r.needs ? { needs: r.needs } : {}), tests: (r.tests ?? []).map((t) => (typeof t === "string" ? t : t.at ?? `${t.file}:${t.line}`)), stale: stale.has(id), cites };
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
    out.findings = r.issues.map((i) => ({ area: "API", severity: i.severity, kind: i.kind, where: i.tool, text: i.text, evidence: i.evidence }));
  } catch (e) {
    note("routes", e);
    out.routes = [];
    out.findings = [];
  }

  // Tests that check nothing: findings for the part whose code they're about.
  try {
    const a = auditTests(repo);
    for (const k of ["empty", "unasserted"]) for (const t of a.flagged[k] ?? []) out.findings.push({ area: "Tests", severity: "medium", kind: k === "empty" ? "empty test" : "test asserts nothing", where: t.at, text: t.title, evidence: [t.at] });
    for (const t of (a.flagged.weak ?? []).slice(0, 200)) out.findings.push({ area: "Tests", severity: "low", kind: "weak test", where: t.at, text: t.title, evidence: [t.at] });
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
            if (r.stale) out.findings.push({ area: "Spec", severity: "medium", kind: "stale requirement", where: `${s.path} ${r.id}`, text: r.text, evidence: r.cites.map((c) => c.cite) });
            for (const c of r.cites.filter((c) => !c.resolves)) out.findings.push({ area: "Spec", severity: "medium", kind: "citation doesn't resolve", where: `${s.path} ${r.id}`, text: `${c.cite}: ${c.problem}`, evidence: [c.cite] });
          }
        } catch (e) {
          note(`spec ${f}`, e);
        }
      });
      out.coverage = m.coverage;
      // The product spec: journeys and guarantees, each in the state of the part rules it names.
      const pf = path.join(repo, "specs/product/spec.md");
      if (fs.existsSync(pf)) {
        const byFolder = new Map(out.specs.map((sp) => [String(sp.path).split("/").slice(-2)[0], sp]));
        const row = (ref) => { const [folder, id] = ref.split(":"); return byFolder.get(folder)?.requirements.find((r) => r.id === id) ?? null; };
        out.product = { path: "specs/product/spec.md", ...productState(parseProduct(fs.readFileSync(pf, "utf8")), (ref) => ruleRowState(row(ref))) };
      }
      // Which spec covers each route: it cites the handler's lines, or names the route as a seed.
      for (const r of out.routes) {
        const h = r.handler.match(/^(.*):(\d+)-(\d+)$/);
        r.specs = out.specs.filter((s) => (s.doc.meta.seeds ?? "").includes(`\`${r.id}\``) || (h && s.requirements.some((q) => q.cites.some((c) => c.resolves && c.file === h[1] && c.start <= Number(h[3]) && c.end >= Number(h[2]))))).map((s) => s.path);
      }
    } catch (e) {
      note("specs", e);
    }
  }

  // What the app is, and its modules: the features found from the code (see modules.mjs),
  // each with what it does, its risks, its spec, its tests and its neighbours.
  out.app = appOverview(repo);
  out.modules = [];
  let uiFiles = []; // which UI files call which routes, for the screen groups below
  if (g && inv?.routes.length) {
    try {
      const mods = findModules(g, inv);
      // The UI: which screens call which routes (see ui.mjs).
      let ui = { files: [] };
      try {
        ui = linkUi(repo, inv.routes, mods);
        uiFiles = ui.files;
      } catch (e) {
        note("ui", e);
      }
      // The data: which tables each module owns and which it only uses (see data.mjs).
      let data = null;
      try {
        const tables = findTables(repo, g);
        if (tables.length) {
          const uses = routeData(g, inv.routes, tables);
          data = dataByModule(mods, uses, tables);
          for (const r of out.routes) if (uses.get(r.id)?.length) r.tables = uses.get(r.id).map((u) => ({ table: u.table, op: u.op }));
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
          tests: { files: [...tests.values()].map((t) => ({ file: t.file, tests: t.tests, asserting: t.asserting })).sort((a, b) => b.tests - a.tests), asserting: asserting.length, untested: untested.map((r) => r.id) },
          // Screens: the UI files whose calls are mostly this module's; and other screens calling it.
          data: data?.byModule.get(m.id) ?? { owns: [], uses: [] },
          screens: screens.map((f) => ({ file: f.file, kind: f.kind, routes: f.routes.filter((id) => m.routes.includes(id)), other: f.routes.filter((id) => !m.routes.includes(id)).length })),
        });
      }
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

  const order = { high: 0, medium: 1, low: 2 };
  for (const f of out.findings) Object.assign(f, KINDS[f.kind] ?? { title: f.kind, why: "" });
  out.findings.sort((a, b) => order[a.severity] - order[b.severity]);
  // The frontend's screens, grouped by who uses them, each with its own spec (see screens.mjs).
  try {
    out.screens = screenGroups(repo, { all: repoFiles(repo), routes: (out.routes ?? []).map((r) => ({ file: r.file ?? String(r.handler ?? "").replace(/:\d.*$/, "") })), specs: out.specs ?? [], ui: uiFiles });
  } catch (e) {
    out.screens = [];
    out.errors.push(`screens: ${e.message}`);
  }
  // How much of the app the specs describe (see coverage.mjs); the per-file map stays out.
  try {
    const { cited, ...cov } = specCoverage(repo, out);
    out.coverage = cov;
  } catch (e) {
    out.errors.push(`coverage: ${e.message}`);
  }
  return out;
}

/** The page: data embedded as JSON, rendered by report-page.js, styled by report-page.css with report-blueprint.css over it. */
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
<style>${asset("report-blueprint.css")}</style>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="data">${json}</script>
<script>${asset("report-page.js")}</script>
</body>
</html>
`;
}
