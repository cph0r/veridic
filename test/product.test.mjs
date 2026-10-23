// The product spec: journeys across parts and guarantees that span them, each pointing at
// the part rules that make it true.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseProduct, productProblems, productState } from "../core/product.mjs";
import { specHomes } from "../core/parts.mjs";

const PRODUCT = [
  "# Product: Launch",
  "",
  "People ask an assistant for an app and get one they can change by asking.",
  "",
  "## Journeys",
  "",
  "### J-001: Ask for an app",
  "",
  "1. A person connects an assistant (auth:FR-001)",
  "2. They ask for an app and it's built (apps:FR-003, apps-mcp:FR-002)",
  "",
  "### J-002: Change it by asking",
  "",
  "1. They ask for a change (apps:FR-004)",
  "",
  "## Guarantees",
  "",
  "- **G-001**: A person's app data never reaches the server [rules: apps:FR-003, apps-host:FR-002]",
  "- **G-002**: Only the owner can install an app [rules: apps:FR-009]",
  "",
].join("\n");

test("product: journeys and guarantees, with the part rules they name", () => {
  const p = parseProduct(PRODUCT);
  assert.equal(p.title, "Launch");
  assert.equal(p.summary, "People ask an assistant for an app and get one they can change by asking.");
  assert.deepEqual(p.journeys.map((j) => [j.id, j.title, j.steps.length]), [["J-001", "Ask for an app", 2], ["J-002", "Change it by asking", 1]]);
  assert.deepEqual(p.journeys[0].steps[1], { text: "They ask for an app and it's built", refs: ["apps:FR-003", "apps-mcp:FR-002"] });
  assert.deepEqual(p.guarantees[0], { id: "G-001", text: "A person's app data never reaches the server", refs: ["apps:FR-003", "apps-host:FR-002"] });
});

test("product: a reference to a missing rule or spec folder is a problem, and has no state", () => {
  const p = parseProduct(PRODUCT);
  const specs = { auth: ["FR-001"], apps: ["FR-003", "FR-004"], "apps-mcp": ["FR-002"], "apps-host": ["FR-002"] };
  assert.deepEqual(productProblems(p, specs), [{ id: "G-002", ref: "apps:FR-009", why: "no FR-009 in specs/apps" }]);
  assert.deepEqual(productProblems(parseProduct("## Guarantees\n\n- **G-001**: x [rules: billing:FR-001]\n"), specs), [{ id: "G-001", ref: "billing:FR-001", why: "no spec folder specs/billing" }]);
  const states = { "auth:FR-001": "proven", "apps:FR-003": "proven", "apps-mcp:FR-002": "stale", "apps:FR-004": "untested", "apps-host:FR-002": "proven" };
  const s = productState(p, (ref) => states[ref] ?? null);
  assert.equal(s.journeys[0].state, "stale", "any stale step makes the journey stale");
  assert.equal(s.journeys[0].steps[0].state, "proven");
  assert.equal(s.journeys[1].state, "untested");
  assert.equal(s.guarantees[0].state, "proven", "proven when every rule is");
  assert.equal(s.guarantees[1].state, null, "a missing rule has no state");
  const broken = productState(p, (ref) => (ref === "apps:FR-003" ? "broken" : "proven"));
  assert.equal(broken.guarantees[0].state, "broken");
});

test("product: the product spec belongs to no part", () => {
  const data = { modules: [{ id: "apps", files: ["src/apps.ts"] }], specs: [{ path: "specs/product/spec.md", requirements: [] }, { path: "specs/apps/spec.md", requirements: [] }] };
  const homes = specHomes(data);
  assert.equal(homes.get("specs/product/spec.md"), null);
  assert.equal(homes.get("specs/apps/spec.md"), "apps");
});

test("check: a product spec's broken references fail it", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-product-"));
  fs.mkdirSync(path.join(repo, "specs/apps"), { recursive: true });
  fs.mkdirSync(path.join(repo, "specs/product"), { recursive: true });
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "specs/apps/spec.md"), "- **FR-003**: a [evidence: a.ts:1]\n");
  fs.writeFileSync(path.join(repo, "specs/product/spec.md"), "## Guarantees\n\n- **G-001**: x [rules: apps:FR-003, apps:FR-009]\n");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "."], { cwd: repo });
  const r = spawnSync(process.execPath, [path.resolve("skill/scripts/cite.mjs"), "--repo", repo, "--spec", path.join(repo, "specs/product/spec.md")], { encoding: "utf8" });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout).product_problems, [{ id: "G-001", ref: "apps:FR-009", why: "no FR-009 in specs/apps" }]);
});

test("report: the product spec's journeys and guarantees carry the states of the rules they name", async () => {
  const { productState: ps, parseProduct: pp, ruleRowState } = await import("../core/product.mjs");
  assert.equal(ruleRowState({ status: "covered", stale: false, cites: [{ resolves: true }] }), "proven");
  assert.equal(ruleRowState({ status: "covered", stale: true, cites: [] }), "stale");
  assert.equal(ruleRowState({ status: "none", stale: false, cites: [{ resolves: false }] }), "broken");
  assert.equal(ruleRowState({ status: "none", stale: false, cites: [] }), "untested");
  assert.equal(ruleRowState(null), null);
  const s = ps(pp("## Guarantees\n\n- **G-001**: x [rules: apps:FR-001]\n"), () => "proven");
  assert.equal(s.guarantees[0].state, "proven");
});
