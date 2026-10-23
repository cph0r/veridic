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

test("report page: the dashboard shows how much of the app the specs describe", () => {
  const m = load()(data({ coverage: { behaviour: 10, covered: 7, pct: 70, parts: [{ id: "orders", name: "Orders", total: 5, covered: 2, uncovered: ["a", "b", "c"] }], orphans: [] } }));
  assert.equal(m.counts.covered, 7);
  assert.equal(m.counts.behaviour, 10);
  const card = m.later.find((c) => /files no spec describes/.test(c.html));
  assert.match(card.html, /3 files no spec describes/);
  assert.match(card.w, /Most in Orders \(3\)/);
  assert.equal(card.spec, "specs/orders/spec.md"); // the part with the most, through its spec
});

test("report page: no coverage data, no gauge", () => {
  const m = load()(data());
  assert.equal(m.counts.behaviour, 0);
  assert.ok(!m.later.some((c) => /files no spec describes/.test(c.html)));
});

// ---- the specs table: filters and sorters ----
test("report page: the specs table filters by health and text, and sorts by any column", () => {
  const m = load()(data());
  // orders: 1 proven, 1 broken, 1 stale, 1 untested; menu: 1 proven, 1 pointing at code that's gone
  const rows = (o) => [...m.rows(o).map((r) => (r.specs[0] ? r.specs[0].path : r.id))]; // a part, by its spec
  assert.deepEqual(rows({}), ["specs/orders/spec.md", "specs/menu/spec.md"], "worst first by default");
  assert.deepEqual(rows({ filter: "broken" }), ["specs/orders/spec.md"]);
  assert.deepEqual(rows({ filter: "stale" }), ["specs/orders/spec.md", "specs/menu/spec.md"], "out of date includes code gone");
  assert.deepEqual(rows({ filter: "proven" }), []);
  assert.deepEqual(rows({ q: "MENU" }), ["specs/menu/spec.md"]);
  assert.deepEqual(rows({ sort: "rules", dir: "asc" }), ["specs/menu/spec.md", "specs/orders/spec.md"]);
  assert.deepEqual(rows({ sort: "name", dir: "asc" }), ["specs/menu/spec.md", "specs/orders/spec.md"]);
  const orders = m.rows({}).find((r) => r.specs.some((x) => x.path === "specs/orders/spec.md"));
  assert.deepEqual({ rules: orders.rules.length, proven: orders.proven.length, broken: orders.broken.length, outdated: orders.outdated, untested: orders.untested.length, files: orders.files, health: orders.health }, { rules: 4, proven: 1, broken: 1, outdated: 1, untested: 2, files: 1, health: "Broken" });
});

test("report page: the specs table pages its rows", () => {
  const m = load()(data());
  const list = Array.from({ length: 23 }, (_, i) => ({ path: `specs/s${i}/spec.md` }));
  const p = m.page(list, { page: 3, size: 10 });
  assert.deepEqual({ from: p.from, to: p.to, total: p.total, page: p.page, pages: p.pages, n: p.items.length }, { from: 21, to: 23, total: 23, page: 3, pages: 3, n: 3 });
  assert.equal(m.page(list, { page: 9, size: 10 }).page, 3, "a page past the end shows the last");
  assert.equal(m.page(list, { page: 0, size: 10 }).page, 1);
  assert.equal(m.page(list, { page: 2, size: 0 }).items.length, 23, "size 0 shows all");
  assert.deepEqual({ ...m.page([], { page: 1, size: 10 }) }.pages, 1);
});

// ---- parts: one row per part of the app, its spec files grouped ----
const partsData = (over = {}) => data({
  modules: [
    { id: "orders", name: "Orders", files: ["src/orders.ts"], code: [], routes: [], specs: [], uses: [], tests: { untested: [] }, data: { owns: [] } },
    { id: "menu", name: "Menu", files: ["src/menu.ts"], code: [], routes: [], specs: [], uses: [], tests: { untested: [] }, data: { owns: [] } },
    { id: "tag", name: "Tag", files: ["src/tag.ts"], code: [], routes: [], specs: [], uses: [], tests: { untested: [] }, data: { owns: [] } },
  ],
  specs: [
    spec("specs/orders/spec.md", [rule("FR-001", "covered", { cites: [cite("src/orders.ts")] }), rule("FR-002", "none", { cites: [cite("src/orders.ts")] })]),
    spec("specs/orders-payment/spec.md", [rule("FR-001", "broken", { cites: [cite("src/orders.ts")] })]),
    spec("specs/menu-live/spec.md", [rule("FR-001", "none", { cites: [cite("src/menu.ts")] })]),
    spec("specs/notes/spec.md", [rule("FR-001", "none", { cites: [] })]),
  ],
  ...over,
});

