// Reading specs as the spec agents write them: story headings, success criteria.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseStoryHeading, storyHeadingProblems, specDoc } from "../core/report.mjs";

test("stories: the heading forms spec agents write", () => {
  const cases = [
    ["User Story 2 - Pay (Priority: P1)", "P1"],
    ["Story 2: Pay (P1)", "P1"],
    ["Story 2 - Pay", null],
    ["US-2: Pay [P2]", "P2"],
    ["User Story 2: Pay (Priority: P3)", "P3"],
  ];
  for (const [h, priority] of cases) assert.deepEqual(parseStoryHeading(h), { n: 2, title: "Pay", priority }, h);
  assert.equal(parseStoryHeading("Storyboard notes"), null);
  assert.equal(parseStoryHeading("Stories"), null);
  assert.deepEqual(storyHeadingProblems("### Story two: Pay\n### Story 3: Ok (P1)"), [{ line: 1, heading: "Story two: Pay" }]);
  const doc = specDoc("# Spec: Orders\n\n## User Scenarios\n\n### Story 1: See my apps (P1)\n\n### Story 2: Go back (P2)\n");
  assert.deepEqual(doc.stories.map((s) => [s.n, s.title, s.priority]), [[1, "See my apps", "P1"], [2, "Go back", "P2"]]);
});

test("check: warns about story-like headings it can't read, without failing", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-stories-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  const spec = path.join(repo, "spec.md");
  fs.writeFileSync(spec, "# Spec: A\n\n### Story two: Pay\n\n- **FR-001**: a is one [evidence: a.ts:1]\n");
  const r = spawnSync(process.execPath, [path.resolve("skill/scripts/cite.mjs"), "--repo", repo, "--spec", spec], { encoding: "utf8" });
  fs.rmSync(repo, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.story_warnings, ['spec.md:3 "Story two: Pay" looks like a story but isn\'t read']);
});

test("success criteria are criteria, not untested rules", async () => {
  const { ruleIds } = await import("../core/worklist.mjs");
  const { testCoverage } = await import("../core/tests.mjs");
  const spec = "# Spec: A\n\n## Requirements\n\n- **FR-001**: a is one [evidence: a.ts:1]\n- **FR-002**: b is two [evidence: a.ts:2]\n\n## Success Criteria\n\n- **SC-001**: every a is one [evidence: a.ts:1]\n- SC-002: nothing breaks\n";
  assert.deepEqual(ruleIds(spec), ["FR-001", "FR-002"]);
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-sc-"));
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "."], { cwd: repo });
  const cov = testCoverage(repo, spec);
  fs.rmSync(repo, { recursive: true, force: true });
  assert.deepEqual(cov.requirements.map((r) => r.id), ["FR-001", "FR-002"]);
  assert.deepEqual(cov.criteria.map((c) => c.id), ["SC-001", "SC-002"]);
  assert.equal(cov.summary.requirements, 2);
  assert.deepEqual(specDoc(spec).criteria, [{ id: "SC-001", text: "every a is one" }, { id: "SC-002", text: "nothing breaks" }]);
});

const tempRepo = (files) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-ids-"));
  for (const [f, t] of Object.entries(files)) fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }), fs.writeFileSync(path.join(repo, f), t);
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync("git", ["add", "."], { cwd: repo });
  return { repo, read: (f) => fs.readFileSync(path.join(repo, f), "utf8"), done: () => fs.rmSync(repo, { recursive: true, force: true }) };
};

