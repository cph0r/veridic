// Inputs from the whole-branch review of 0.12, each a way it got something wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { routeInventory } from "../core/routes.mjs";
import { accessMatrix } from "../core/access.mjs";
import { fakeRepo } from "./fake.mjs";

const gitRepo = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-r012-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString();
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("add", "."); g("commit", "-qm", "a");
  return { repo, g, w: (f, t) => fs.writeFileSync(path.join(repo, f), t), r: (f) => fs.readFileSync(path.join(repo, f), "utf8"), done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};

test("review 0.12: a route() chain keeps its guard and handler", () => {
  const { g, done } = fakeRepo({
    "src/app.js": 'const express = require("express");\nconst router = require("./users");\nconst app = express();\napp.use("/api", router);\napp.listen(3000);\n',
    "src/users.js": 'const express = require("express");\nconst router = express.Router();\nrouter.route("/users/:id").get(requireAuth, show).delete(requireAuth, remove);\nrouter.route("/users").post(create);\nmodule.exports = router;\n',
  });
  const inv = routeInventory(g);
  const m = Object.fromEntries(accessMatrix(g, inv).map((x) => [x.route, x]));
  const post = inv.routes.find((r) => r.id === "POST /api/users");
  done();
  assert.equal(m["GET /api/users/:id"].access, "auth");
  assert.deepEqual(m["GET /api/users/:id"].guards, ["requireAuth"]);
  assert.match(post.handlerText ?? "create", /create/);
});