test("parts: spec files group into their part by what they cite", () => {
  const m = load()(partsData());
  const orders = m.rows().find((p) => p.id === "orders");
  assert.deepEqual([...orders.specs.map((s) => s.path)].sort(), ["specs/orders-payment/spec.md", "specs/orders/spec.md"]);
  assert.equal(orders.rules.length, 3);
  assert.equal(orders.health, "Broken");
  assert.equal(m.partOf("specs/menu-live/spec.md"), "menu");
});

test("parts: a spec citing two parts equally goes to the first", () => {
  const m = load()(partsData({ specs: [spec("specs/both/spec.md", [rule("FR-001", "none", { cites: [cite("src/menu.ts"), cite("src/orders.ts")] })])] }));
  assert.equal(m.partOf("specs/both/spec.md"), "orders");
});

test("parts: a spec with no part is in Other specs and in the totals", () => {
  const m = load()(partsData());
  const other = m.rows().find((p) => p.specs.some((s) => s.path === "specs/notes/spec.md"));
  assert.equal(other.kind, "other");
  assert.equal(m.counts.rules, 5);
});

test("parts: a part with no spec is a row and adds no rules", () => {
  const m = load()(partsData());
  const tag = m.rows().find((p) => p.id === "tag");
  assert.equal(tag.health, "No spec");
  assert.equal(tag.rules.length, 0);
  assert.deepEqual([...m.rows({ filter: "nospec" }).map((p) => p.id)], ["tag"]);
  assert.equal(m.counts.rules, 5, "headline totals count spec files, not parts");
  assert.equal(m.counts.specs, 4);
});

test("parts: without parts, each spec is its own row", () => {
  const m = load()(data({ modules: [] }));
  assert.equal(m.rows().length, 2);
  assert.ok(m.rows().every((p) => p.kind === "other" && p.specs.length === 1));
});

test("parts: headline totals are the same as before grouping", () => {
  const m = load()(data());
  assert.deepEqual({ rules: m.counts.rules, proven: m.counts.proven, broken: m.counts.broken, stale: m.counts.stale, lost: m.counts.lost, specs: m.counts.specs }, { rules: 6, proven: 2, broken: 1, stale: 1, lost: 1, specs: 2 });
});

test("parts: opening a rule finds it in any file of the part", () => {
  const m = load()(partsData());
  assert.deepEqual({ ...m.ruleHome("FR-001", "specs/orders-payment/spec.md") }, { part: "orders", spec: "specs/orders-payment/spec.md" });
  assert.deepEqual({ ...m.ruleHome("FR-001", "specs/notes/spec.md") }, { part: "specs/notes/spec.md", spec: "specs/notes/spec.md" });
  assert.equal(m.P.get("orders").name, "Orders");
});

// ---- final review fixes (simplify) ----
test("final: the table finds a part by its specs' titles, and the dashboard groups like core/parts", () => {
  const m = load()(partsData({ specs: [spec("specs/orders-payment/spec.md", [rule("FR-001", "none", { cites: [cite("src/orders.ts")] })], { title: "Checkout" })] }));
  assert.deepEqual([...m.rows({ q: "checkout" }).map((p) => p.id)], ["orders"]);
  const m2 = load()(data({ modules: [{ id: "admin", name: "Admin", files: [], code: [] }], screens: [{ id: "admin-app", name: "Admin screens", files: [] }], specs: [spec("specs/admin-app/spec.md", [rule("FR-001", "none", { cites: [] })])] }));
  assert.equal(m2.partOf("specs/admin-app/spec.md"), "admin-app");
  const m3 = load()(partsData({ specs: [spec("specs/orders/spec.md", [rule("FR-001", "none", { cites: [cite("src/menu.ts")] })])] }));
  assert.equal(m3.partOf("specs/orders/spec.md"), "orders", "named after the part beats citations");
});

