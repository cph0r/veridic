import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSpec, checkCitations, rangeWarnings } from "../core/citations.mjs";
import { parseDiff, touches, shiftLine, staleness } from "../core/staleness.mjs";

const tmp = [];
after(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const mkdir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-cite-"));
  tmp.push(d);
  return d;
};

const SPEC = `# Spec
> Paths are relative to \`src/\`. \`svc\` = \`services/orders.ts\`.

## Requirements
- **FR-001**: Orders are validated. [evidence: svc:2-3]
- **FR-002**: Missing file. [evidence: nope.ts:1]
  continuation [evidence: svc:9]
| SC-001 | measured | [evidence: src/services/orders.ts:5] |

## Edge Cases
- Off by one. [evidence: svc:4, svc:6-7]
`;

const SRC = ["export function place(o) {", "  if (!o) throw new Error('x');", "  return save(o);", "}", "", "export const y = 1;", "}"].join("\n") + "\n";

test("parseSpec reads aliases, base dirs, labels and heading fallbacks", () => {
  const p = parseSpec(SPEC);
  assert.deepEqual(p.aliases, { svc: "services/orders.ts" });
  assert.deepEqual(p.bases, ["src"]);
  assert.deepEqual(
    p.citations.map((c) => [c.fr, c.cite]),
    [
      ["FR-001", "svc:2-3"],
      ["FR-002", "nope.ts:1"],
      ["FR-002", "svc:9"],
      ["SC-001", "src/services/orders.ts:5"],
      ["Edge Cases (line 11)", "svc:4"],
      ["Edge Cases (line 11)", "svc:6-7"],
    ],
  );
});