test("link: an id two specs use is always written qualified, and a bare title is repaired, not refused", async () => {
  const { linkTests, sharedRuleIds } = await import("../core/link.mjs");
  const r = tempRepo({
    "specs/apps/spec.md": "- **INV-3**: apps hold [evidence: a.ts:1]\n- **FR-001**: only here [evidence: a.ts:1]\n",
    "specs/auth/spec.md": "- **INV-3**: auth holds [evidence: a.ts:1]\n",
    "a.ts": "export const a = 1;\n",
    "t.test.ts": 'test("rejects", () => {});\ntest("INV-3: rejects twice", () => {});\ntest("FR-001: once", () => {});\n',
  });
  const shared = sharedRuleIds(r.repo);
  assert.deepEqual([...shared], ["INV-3"]);
  const res = linkTests(r.repo, [{ id: "INV-3", at: "t.test.ts:1" }, { id: "INV-3", at: "t.test.ts:2" }, { id: "FR-001", at: "t.test.ts:3" }], { module: "apps", qualify: shared });
  const t = r.read("t.test.ts");
  r.done();
  assert.match(t, /test\("INV-3 \(apps\): rejects"/);
  assert.match(t, /test\("INV-3 \(apps\): rejects twice"/);
  assert.match(t, /test\("FR-001: once"/);
  assert.deepEqual(res.skipped.map((s) => s.reason), ["already named FR-001"]);
});

test("tests: a bare id two specs use counts for neither and is listed as ambiguous", async () => {
  const { testCoverage } = await import("../core/tests.mjs");
  const r = tempRepo({
    "specs/apps/spec.md": "- **INV-3**: apps hold [evidence: a.ts:1]\n",
    "specs/auth/spec.md": "- **INV-3**: auth holds [evidence: a.ts:1]\n",
    "a.ts": "export const a = 1;\n",
    "a.test.ts": 'import { a } from "./a";\ntest("INV-3: holds", () => { expect(a).toBe(1); });\n',
  });
  const cov = testCoverage(r.repo, r.read("specs/apps/spec.md"), { specPath: path.join(r.repo, "specs/apps/spec.md") });
  r.done();
  assert.equal(cov.requirements[0].status, "ambiguous");
  assert.deepEqual(cov.ambiguous, [{ id: "INV-3", at: "a.test.ts:2" }]);
});

test("init: --card is accepted", () => {
  const r = tempRepo({ "a.ts": "export const a = 1;\n" });
  const out = spawnSync(process.execPath, [path.resolve("skill/scripts/init.mjs"), "--repo", r.repo, "--card", "--bogus-flag"], { encoding: "utf8" });
  r.done();
  // Parsing stops at the first unknown option: with --card accepted, that's --bogus-flag.
  assert.match(out.stdout + out.stderr, /unknown option --bogus-flag/);
});

test("tests --spec --link: a spec that isn't a part; traceability rewritten, hand-reviewed rows kept apart", () => {
  const r = tempRepo({
    "specs/server/spec.md": "- **FR-001**: a is one [evidence: src/a.mjs:1]\n- **FR-002**: b [evidence: src/a.mjs:2]\n",
    "specs/other/spec.md": "- **FR-001**: elsewhere [evidence: src/a.mjs:1]\n",
    "specs/server/traceability.md": "| FR | old |\n|---|---|\n| FR-001 | covered |\n\n## Reviewed by hand\n\n| FR | Why |\n|---|---|\n| FR-002 | checked in staging |\n",
    "src/a.mjs": "export const a = 1;\nexport const b = 2;\n",
    "test/a.test.mjs": 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { a } from "../src/a.mjs";\ntest("a is one", () => { assert.equal(a, 1); });\n',
    "package.json": JSON.stringify({ name: "x", type: "module" }),
  });
  const out = spawnSync(process.execPath, [path.resolve("skill/scripts/tests.mjs"), "--repo", r.repo, "--spec", path.join(r.repo, "specs/server/spec.md"), "--link", "FR-001=test/a.test.mjs:4"], { encoding: "utf8" });
  const t = r.read("test/a.test.mjs"), trace = r.read("specs/server/traceability.md");
  const run = spawnSync(process.execPath, [path.resolve("skill/scripts/tests.mjs"), "--repo", r.repo, "--module", "server", "--run", "--json"], { encoding: "utf8" });
  r.done();
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(t, /test\("FR-001 \(server\): a is one"/, "FR-001 is in two specs: written qualified");
  assert.match(trace, /\| FR-001 \|.*\| covered \|/);
  assert.match(trace, /## Reviewed by hand\n\n\| FR \| Why \|\n\|---\|---\|\n\| FR-002 \| checked in staging \|/);
  assert.match(trace, /\*\*Totals:\*\* 2 requirements: 1 covered/);
  const j = JSON.parse(run.stdout);
  assert.equal(j.requirements.find((x) => x.id === "FR-001").status, "passing", run.stdout.slice(0, 300));
});
