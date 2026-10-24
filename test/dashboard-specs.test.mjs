// The dashboard shows what the specs now carry: worked examples under a rule (proven by a test
// or not yet, and the last conform run's outcome), each part's data tables, and journeys'
// conform outcome. Nothing appears when a spec has none of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { dataTablesOf } from "../core/report.mjs";

const src = fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8");
const model = (D) => { const ctx = {}; vm.runInNewContext(src, ctx); return ctx.veridicModel(D); };

const DATA = [
  "## Data (generated)",
  "",
  "### Article [evidence: prisma/schema.prisma:11-24~b421bff3]",
  "",
  "| Column | Type | Null | Default | Key |",
  "|---|---|---|---|---|",
  "| id | Int | no | autoincrement() | primary |",
  "| slug | String | no | | unique |",
  "| authorId | Int | no | | → User.id |",
  "",
  "Many-to-many: tagList ↔ Tag.",
  "",
  "### Tag [evidence: prisma/schema.prisma:37-41~6ec6fba7]",
  "",
  "| Column | Type | Null | Default | Key |",
  "|---|---|---|---|---|",
  "| name | String | no | | unique |",
  "",
  "## Open Questions & Observed Risks",
  "",
].join("\n");

test("dashboard: a spec's data section as tables (columns, notes), nothing without one", () => {
  const t = dataTablesOf(DATA);
  assert.deepEqual(t.map((x) => [x.name, x.at, x.columns.length]), [["Article", "prisma/schema.prisma:11-24", 3], ["Tag", "prisma/schema.prisma:37-41", 1]]);
  assert.deepEqual(t[0].columns[2], { name: "authorId", type: "Int", nullable: false, default: "", key: "→ User.id" });
  assert.deepEqual(t[0].notes, ["Many-to-many: tagList ↔ Tag."]);
  assert.deepEqual(dataTablesOf("## Requirements\n\n- **FR-001**: x\n"), []);
});

test("dashboard: conform keeps its last run, one outcome per check", async () => {
  const { runChecks } = await import("../core/conform/run.mjs");
  const http = await import("node:http");
  const server = http.createServer((req, res) => { res.writeHead(req.url === "/ok" ? 200 : 500); res.end("{}"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const r = await runChecks([
    { id: "a", request: { method: "GET", path: "/ok", as: "anon" }, expect: { status: 200 } },
    { id: "b", request: { method: "GET", path: "/no", as: "anon" }, expect: { status: 200 } },
    { id: "c", request: { method: "GET", path: "/x/:id", as: "anon" }, expect: { status: 200 } },
  ], { url });
  server.close();
  assert.deepEqual(r.results, [{ id: "a", outcome: "passed" }, { id: "b", outcome: "failed", got: 500 }, { id: "c", outcome: "not_run", why: "no seed for id" }]);
});

const rule = (id, over = {}) => ({ id, requirement: true, status: "none", text: `${id} must hold.`, stale: false, cites: [{ cite: "src/a.ts:1-5", file: "src/a.ts", start: 1, end: 5, resolves: true }], tests: [], checks: [], ...over });
const D = (over = {}) => ({
  name: "conduit", generated: new Date().toISOString(), errors: [], app: { title: "Conduit" }, routes: [], findings: [], modules: [],
  specs: [{ path: "specs/articles/spec.md", numbers: {}, doc: { title: "Articles", stories: [] }, requirements: [
    rule("FR-004", { examples: [
      { given: 'POST /api/articles { title: "" } as owner', then: "422", proven_by: "test/a.test.ts:4" },
      { given: "POST /api/articles as anon", then: "401", proven_by: null },
      { given: "GET /api/articles/:slug as other", then: "denied", proven_by: null },
    ] }),
    rule("FR-005"),
  ], data: [{ name: "Article", at: "prisma/schema.prisma:11-24", columns: [{ name: "id", type: "Int", nullable: false, default: "autoincrement()", key: "primary" }], notes: ["Many-to-many: tagList ↔ Tag."], changed: "columns changed: added body" }] }],
  ...over,
});

const visible = (html) => html.replace(/ title="[^"]*"/g, "");

test("dashboard: a rule's examples, one short line each: a dot and a word, the request and its status; the rest on hover", () => {
  const m = model(D());
  const html = m.examplesHTML(m.specs[0].rules[0], "specs/articles/spec.md");
  assert.match(html, /Examples/);
  assert.match(visible(html), /Proven[\s\S]*POST \/api\/articles → 422[\s\S]*Not yet[\s\S]*POST \/api\/articles → 401[\s\S]*GET \/api\/articles\/:slug → denied/);
  assert.doesNotMatch(visible(html), /title: |as owner|test\/a\.test\.ts|<table/, "bodies, users and test paths only on hover");
  assert.match(html, /title="[^"]*title: &quot;&quot;[^"]*test\/a\.test\.ts:4/, "the full row is in the hover bubble");
  assert.equal(m.examplesHTML(m.specs[0].rules[1], "specs/articles/spec.md"), "", "no examples, nothing drawn");
});

test("dashboard: with a saved conform run, one word per example, worst first: Failed, Proven, Passed, Not yet", () => {
  const conform = { at: "2026-10-24T20:00:00Z", url: "http://localhost:3000", results: [
    { id: "example:articles:FR-004:1", outcome: "passed" }, { id: "example:articles:FR-004:2", outcome: "failed", got: 200 }, { id: "scope:articles:FR-004:3", outcome: "passed", got: 404 },
  ] };
  const m = model(D({ conform }));
  const html = m.examplesHTML(m.specs[0].rules[0], "specs/articles/spec.md");
  assert.match(visible(html), /Proven[\s\S]*→ 422[\s\S]*Failed[\s\S]*→ 401[\s\S]*Passed[\s\S]*→ denied/);
  assert.match(html, /title="[^"]*Last run: failed \(got 200\)/);
});

test("dashboard: a part's Data tab lists its tables; a table the schema changed under is outlined", () => {
  const m = model(D());
  const p = m.parts.find((x) => x.specs.some((s) => s.path === "specs/articles/spec.md"));
  assert.deepEqual(Array.from(m.partTabs(p), ([k]) => k), ["overview", "stories", "rules", "data"]);
  const html = m.dataHTML(p);
  assert.match(html, /Article[\s\S]*autoincrement\(\)[\s\S]*primary[\s\S]*Many-to-many: tagList ↔ Tag/);
  assert.match(html, /class="dtab changed"[\s\S]*Δ[\s\S]*columns changed: added body/);
  const plain = model(D({ specs: [{ ...D().specs[0], data: [] }] }));
  assert.deepEqual(Array.from(plain.partTabs(plain.parts[0]), ([k]) => k), ["overview", "stories", "rules"], "no data section, no tab");
});

test("dashboard: a journey's conform outcome, in its row and its sheet, only when a run is saved", () => {
  const product = { path: "specs/product/spec.md", title: "Conduit", summary: "", journeys: [{ id: "J-001", title: "Write an article", state: "untested", steps: [{ text: "Post it", refs: ["articles:FR-004"], state: "untested" }] }], guarantees: [] };
  const none = model(D({ product }));
  assert.doesNotMatch(none.productParts().journeys + none.productItemHTML("J-001"), /Last run|Conforms/);
  const m = model(D({ product, conform: { at: "2026-10-24T20:00:00Z", url: "http://localhost:3000", results: [{ id: "journey:J-001", outcome: "failed", got: { "article.title": "x" } }] } }));
  assert.match(m.productParts().journeys, /Last run: failed/);
  assert.match(m.productItemHTML("J-001"), /Last run[\s\S]*failed/);
});
