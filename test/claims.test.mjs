import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFacts, lineHas, asCode, checkClaims, plantedOffsetRecall } from "../core/claims.mjs";
import { mutateLine, mutateLiteral, mutationScore } from "../core/mutate.mjs";

const dirs = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// A small repo: a handler that uses a constant defined in another file.
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-claims-"));
  dirs.push(d);
  const files = {
    "src/limits.ts": `export const MAX_QTY = 20;\nexport const WINDOW_MS = 10_000;\nexport const log = makeLogger("x");\n`,
    "src/order.ts": [
      'import { MAX_QTY, WINDOW_MS } from "./limits";',
      "export function place(req, res) {",
      "  if (req.qty > MAX_QTY) {",
      '    return res.status(400).json({ error: "Too many" });',
      "  }",
      "  const bucket = Math.floor(Date.now() / WINDOW_MS);",
      '  return res.status(201).json({ status: "pending", bucket });',
      "}",
      "",
    ].join("\n"),
  };
  for (const [f, s] of Object.entries(files)) {
    fs.mkdirSync(path.join(d, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), s);
  }
  const g = (...a) => execFileSync("git", a, { cwd: d });
  g("init", "-q");
  g("add", ".");
  g("-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "x");
  return d;
}

test("extractFacts: code tokens, quoted messages, numbers with units, and noise dropped", () => {
  const facts = extractFacts('- **FR-001**: `POST /orders` MUST reject more than 20 items with 400 "Too many…", within a 10-second window, using a 24-hex token, returning `{ok: true}`. [evidence: src/order.ts:3-4]');
  const by = Object.fromEntries(facts.map((f) => [f.fact, f]));
  assert.ok(by["/orders"] && !by.POST && !by.true, "whole route path, no verb, no generic token");
  assert.ok(by["20"] && by["400"]);
  assert.equal(by["Too many"].kind, "string");
  assert.deepEqual(by["10"].alts, ["10", "10000"]);
  assert.equal(by["24"], undefined, "a size in other terms can't be checked literally");
  assert.equal(by["3"], undefined, "citation numbers are not facts");
});

test("lineHas matches numbers as written in code; asCode ignores words inside messages", () => {
  assert.equal(lineHas("const W = 10_000;", { fact: "10", kind: "number", alts: ["10", "10000"] }), true);
  assert.equal(lineHas(".limit(100)", { fact: "10", kind: "number" }), false);
  assert.equal(asCode('json({ error: "verification failed" })', { fact: "failed", kind: "code" }), false);
  assert.equal(asCode('status: "failed",', { fact: "failed", kind: "code" }), true);
});

test("checkClaims flags a fact that sits outside the cited lines, and the planted-offset recall finds shifted citations", () => {
  const d = repo();
  const spec = [
    '- **FR-001**: MUST reject more than 20 items with 400 "Too many". [evidence: src/order.ts:3-5]',
    '- **FR-002**: MUST answer 201 with status `pending`. [evidence: src/order.ts:6]',
  ].join("\n");
  const r = checkClaims(d, spec);
  assert.equal(r.summary.claims, 2);
  assert.equal(r.lines[0].facts.find((f) => f.fact === "20").status, "not_in_cited_files"); // MAX_QTY lives in limits.ts
  const fr2 = r.lines[1].facts;
  assert.equal(fr2.find((f) => f.fact === "201").status, "elsewhere_in_file");
  assert.equal(fr2.find((f) => f.fact === "201").at, "src/order.ts:7"); // off by one: the 201 is on line 7
  assert.equal(r.summary.claims_with_misplaced_facts, 1);

  const fixed = spec.replace("src/order.ts:6]", "src/order.ts:7]");
  const rec = plantedOffsetRecall(d, fixed, 3);
  assert.equal(rec.planted, 1); // FR-001's 20 is not literal in its lines, so only FR-002 counts
  assert.equal(rec.detected, 1);
});

test("mutateLine and mutateLiteral change exactly the literal", () => {
  assert.equal(mutateLine("x > 20 && y", { fact: "20", kind: "number" }), "x > 21 && y");
  assert.equal(mutateLine("const W = 10_000;", { fact: "10000", kind: "number" }), "const W = 10001;");
  assert.equal(mutateLiteral("export const WINDOW_MS = 10_000;"), "export const WINDOW_MS = 10001;");
  assert.equal(mutateLiteral('export const P = "demo";'), 'export const P = "demoMut";');
});

test("mutationScore finds an uncited constant a requirement depends on, and the guard agrees", () => {
  const d = repo();
  const spec = "- **FR-001**: MUST reject more than 20 items with 400. [evidence: src/order.ts:3-5]\n- **FR-002**: MUST bucket by window. [evidence: src/order.ts:6, src/limits.ts:2]\n";
  const r = mutationScore(d, spec, { validate: 6 });
  assert.equal(r.summary.dependency_mutants, 2); // MAX_QTY (uncited) and WINDOW_MS (cited); the logger is not a literal constant
  assert.equal(r.summary.dependency_caught, 1);
  assert.deepEqual(r.missed.map((m) => [m.fr, m.constants[0].constant]), [["FR-001", "MAX_QTY"]]);
  assert.equal(r.summary.sanity_caught, r.summary.sanity_mutants);
  assert.equal(r.summary.validation.agreement, 1);
});
