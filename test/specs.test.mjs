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