test("checkCitations resolves, includes cited text, and flags likely off-by-N ranges", () => {
  const repo = mkdir();
  fs.mkdirSync(path.join(repo, "src/services"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src/services/orders.ts"), SRC);
  const r = checkCitations(repo, SPEC, { files: ["src/services/orders.ts"] });
  const by = Object.fromEntries(r.citations.map((c) => [c.cite, c]));
  assert.equal(by["svc:2-3"].resolves, true);
  assert.equal(by["svc:2-3"].text, "  if (!o) throw new Error('x');\n  return save(o);");
  assert.equal(by["nope.ts:1"].problem, "file not found");
  assert.match(by["svc:9"].problem, /outside src\/services\/orders.ts \(7 lines\)/);
  assert.deepEqual(by["svc:4"].warnings, ["starts on a closing brace"]);
  assert.equal(by["src/services/orders.ts:5"].warnings[0], "starts on a blank line");
  assert.equal(by["svc:6-7"].warnings, undefined);
  assert.deepEqual(r.summary, { citations: 6, resolving: 4, unresolved: 2, with_warnings: 2, requirements: 4 });
});

test("rangeWarnings", () => {
  assert.deepEqual(rangeWarnings(["  });", "x"]), ["starts on a closing brace"]);
  assert.deepEqual(rangeWarnings(["} else {"]), []);
  assert.deepEqual(rangeWarnings(["const a = 1;"]), []);
});

test("parseDiff, touches and shiftLine", () => {
  const files = parseDiff(`diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -3,2 +3,0 @@ ctx
@@ -10,0 +9,4 @@ ctx
diff --git a/old.ts b/new.ts
similarity index 90%
rename from old.ts
rename to new.ts
@@ -5 +5 @@
diff --git a/gone.ts b/gone.ts
deleted file mode 100644
@@ -1,3 +0,0 @@
`);
  const a = files.get("a.ts");
  assert.deepEqual(a.hunks.map((h) => [h.a, h.b, h.c, h.d]), [[3, 2, 3, 0], [10, 0, 9, 4]]);
  assert.equal(files.get("old.ts").status, "renamed");
  assert.equal(files.get("old.ts").new, "new.ts");
  assert.equal(files.get("gone.ts").status, "deleted");

  assert.equal(touches(a.hunks[0], 4, 8), true); // deletes lines 3-4
  assert.equal(touches(a.hunks[0], 5, 8), false);
  assert.equal(touches(a.hunks[1], 8, 12), true); // insertion after line 10, inside 8-12
  assert.equal(touches(a.hunks[1], 11, 12), false); // insertion before the range
  assert.equal(shiftLine(a.hunks, 7), 5); // two lines deleted above
  assert.equal(shiftLine(a.hunks, 11), 13); // and four inserted after line 10
});

test("staleness flags edited, deleted and renamed citations in a real git range", () => {
  const repo = mkdir();
  const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  const write = (f, lines) => fs.writeFileSync(path.join(repo, f), lines.join("\n") + "\n");
  const ten = (p) => Array.from({ length: 10 }, (_, i) => `${p}${i + 1}`);
  write("a.ts", ten("a"));
  write("b.ts", ten("b"));
  write("c.ts", ten("c"));
  write("d.ts", ten("d"));
  g("add", ".");
  g("commit", "-qm", "base");

  write("a.ts", ["new0", ...ten("a").slice(0, 6), "a7 changed", ...ten("a").slice(7)]); // edit line 7, insert above
  fs.rmSync(path.join(repo, "b.ts"));
  g("mv", "c.ts", "c2.ts");
  g("add", "-A");
  g("commit", "-qm", "change");

  const spec = `- **FR-001**: edited [evidence: a.ts:6-8]
- **FR-002**: shifted only [evidence: a.ts:2-3]
- **FR-003**: deleted [evidence: b.ts:1]
- **FR-004**: renamed [evidence: c.ts:4-5]
- **FR-005**: untouched [evidence: d.ts:1]
`;
  const r = staleness(repo, spec, { range: "HEAD~1..HEAD" });
  assert.deepEqual(
    r.stale.map((s) => [s.fr, s.change, s.renamed_to ?? null]),
    [
      ["FR-001", "edited", null],
      ["FR-003", "deleted", null],
    ],
  );
  // A rename that leaves the cited lines intact is a safe move, not a stale requirement.
  assert.deepEqual(r.shifted.map((s) => [s.fr, s.now]), [["FR-002", "a.ts:3-4"], ["FR-004", "c2.ts:4-5"]]);
  assert.deepEqual(r.fixes.map((f) => [f.fr, f.replacement]), [["FR-002", "a.ts:3-4"], ["FR-004", "c2.ts:4-5"]]);
  assert.equal(r.untouched, undefined);
  assert.equal(r.summary.untouched, 1);
  assert.deepEqual(r.summary.stale_requirements, ["FR-001", "FR-003"]);
  // The insertion above line 1 is a change in a cited file that no citation covers.
  assert.deepEqual(r.uncovered_hunks, [{ file: "a.ts", hunks: ["@@ -0,0 +1 @@"] }]);
});

test("citations: checked by their text", async () => {
  const { citeHash, textCheck, parseSpec, makeResolver } = await import("../core/citations.mjs");
  const { formatCite } = await import("../core/anchors.mjs");
  const fsm = await import("node:fs"), osm = await import("node:os"), pm = await import("node:path");
  const repo = fsm.mkdtempSync(pm.join(osm.tmpdir(), "veridic-hash-"));
  const write = (t) => fsm.writeFileSync(pm.join(repo, "a.ts"), t);
  const body = ["export function pay(order) {", "  if (order.paid) throw new Error('paid');", "  order.paid = true;", "}"];
  write(body.join("\n") + "\n");
  const hash = citeHash(body.slice(1, 3));
  assert.match(hash, /^[0-9a-f]{6}$/);
  assert.equal(citeHash(["  " + body[1].trim() + "   ", body[2]]), hash, "whitespace around a line doesn't matter");
  const parsed = parseSpec(`- **FR-001**: pays once [evidence: a.ts:2-3#pay@1~${hash}]\n- **FR-002**: old [evidence: a.ts:2-3]\n`);
  assert.deepEqual(parsed.citations[0], { fr: "FR-001", spec_line: 1, cite: `a.ts:2-3#pay@1~${hash}`, file: "a.ts", start: 2, end: 3, anchor: { name: "pay", line: 1 }, hash });
  assert.equal(formatCite("a.ts", 2, 3, { name: "pay", line: 1 }, hash), `a.ts:2-3#pay@1~${hash}`);
  const resolve = makeResolver(repo, { files: ["a.ts"] });
  const check = () => textCheck(repo, parsed.citations[0], resolve);
  assert.deepEqual(check(), { state: "fresh" });
  assert.deepEqual(textCheck(repo, parsed.citations[1], resolve), { state: "unhashed" });
  write(["// header", "// more", ...body].join("\n") + "\n");
  assert.deepEqual(check(), { state: "moved", start: 4, end: 5 });
  write([body[0], "  if (order.paid) return;", body[2], body[3]].join("\n") + "\n");
  assert.deepEqual(check(), { state: "stale" });
  // The same lines twice: the copy nearest the old place wins.
  const filler = Array.from({ length: 14 }, (_, i) => `// ${i}`);
  write([...Array(6).fill("//"), body[1], body[2], ...filler, body[1], body[2]].join("\n") + "\n");
  assert.deepEqual(check(), { state: "moved", start: 7, end: 8 });
  fsm.rmSync(repo, { recursive: true, force: true });
});
