import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { whyOf, checkDecisions } from "../core/decisions.mjs";
import { basisOf, recordedBasis, basisComment } from "../core/basis.mjs";
import { doneCheck } from "../core/seam.mjs";
import { renderCard } from "../core/card.mjs";
import { validate } from "../core/specdata.mjs";

const gitRepo = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-feat-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  const write = (f, t) => (fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t));
  const commit = (msg) => (g("add", "-A"), g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg), g("rev-parse", "--short=7", "HEAD"));
  for (const [f, t] of Object.entries(files)) write(f, t);
  return { repo, g, write, commit, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};

test("why: the commits that wrote cited lines, most lines first, with their messages", () => {
  const r = gitRepo({ "src/a.ts": "const LIMIT = 20;\nexport const a = 1;\n" });
  const first = r.commit("Cap orders at 20 items\n\nKitchen printers truncate longer tickets.");
  r.write("src/a.ts", "const LIMIT = 20;\nexport const a = 2;\n");
  r.commit("bump a");
  const w = whyOf(r.repo, "src/a.ts", 1, 2);
  assert.equal(w.commits.length, 2);
  const cap = w.commits.find((c) => c.short === first);
  assert.equal(cap.subject, "Cap orders at 20 items");
  assert.match(cap.body, /Kitchen printers/);
  assert.equal(cap.evidence, `commit:${first}`);
  r.done();
});

test("decisions: commits must exist and touch the cited file; committed decisions are append-only", () => {
  const r = gitRepo({ "src/b.ts": "x\n" });
  r.commit("b");
  r.write("src/a.ts", "const LIMIT = 20;\n");
  const sha = r.commit("cap");
  const d = (over = {}) => ({ id: "D-001", decision: "Cap at 20.", because: "Printers.", evidence: ["src/a.ts:1", `commit:${sha}`], ...over });
  assert.deepEqual(checkDecisions(r.repo, { decisions: [d()] }), []);
  assert.match(checkDecisions(r.repo, { decisions: [d({ evidence: ["src/b.ts:1", `commit:${sha}`] })] })[0]?.problem ?? "", /didn't change|can't be the evidence/);
  assert.match(checkDecisions(r.repo, { decisions: [d({ evidence: ["commit:deadbeef"] })] })[0].problem, /not found/);
  // Append-only against the committed version.
  const committed = { decisions: [d()] };
  assert.match(checkDecisions(r.repo, { decisions: [d({ because: "Changed my mind." })] }, committed)[0].problem, /was edited/);
  assert.match(checkDecisions(r.repo, { decisions: [] }, committed)[0].problem, /was removed/);
  assert.deepEqual(checkDecisions(r.repo, { decisions: [d(), { id: "D-002", decision: "Cap at 30.", because: "New printers.", evidence: [`commit:${sha}`], supersedes: "D-001" }] }, committed), []);
  r.done();
});

test("spec.json validates decisions and seams", () => {
  const base = { feature: "x", seeds: ["GET /a"], requirements: [{ id: "FR-001", rule: "r", status: "planned", seam: ["src/a.ts"] }] };
  assert.deepEqual(validate(base), []);
  const probs = validate({ ...base, decisions: [{ id: "D-1", decision: "", evidence: ["nope"] }, { id: "D-002", decision: "a", because: "b", evidence: ["commit:abc1234"], supersedes: "D-009" }] });
  const text = probs.map((p) => `${p.at}: ${p.problem}`).join("\n");
  assert.match(text, /id must match/);
  assert.match(text, /missing decision/);
  assert.match(text, /not path:line/);
  assert.match(text, /supersedes unknown D-009/);
});

test("basis: a digest of file contents, recorded in a comment and read back", () => {
  const r = gitRepo({ "a.ts": "1\n", "b.ts": "2\n" });
  const b1 = basisOf(r.repo, ["b.ts", "a.ts", "a.ts"]);
  assert.equal(b1.files, 2);
  assert.deepEqual(recordedBasis(`x\n${basisComment(b1)}\n`), b1);
  r.write("a.ts", "changed\n");
  assert.notEqual(basisOf(r.repo, ["a.ts", "b.ts"]).digest, b1.digest);
  r.done();
});

test("done: the change must stay in the claimed seam, and each claimed requirement needs an asserting test", () => {
  const r = gitRepo({
    "src/order.ts": "export const limit = 20;\n",
    "src/other.ts": "export const o = 1;\n",
    "specs/o/spec.md": "- **FR-001**: limit is 20 [evidence: src/order.ts:1]\n- **FR-002** (planned): new thing [seam: src/new.ts]\n",
  });
  r.commit("base");
  r.write("src/order.ts", "export const limit = 20; // tuned\n");
  r.write("src/__tests__/order.test.ts", 'import { limit } from "../order";\nit("FR-001: limit", () => { expect(limit).toBe(20); });\n');
  const spec = path.join(r.repo, "specs/o/spec.md");
  let d = doneCheck(r.repo, spec, { ids: ["FR-001"] });
  assert.equal(d.done, true, JSON.stringify(d.requirements));
  assert.equal(d.seam.strays.length, 0);
  r.write("src/other.ts", "export const o = 2;\n");
  d = doneCheck(r.repo, spec, { ids: ["FR-001"] });
  assert.equal(d.done, false);
  assert.deepEqual(d.seam.strays, ["src/other.ts"]);
  // A planned requirement's declared seam counts before it cites any code.
  r.write("src/other.ts", "export const o = 1;\n");
  r.write("src/new.ts", "export const n = 1;\n");
  d = doneCheck(r.repo, spec, { ids: ["FR-001", "FR-002"] });
  assert.deepEqual(d.seam.strays, []);
  assert.deepEqual(d.requirements.find((q) => q.id === "FR-002").problems, ["no named test that reaches its code and asserts"]);
  r.done();
});

