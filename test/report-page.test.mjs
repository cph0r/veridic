// The report page's model: what the page says, computed from the report data
// without a browser. The page is about the app's specs and nothing else; it
// defines veridicModel(D), and the view only draws it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8");
const load = () => { const ctx = {}; vm.runInNewContext(src, ctx); return ctx.veridicModel; };

const cite = (file, resolves = true) => ({ cite: `${file}:1-5`, file, start: 1, end: 5, resolves });
const rule = (id, status, over = {}) => ({ id, requirement: true, status, text: `${id} must hold.`, stale: false, cites: [cite("src/a.ts")], tests: [], checks: [], ...over });
const spec = (path, requirements, doc = {}) => ({ path, requirements, doc: { title: null, stories: [], ...doc }, numbers: {} });
const data = (over = {}) => ({
  name: "shop", generated: new Date().toISOString(), errors: [], app: { title: "Shop", about: "" },
  // non-spec findings and routes are in the data; the page must not show them
  routes: [{ id: "GET /api/orders", method: "GET", path: "/api/orders", module: "orders", flags: [] }],
  findings: [{ area: "API", severity: "high", kind: "idor", title: "Acts on any record by ID", why: "", module: "orders", where: "GET /api/orders" }],
  modules: [{ id: "orders", name: "Orders", routes: ["GET /api/orders"], specs: ["specs/orders/spec.md"], uses: [], tests: { untested: ["GET /api/orders"] }, data: { owns: [] } }],
  structure: { modularity: { problems: [{ kind: "shared-writes", table: "menu", owner: "menu", others: ["orders"] }] } },
  specs: [
    spec("specs/orders/spec.md", [rule("FR-001", "covered"), rule("FR-002", "broken"), rule("FR-003", "none", { stale: true }), rule("FR-004", "none"), { id: "Edge Cases (line 9)", requirement: false, status: "none", text: "", cites: [] }],
      { title: "Orders", stories: [{ n: 1, title: "A guest orders", why: "Revenue", scenarios: [{ given: "a menu", when: "a guest orders", then: "an order exists", refs: ["FR-001"] }] }] }),
    spec("specs/menu/spec.md", [rule("FR-001", "covered"), rule("FR-002", "none", { cites: [cite("src/gone.ts", false)] })]),
  ],
  ...over,
});

test("report page: the parts are the specs, and only the specs", () => {
  const m = load()(data());
  assert.deepEqual([...m.specs.map((s) => s.path)], ["specs/orders/spec.md", "specs/menu/spec.md"]);
  assert.equal(m.specs[0].name, "Orders");
  assert.equal(m.specs[1].name, "Menu"); // from the folder when the spec has no title
  // rules only: the edge-case note isn't a rule
  assert.equal(m.specs[0].rules.length, 4);
  // nothing from outside the specs reaches the page
  const said = JSON.stringify([m.fix, m.later, m.verdict]);
  assert.doesNotMatch(said, /Acts on any record|changed from two places|action|safety/i);
});

test("report page: each rule's state: proven, broken, out of date, pointing at missing code, or untested", () => {
  const m = load()(data());
  const [orders, menu] = m.specs;
  assert.deepEqual([...orders.rules.map((r) => m.stateOf(r).key)], ["proven", "broken", "stale", "untested"]);
  assert.equal(m.stateOf(menu.rules[1]).key, "lost");
  assert.equal(m.statusOf({ status: "broken" }).label, "Broken, proven");
});

test("report page: the headline and gauges count rules the way the cards do", () => {
  const m = load()(data());
  assert.equal(m.counts.rules, 6);
  assert.equal(m.counts.proven, 2);
  assert.equal(m.counts.broken, 1);
  assert.equal(m.counts.stale, 1);
  assert.equal(m.counts.lost, 1);
  assert.equal(m.counts.stories, 1);
  // true to the code: not out of date, and every citation still points at real code
  assert.equal(m.counts.true, 4);
  assert.equal(m.fix.reduce((s, c) => s + c.n, 0), m.counts.broken + m.counts.stale + m.counts.lost);
  assert.match(m.verdict, /1 rule is broken/);
  assert.match(m.verdict, /out of date/);
});

test("report page: a broken rule comes first and is named 'broken, proven'; untested rules wait", () => {
  const m = load()(data());
  assert.match(m.fix[0].w, /^Broken, proven/);
  assert.equal(m.fix[0].spec, "specs/orders/spec.md");
  // one card for every rule without a test, pointing at the spec with the most
  const untested = m.later.filter((c) => /no test yet/.test(c.html));
  assert.equal(untested.length, 1);
  assert.match(untested[0].html, /3 rules have no test yet/);
  assert.equal(untested[0].spec, "specs/orders/spec.md");
  // specs with problems sort first; out of date is amber, not red
  assert.equal(m.specs[0].tone, "bad");
  assert.equal(m.specs[1].tone, "warn");
  assert.equal(m.fix.find((c) => /out of date/.test(c.html)).tone, "warn");
  assert.equal(m.fix[0].tone, "bad");
});

test("report page: a spec whose rules are only untested is quiet, not flagged", () => {
  const m = load()(data({ specs: [spec("specs/orders/spec.md", [rule("FR-001", "covered"), rule("FR-002", "none")])] }));
  assert.equal(m.specs[0].tone, "todo");
  assert.equal(m.fix.length, 0);
});

test("report page: when every rule is true and proven, the page says so", () => {
  const m = load()(data({ specs: [spec("specs/orders/spec.md", [rule("FR-001", "covered"), rule("FR-002", "passing")])] }));
  assert.equal(m.fix.length + m.later.length, 0);
  assert.match(m.verdict.replace(/<[^>]+>/g, ""), /Every rule is true to the code and proven/);
});

test("report page: a repo with no specs is told how to get one", () => {
  const m = load()(data({ specs: [] }));
  assert.equal(m.specs.length, 0);
  assert.match(m.verdict, /No specs yet/);
});

test("report page: a rule reads as plain words: its first clause, the rest on tap", () => {
  const m = load()(data());
  const t = m.ruleText({ text: "The system MUST reject a new order whose body is invalid, whose table does not belong to the restaurant, whose restaurant is unknown (400), and MUST log it." });
  assert.equal(t.head, "Must reject a new order whose body is invalid, whose table does not belong to the restaurant, whose restaurant is unknown");
  assert.match(t.rest, /log it/);
});
