// The report page's model: what the page says, computed from the report data
// without a browser. The page defines veridicModel(D); the view only draws it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../core/report-page.js", import.meta.url), "utf8");
const load = () => { const ctx = {}; vm.runInNewContext(src, ctx); return ctx.veridicModel; };

const route = (method, path, module, access = "auth") => ({ id: `${method} ${path}`, method, path, module, access, flags: [] });
const rule = (id, status, text = `${id} must hold.`) => ({ id, requirement: true, status, text, stale: false });
const mod = (id, routes, extra = {}) => ({
  id, name: id[0].toUpperCase() + id.slice(1), routes, specs: [`specs/${id}/spec.md`], uses: [], usedBy: [],
  tests: { untested: [] }, data: { owns: [] }, stats: { high: 0, medium: 0 }, ...extra,
});
const data = (over = {}) => ({
  name: "shop", generated: new Date().toISOString(), errors: [], app: { title: "Shop", about: "" },
  routes: [route("GET", "/api/orders", "orders"), route("POST", "/api/public/orders", "orders", "public"), route("POST", "/api/admin/menu", "menu")],
  modules: [mod("orders", ["GET /api/orders", "POST /api/public/orders"]), mod("menu", ["POST /api/admin/menu"])],
  specs: [
    { path: "specs/orders/spec.md", requirements: [rule("FR-001", "covered"), rule("FR-002", "broken"), rule("FR-003", "none")] },
    { path: "specs/menu/spec.md", requirements: [rule("FR-001", "covered")] },
  ],
  findings: [],
  structure: { modularity: { problems: [] } },
  tests: { summary: {} },
  ...over,
});
const risk = (severity, title, module, where = "GET /api/orders") => ({ area: "API", severity, kind: "k", title, why: "why", module, where });

test("report page: a serious risk is never shown as safe, and the headline counts what the cards count", () => {
  const model = load();
  const m = model(data({ findings: [risk("high", "Acts on any record by ID", "orders"), risk("high", "Acts on any record by ID", "orders", "POST /api/public/orders"), risk("medium", "GET request changes data", "menu")] }));
  assert.equal(m.safety.problems, 3);
  assert.equal(m.safety.serious, 2);
  assert.equal(m.safety.label, "Safety problems");
  // one broken rule + three risks, in two kinds of risk
  assert.equal(m.nFix, 4);
  assert.equal(m.fix.reduce((s, c) => s + c.n, 0), m.nFix);
  assert.equal(m.fix.find((c) => /Acts on any record/.test(c.html)).n, 2);
  assert.match(m.verdict, /4 problems/);
});

test("report page: with no risks the safety gauge says safe", () => {
  const m = load()(data());
  assert.equal(m.safety.problems, 0);
  assert.equal(m.safety.label, "Safe");
});

test("report page: a broken rule is a problem to fix, named 'broken, proven', and its part needs fixing", () => {
  const m = load()(data());
  const orders = m.parts.find((p) => p.id === "orders");
  assert.equal(orders.health, "bad");
  assert.deepEqual(orders.broken.map((r) => r.id), ["FR-002"]);
  assert.equal(m.statusOf(orders.broken[0]).label, "Broken, proven");
  assert.ok(m.fix.some((c) => c.parts[0] === "orders" && /FR-002 must hold/.test(c.html)));
  // proven counts only tested rules: 2 of 4
  assert.equal(m.proven.tested, 2);
  assert.equal(m.proven.total, 4);
});

test("report page: an out-of-date requirement without a part belongs to the part whose spec it is in", () => {
  const m = load()(data({ findings: [{ area: "Spec", severity: "medium", kind: "stale", title: "Spec out of date with the code", why: "", where: "specs/menu/spec.md:12" }] }));
  const stale = m.later.find((c) => /out of date/.test(c.html));
  assert.deepEqual([...stale.parts], ["menu"]);
  // stale reports name the rule after the spec's path
  const m2 = load()(data({ findings: [{ area: "Spec", severity: "medium", kind: "stale", title: "Spec out of date with the code", why: "", where: "specs/orders/spec.md FR-002" }] }));
  assert.deepEqual([...m2.later.find((c) => /out of date/.test(c.html)).parts], ["orders"]);
});

test("report page: the graph is drawn only when parts connect; otherwise the parts are a list", () => {
  assert.equal(load()(data()).layout, "list");
  const d = data({ modules: [mod("orders", ["GET /api/orders", "POST /api/public/orders"], { uses: [{ module: "menu" }] }), mod("menu", ["POST /api/admin/menu"])] });
  assert.equal(load()(d).layout, "graph");
});

test("report page: a part changing another part's data is an amber link, and the later list says so", () => {
  const d = data({ structure: { modularity: { problems: [{ kind: "shared-writes", table: "menu_items", owner: "menu", others: ["orders"] }] } } });
  const m = load()(d);
  const e = m.edges.find((x) => x.a === "orders" && x.b === "menu");
  assert.deepEqual([...e.changes], ["menu items"]);
  assert.equal(m.kindOf(e), "changes");
  assert.ok(m.later.some((c) => /Orders changes menu items/.test(c.html)));
});

test("report page: actions read as plain words, and who can do them comes from the path or the guard", () => {
  const m = load()(data());
  assert.equal(m.act("POST", "/api/admin/menu"), "Add a menu");
  assert.equal(m.act("GET", "/api/orders/:id"), "Open an order");
  assert.equal(m.act("DELETE", "/api/orders/:id/items/:itemId"), "Delete an item");
  assert.equal(m.act("POST", "/api/users/login"), "Log in");
  assert.equal(m.who(route("POST", "/api/admin/menu", "menu")), "staff");
  assert.equal(m.who(route("POST", "/api/users", "auth", "public")), "public");
});

test("report page: a repo without routes still gets one part per spec", () => {
  const m = load()(data({ routes: [], modules: [] }));
  assert.deepEqual(m.parts.map((p) => p.id).sort(), ["specs/menu/spec.md", "specs/orders/spec.md"]);
  assert.equal(m.parts.find((p) => p.id === "specs/orders/spec.md").rs.length, 3);
});

test("report page: an about line that only repeats the title is dropped", () => {
  const m = load()(data({ app: { title: "Shop - Food Orders", about: "Shop takes food orders for restaurants." } }));
  assert.equal(m.about, "");
  assert.equal(load()(data({ app: { title: "Shop", about: "A long description of what this app does for the people who run restaurants every day." } })).about.length > 0, true);
});