test("card: fixed layout with a mark per row and a verdict", () => {
  const c = renderCard({ title: "s.md", rows: [["cites", "3 of 3", true], ["tests", "1 of 2", false], ["range", "HEAD", null]], verdict: { ok: false, text: "1 TO FIX" }, next: ["fix tests"] });
  assert.match(c, /^VERIDIC · s\.md/);
  assert.match(c, /● cites\s+3 of 3/);
  assert.match(c, /✖ tests/);
  assert.match(c, /· range/);
  assert.match(c, /VERDICT ✖ 1 TO FIX/);
  assert.match(renderCard({ title: "t", rows: [], verdict: { ok: true, text: "DONE" } }), /VERDICT ● DONE/);
});

// --- done without a spec, claims, and the Stop hook -------------------------
import { makeRepo, FILES } from "./fixture.mjs";
import { doneWithoutSpec, saveClaim, loadClaim } from "../core/seam.mjs";
import { spawnSync } from "node:child_process";

function fixtureGit() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src/app.ts"), `import express from "express";\nconst app = express();\n${FILES["src/app.ts"]}app.listen(1);\n`);
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(repo, ".gitignore"), ".codegraph/\n");
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const edit = (f, from, to) => fs.writeFileSync(path.join(repo, f), fs.readFileSync(path.join(repo, f), "utf8").replace(from, to));
  const write = (f, t) => (fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t));
  return { repo, g, edit, write, done: () => fs.rmSync(repo, { recursive: true, force: true }) };
}
const ORDERS_TEST = 'import { router } from "../orders";\nit("POST /orders places it", async () => { expect(await post(router, "/orders")).toBe(201); });\n';

test("done without a spec: claimed change with a test about it is DONE; a stray edit and a missing test are not", async () => {
  const r = fixtureGit();
  r.edit("src/services/orders.ts", 'status: "awaiting_payment"', 'status: "awaiting_payment", channel: "qr"');
  r.write("src/routes/__tests__/orders.test.ts", ORDERS_TEST);
  let d = await doneWithoutSpec(r.repo, { claims: ["POST /api/orders"] });
  assert.equal(d.done, true, JSON.stringify(d.problems));
  // kitchen.ts is run by the claimed route too (placeOrder calls notifyKitchen): in the claim.
  // A change only the webhook's handler runs is outside it.
  r.edit("src/routes/hooks.ts", 'res.json({ ok: true });', 'res.json({ ok: true, at: Date.now() });');
  d = await doneWithoutSpec(r.repo, { claims: ["POST /api/orders"] });
  assert.equal(d.done, false);
  assert.match(d.problems.join("\n"), /stray: src\/routes\/hooks\.ts:\d+ \(behind POST \/api\/payment\/webhook\)/);
  r.edit("src/routes/hooks.ts", 'res.json({ ok: true, at: Date.now() });', 'res.json({ ok: true });');
  // No test about the changed route.
  fs.rmSync(path.join(r.repo, "src/routes/__tests__/orders.test.ts"));
  d = await doneWithoutSpec(r.repo, { claims: ["POST /api/orders"] });
  assert.match(d.problems.join("\n"), /untested: src\/services\/orders\.ts changes code behind POST \/api\/orders/);
  r.done();
});

test("claims are kept per task: a claim made before the last commit is ignored", () => {
  const r = fixtureGit();
  saveClaim(r.repo, ["POST /api/orders"]);
  assert.deepEqual(loadClaim(r.repo), ["POST /api/orders"]);
  r.write("x.txt", "1\n");
  r.g("add", "-A");
  r.g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "next task");
  assert.deepEqual(loadClaim(r.repo), []);
  r.done();
});

test("Stop hook: silent unless the repo opted in; then sends the agent back once with what's missing", () => {
  const r = fixtureGit();
  const hook = (active = false) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../skill/hooks/claude-stop.mjs")], { input: JSON.stringify({ cwd: r.repo, stop_hook_active: active }), encoding: "utf8", env: { ...process.env, VERIDIC_NO_SYNC: "1" } });
  r.edit("src/routes/hooks.ts", 'res.json({ ok: true });', 'res.json({ ok: true, at: Date.now() });');
  assert.equal(hook().status, 0, "not opted in");
  fs.writeFileSync(path.join(r.repo, ".veridic.json"), JSON.stringify({ stop: ["done"] }));
  saveClaim(r.repo, ["POST /api/orders"]);
  const h = hook();
  assert.equal(h.status, 2);
  assert.match(h.stderr, /NOT DONE[\s\S]*stray: src\/routes\/hooks\.ts/);
  assert.equal(hook(true).status, 0, "never loops");
  r.done();
});