test("final: a saved view from before is cleaned: unknown sorts and empty filters reset", () => {
  const m = load()(partsData());
  assert.deepEqual({ ...m.cleanView({ sort: "files", filter: "all" }) }.sort, null);
  assert.equal(m.cleanView({ sort: "rules", filter: "all" }).sort, "rules");
  const allSpecced = load()(data());
  assert.equal(allSpecced.cleanView({ filter: "nospec" }).filter, "all");
  assert.equal(m.cleanView({ filter: "nospec" }).filter, "nospec");
});

// ---- the part sheet's tabs: stories with their rules, rules by state ----
const tabsData = () => data({
  modules: [{ id: "orders", name: "Orders", files: ["src/orders.ts"], code: [] }],
  specs: [
    spec("specs/orders/spec.md", [rule("FR-001", "covered", { cites: [cite("src/orders.ts")] }), rule("FR-002", "broken", { cites: [cite("src/orders.ts")] }), rule("FR-003", "none", { cites: [cite("src/orders.ts")] })],
      { title: "Orders", stories: [{ n: 1, title: "A guest orders", scenarios: [{ given: "a", when: "b", then: "c", refs: ["FR-001", "FR-002"] }, { given: "d", when: "e", then: "f", refs: ["FR-002", "FR-009"] }] }] }),
    spec("specs/orders-payment/spec.md", [rule("FR-001", "none", { cites: [cite("src/orders.ts")] })]),
  ],
});

test("tabs: each story lists the rules its scenarios name, from its own spec file", () => {
  const m = load()(tabsData());
  const s = m.storiesOf(m.P.get("orders"));
  assert.equal(s.length, 1);
  assert.deepEqual([...s[0].rules.map((r) => r.id)], ["FR-001", "FR-002"], "each rule once, unknown ids (FR-009) skipped");
  assert.equal(s[0].spec, "specs/orders/spec.md");
});

test("tabs: rules in no story, per spec file", () => {
  const m = load()(tabsData());
  const lone = m.rulesInNoStory(m.P.get("orders"));
  assert.deepEqual([...lone.map((x) => x.spec + " " + x.rule.id)].sort(), ["specs/orders-payment/spec.md FR-001", "specs/orders/spec.md FR-003"]);
});

test("tabs: the rules tab filters by state and text and counts each filter", () => {
  const m = load()(tabsData());
  const p = m.P.get("orders");
  const ids = (o) => [...m.partRules(p, o).map((x) => x.spec.split("/")[1] + ":" + x.rule.id)];
  assert.equal(m.partRules(p, {}).length, 4);
  assert.deepEqual(ids({ state: "attention" }), ["orders:FR-002"]);
  assert.deepEqual(ids({ state: "untested" }).sort(), ["orders-payment:FR-001", "orders:FR-003"]);
  assert.deepEqual(ids({ state: "proven" }), ["orders:FR-001"]);
  assert.deepEqual(ids({ q: "fr-003" }), ["orders:FR-003"]);
  assert.deepEqual({ ...m.ruleCounts(p) }, { all: 4, attention: 1, weak: 0, untested: 2, proven: 1 });
});

test("tabs: each rule is in exactly one state, so the sheet's chart adds up", () => {
  const m = load()(data({
    modules: [{ id: "orders", name: "Orders", files: ["src/orders.ts"], code: [] }],
    specs: [spec("specs/orders/spec.md", [
      rule("FR-001", "covered", { cites: [cite("src/orders.ts")] }),
      rule("FR-002", "none", { stale: true, cites: [cite("src/orders.ts")] }),
      rule("FR-003", "none", { cites: [cite("src/orders.ts")] }),
      rule("FR-004", "unasserted", { cites: [cite("src/orders.ts")] }),
    ])],
  }));
  const c = m.ruleCounts(m.P.get("orders"));
  assert.deepEqual({ ...c }, { all: 4, attention: 1, weak: 1, untested: 1, proven: 1 });
  assert.equal(c.attention + c.weak + c.untested + c.proven, c.all);
});