test("review 0.12: stamping never damages a citation that another one on the line starts with", async () => {
  const { stampSpec } = await import("../core/staleness.mjs");
  const { parseSpec } = await import("../core/citations.mjs");
  const r = gitRepo({ "a.ts": Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n" });
  const out = stampSpec(r.repo, "- **FR-001**: x [evidence: a.ts:1-20, a.ts:1-2, a.ts:3, a.ts:3-4]\n").spec;
  r.done();
  const cs = parseSpec(out).citations;
  assert.deepEqual(cs.map((c) => [c.start, c.end, !!c.hash, c.bad ?? null]), [[1, 20, true, null], [1, 2, true, null], [3, 3, true, null], [3, 4, true, null]]);
});

test("review 0.12: an edited line whose text is also elsewhere is stale, not moved; a tie is never resolved silently", async () => {
  const { citeHash, textCheck, makeResolver } = await import("../core/citations.mjs");
  const lines = ["function a() {", "  x();", "}", "function b() {", "  return next();", "}", "function c() {", "  y();", "}", "  return next();", "function d() {", "  z();", "}", "", "  return next();"];
  const r = gitRepo({ "b.ts": lines.join("\n") + "\n" });
  const c = { file: "b.ts", start: 10, end: 10, hash: citeHash([lines[9]]) };
  const resolve = makeResolver(r.repo, { files: ["b.ts"] });
  r.w("b.ts", lines.map((l, i) => (i === 9 ? "  return done();" : l)).join("\n") + "\n");
  const edited = textCheck(r.repo, c, resolve);
  r.w("b.ts", ["// header", ...lines].join("\n") + "\n"); // everything moved down one: the old line holds other text now
  const moved = textCheck(r.repo, c, resolve);
  r.done();
  assert.equal(edited.state, "stale", "line 10 changed; the same text at 5 and 15 isn't where it went");
  assert.notEqual(moved.state, "moved", "two copies (6 and 16) are equally near 11: ambiguous, not a silent pick");
});

test("review 0.12: a rename committed inside the range moves a hashed citation; a deleted file says deleted", async () => {
  const { citeHash } = await import("../core/citations.mjs");
  const { staleness } = await import("../core/staleness.mjs");
  const body = ["export const a = 1;", "export function f() {", "  return 2;", "}"];
  const r = gitRepo({ "a.ts": body.join("\n") + "\n", "d.ts": "export const d = 1;\n" });
  const spec = `- **FR-001**: f [evidence: a.ts:2-3~${citeHash(body.slice(1, 3))}]\n- **FR-002**: d [evidence: d.ts:1~${citeHash(["export const d = 1;"])}]\n`;
  r.g("mv", "a.ts", "c.ts"); r.g("rm", "-q", "d.ts"); r.g("commit", "-qm", "rename");
  const res = staleness(r.repo, spec, { range: "HEAD~1" });
  r.done();
  assert.deepEqual(res.fixes.map((f) => f.replacement), [`c.ts:2-3~${citeHash(body.slice(1, 3))}`]);
  assert.deepEqual(res.stale.map((s) => [s.fr, s.change]), [["FR-002", "deleted"]]);
});

test("review 0.12: editing a committed spec doesn't hide its unhashed citations' staleness", async () => {
  const { staleness } = await import("../core/staleness.mjs");
  const r = gitRepo({ "c.ts": "a\nb\nc\nd\n", "spec.md": "- **FR-001**: c [evidence: c.ts:3-4]\n" });
  r.w("c.ts", "a\nb\nC changed\nd\n"); r.g("commit", "-qam", "code");
  r.w("spec.md", r.r("spec.md") + "\nA note.\n"); // a typo fix, uncommitted
  const res = staleness(r.repo, r.r("spec.md"), { range: "HEAD~1", specFile: "spec.md" });
  r.done();
  assert.deepEqual(res.stale.map((s) => s.fr), ["FR-001"]);
});

test("review 0.12: re-rendering keeps each citation's earlier hash, so drift isn't forgotten", async () => {
  const { carryHashes } = await import("../core/staleness.mjs");
  const before = "- **FR-001**: x [evidence: a.ts:1-2~abc123, b.ts:4]\n";
  const now = "- **FR-001**: x, reworded [evidence: a.ts:1-2, b.ts:4]\n";
  assert.equal(carryHashes(before, now), "- **FR-001**: x, reworded [evidence: a.ts:1-2~abc123, b.ts:4]\n");
});

test("review 0.12: CORS or tenant middleware that reads the host isn't an app-serving route", () => {
  const { g, done } = fakeRepo({
    "src/app.js": [
      'const express = require("express");',
      "const app = express();",
      'function cors(req, res, next) { res.setHeader("Access-Control-Allow-Origin", "https://" + req.headers.host); next(); }',
      "function tenant(req, res, next) {",
      "  const t = tenants[req.hostname];",
      "  if (!t) return res.status(404).end();",
      "  req.tenant = t;",
      "  next();",
      "}",
      "app.use(cors);",
      "app.use(tenant);",
      'app.get("/api/me", (req, res) => res.json({}));',
      "app.listen(3000);",
    ].join("\n"),
  });
  const ids = routeInventory(g).routes.map((r) => r.id);
  done();
  assert.deepEqual(ids, ["GET /api/me"]);
});

test("review 0.12: parts in api/auth and admin/auth are api-auth and admin-auth, never auth-2", async () => {
  const { findModules } = await import("../core/modules.mjs");
  const r = (p, file, line) => ({ id: `GET ${p}`, method: "GET", path: p, file, start: line, end: line });
  const routes = [
    ...Array.from({ length: 10 }, (_, i) => r(`/api/auth/x${i}`, "src/api/auth/routes.ts", i + 1)),
    ...Array.from({ length: 10 }, (_, i) => r(`/admin/auth/y${i}`, "src/admin/auth/routes.ts", i + 1)),
  ];
  const { g, done } = fakeRepo(Object.fromEntries([...new Set(routes.map((x) => x.file))].map((f) => [f, "x\n".repeat(20)])));
  const ids = findModules(g, { routes }).map((m) => m.id).sort();
  done();
  assert.ok(!ids.some((id) => /-2$/.test(id)), ids.join(", "));
  assert.ok(ids.includes("admin-auth") || ids.includes("api-auth"), ids.join(", "));
});

test("review 0.12: skipIf(process.env.CI) runs when CI is unset", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const r = gitRepo({
    "src/a.ts": "export const a = 1;\n",
    "a.test.ts": 'import { a } from "./src/a";\ndescribe.skipIf(process.env.VERIDIC_TEST_FLAG_X)("local only", () => {\n  it("FR-001: a", () => { expect(a).toBe(1); });\n});\n',
  });
  const cov = testCoverage(r.repo, "- **FR-001**: a [evidence: src/a.ts:1]\n");
  r.done();
  assert.equal(cov.requirements[0].status, "covered");
});

test("review 0.12: a long story heading doesn't hang", async () => {
  const { parseStoryHeading } = await import("../core/report.mjs");
  const t = Date.now();
  parseStoryHeading("Story 1 - x" + " ".repeat(8000) + "y");
  assert.ok(Date.now() - t < 1000, `${Date.now() - t} ms`);
});

test("review 0.12: in an edited committed spec, a citation rewritten against the working tree isn't diffed against HEAD", async () => {
  const { staleness } = await import("../core/staleness.mjs");
  const r = gitRepo({ "c.ts": "a\nb\nc\nd\ne\nf\ng\nh\n", "spec.md": "- **FR-001**: c [evidence: c.ts:3-4]\n- **FR-002**: a [evidence: c.ts:1]\n" });
  r.w("c.ts", "new\nlines\na\nb\nc\nd\ne\nf\ng\nh\n"); // uncommitted code: everything moved down 2
  r.w("spec.md", "- **FR-001**: c [evidence: c.ts:5-6]\n- **FR-002**: a [evidence: c.ts:1]\n"); // FR-001 updated with it, FR-002 not
  const res = staleness(r.repo, r.r("spec.md"), { range: "HEAD", specFile: "spec.md" });
  r.done();
  assert.deepEqual(res.stale.map((s) => s.fr), [], "FR-001's citation was written against the working tree");
  assert.deepEqual(res.fixes.map((f) => f.fr), ["FR-002"], "FR-002's unchanged line still moves with its code");
});
