// The small items deferred from the 0.12 review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const gitRepo = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-m0123-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "."], { cwd: repo });
  return { repo, w: (f, t) => fs.writeFileSync(path.join(repo, f), t), done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};

test("citations: new hashes are 8 hex; a 6-hex hash stamped by 0.12.0-0.12.2 still checks", async () => {
  const { citeHash, textCheck, makeResolver } = await import("../core/citations.mjs");
  const lines = ["export const a = 1;", "export const b = 2;"];
  assert.match(citeHash(lines), /^[0-9a-f]{8}$/);
  const r = gitRepo({ "a.ts": lines.join("\n") + "\n" });
  const resolve = makeResolver(r.repo, { files: ["a.ts"] });
  const old = { file: "a.ts", start: 1, end: 2, hash: citeHash(lines).slice(0, 6) };
  const fresh = textCheck(r.repo, old, resolve);
  r.done();
  assert.deepEqual(fresh, { state: "fresh" });
});

test("stale: a moved one-line citation reads a.ts:5, not a.ts:5-5", async () => {
  const { citeHash } = await import("../core/citations.mjs");
  const { staleness } = await import("../core/staleness.mjs");
  const r = gitRepo({ "a.ts": "export const unique = 42;\n" });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a"], { cwd: r.repo });
  r.w("a.ts", "// one\n// two\nexport const unique = 42;\n");
  const res = staleness(r.repo, `- **FR-001**: x [evidence: a.ts:1~${citeHash(["export const unique = 42;"])}]\n`, { range: "HEAD" });
  r.done();
  assert.equal(res.shifted[0].now, "a.ts:3");
});

test("tests: skipped rules are counted in the summary and named in the work list", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const r = gitRepo({
    "src/a.ts": "export const a = 1;\n",
    "a.test.ts": 'import { a } from "./src/a";\ndescribe.skipIf(!process.env.VERIDIC_M0123_FLAG)("db", () => {\n  it("FR-001: a", () => { expect(a).toBe(1); });\n});\n',
  });
  const cov = testCoverage(r.repo, "- **FR-001**: a [evidence: src/a.ts:1]\n");
  r.done();
  assert.equal(cov.summary.skipped, 1);
  const { STATUS } = await import("../core/worklist.mjs");
  assert.ok(STATUS.skipped, "the work list has a word for skipped");
});

test("check: a product spec may cite a rule written as a table row", () => {
  const r = gitRepo({
    "specs/apps/spec.md": "| ID | Rule |\n|---|---|\n| FR-003 | apps hold [evidence: a.ts:1] |\n",
    "specs/product/spec.md": "## Guarantees\n\n- **G-001**: Apps hold: they do [rules: apps:FR-003]\n",
    "a.ts": "export const a = 1;\n",
  });
  const out = spawnSync(process.execPath, [path.resolve("skill/scripts/cite.mjs"), "--repo", r.repo, "--spec", path.join(r.repo, "specs/product/spec.md")], { encoding: "utf8" });
  r.done();
  assert.equal(JSON.parse(out.stdout).product_problems, undefined, out.stdout.slice(0, 300));
});

test("check: a product spec outside git doesn't crash", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-nogit-"));
  fs.mkdirSync(path.join(repo, "specs/product"), { recursive: true });
  fs.mkdirSync(path.join(repo, "specs/apps"), { recursive: true });
  fs.writeFileSync(path.join(repo, "specs/apps/spec.md"), "- **FR-003**: x\n");
  fs.writeFileSync(path.join(repo, "specs/product/spec.md"), "## Guarantees\n\n- **G-001**: x [rules: apps:FR-003]\n");
  const out = spawnSync(process.execPath, [path.resolve("skill/scripts/cite.mjs"), "--repo", repo, "--spec", path.join(repo, "specs/product/spec.md")], { encoding: "utf8" });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.notEqual(out.status, 2, out.stdout.slice(0, 300));
  assert.equal(JSON.parse(out.stdout).product_problems, undefined);
});

test("tests: a spawned script is found in the test's own package before the repo root", async () => {
  const { reachedFiles } = await import("../core/tests.mjs");
  const r = gitRepo({
    "scripts/seed.mjs": "export {};\n",
    "apps/api/package.json": "{}",
    "apps/api/scripts/seed.mjs": "export {};\n",
    "apps/api/test/a.test.mjs": 'import { spawnSync } from "node:child_process";\nspawnSync("node", ["scripts/seed.mjs"]);\n',
  });
  const got = [...reachedFiles(r.repo, "apps/api/test/a.test.mjs")];
  r.done();
  assert.deepEqual(got, ["apps/api/scripts/seed.mjs"]);
});

test("coverage: no temp folder is left behind when coverage isn't available", async () => {
  const { fileCoverage } = await import("../core/tests.mjs");
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("veridic-cov-")));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-nocov2-"));
  fs.writeFileSync(path.join(repo, "package.json"), "{}");
  fileCoverage(repo, "vitest", "a.test.ts");
  fileCoverage(repo, "mocha", "a.test.ts");
  fs.rmSync(repo, { recursive: true, force: true });
  const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("veridic-cov-") && !before.has(f));
  assert.deepEqual(after, []);
});
