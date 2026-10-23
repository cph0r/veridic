import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { makeRepo } from "./fixture.mjs";
import { parseSpec, checkCitations } from "../core/citations.mjs";
import { openSymbols, enclosingSymbol, applyEdits, lineMentions } from "../core/anchors.mjs";
import { fixSpec, prCheck, stampSpec } from "../core/staleness.mjs";
import { guard } from "../core/guard.mjs";

const repos = [];
after(() => repos.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// The fixture repo under git, with the index ignored like a real one.
function gitRepo() {
  const repo = makeRepo();
  repos.push(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".codegraph/\n");
  const g = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  g("add", ".");
  g("commit", "-qm", "base");
  return { repo, g };
}
const insertTop = (repo, file, lines) => {
  const p = path.join(repo, file);
  fs.writeFileSync(p, lines.join("\n") + "\n" + fs.readFileSync(p, "utf8"));
};
// What `codegraph sync` would do after insertTop: move the file's symbols down.
const syncIndex = (repo, file, by) => {
  const db = new DatabaseSync(path.join(repo, ".codegraph", "codegraph.db"));
  db.prepare("update nodes set start_line = start_line + ?, end_line = end_line + ? where file_path = ? and kind != 'file'").run(by, by, file);
  db.close();
};

test("parseSpec reads symbol anchors, including route names with spaces", () => {
  const { citations } = parseSpec("- **FR-001**: x [evidence: src/a.ts:4-5#placeOrder@3, src/r.ts:6#POST /orders@5, src/b.ts:2]");
  assert.deepEqual(
    citations.map((c) => [c.file, c.start, c.end, c.anchor ?? null]),
    [
      ["src/a.ts", 4, 5, { name: "placeOrder", line: 3 }],
      ["src/r.ts", 6, 6, { name: "POST /orders", line: 5 }],
      ["src/b.ts", 2, 2, null],
    ],
  );
});

test("enclosingSymbol picks the smallest symbol, and gives inline route handlers their route", () => {
  const repo = makeRepo();
  repos.push(repo);
  const syms = openSymbols(repo);
  const name = (f, a, b) => {
    const r = enclosingSymbol(syms, f, a, b);
    return r.symbol ? `${r.symbol.name}@${r.symbol.start}` : r.problem;
  };
  assert.equal(name("src/services/orders.ts", 4, 5), "placeOrder@3");
  assert.equal(name("src/routes/orders.ts", 6, 7), "POST /orders@5");
  assert.equal(name("src/jobs.ts", 2, 2), "expiry@2");
  assert.equal(name("src/app.ts", 1, 1), "no enclosing symbol");
});

test("checkCitations warns when an anchor line no longer mentions its symbol", () => {
  const repo = makeRepo();
  repos.push(repo);
  const r = checkCitations(repo, "- **FR-001**: x [evidence: src/services/orders.ts:4-5#placeOrder@3]\n- **FR-002**: y [evidence: src/services/orders.ts:4-5#placeOrder@6]");
  assert.equal(r.citations[0].warnings, undefined);
  assert.deepEqual(r.citations[1].warnings, ["anchor line 6 doesn't mention placeOrder"]);
});

test("fix moves an anchored citation when the index and the diff agree", () => {
  const { repo } = gitRepo();
  insertTop(repo, "src/services/orders.ts", ["// header", "// more"]);
  syncIndex(repo, "src/services/orders.ts", 2);
  const spec = "- **FR-001**: places [evidence: src/services/orders.ts:4-5#placeOrder@3]\n";
  const { result, spec: out, applied } = fixSpec(repo, spec, { range: "HEAD", symbols: openSymbols(repo) });
  assert.equal(applied, 1);
  assert.equal(result.fixes[0].method, "anchor+diff");
  assert.equal(out, "- **FR-001**: places [evidence: src/services/orders.ts:6-7#placeOrder@5]\n");
  assert.equal(result.stale.length, 0);
});

test("fix refuses to move a citation when the index is older than the code", () => {
  const { repo } = gitRepo();
  insertTop(repo, "src/services/orders.ts", ["// header", "// more"]); // no syncIndex
  const spec = "- **FR-001**: places [evidence: src/services/orders.ts:4-5#placeOrder@3]\n";
  const { result, applied } = fixSpec(repo, spec, { range: "HEAD", symbols: openSymbols(repo) });
  // Either the text check catches the old index, or the anchor and the diff
  // disagree; both leave the citation alone.
  assert.equal(applied, 0);
  assert.equal(result.conflicts.length, 1);
  assert.match(result.conflicts[0].problem, /index out of date|anchor says .* diff says/);
});

test("lineMentions accepts a route whose path wraps onto the next line", () => {
  const src = ["router.post(", '  "/public/orders",', "  async (req, res) => {"];
  assert.equal(lineMentions(src, 1, "POST /public/orders"), true);
  assert.equal(lineMentions(src, 3, "POST /public/orders"), false);
});

test("without an index, fix moves the range and the anchor line by the diff", () => {
  const { repo } = gitRepo();
  insertTop(repo, "src/services/orders.ts", ["// header"]);
  const spec = "- **FR-001**: places [evidence: src/services/orders.ts:4-5#placeOrder@3]\n- **FR-002**: plain [evidence: src/services/orders.ts:6]\n";
  const { spec: out, applied } = fixSpec(repo, spec, { range: "HEAD", symbols: null });
  assert.equal(applied, 2);
  assert.equal(out, "- **FR-001**: places [evidence: src/services/orders.ts:5-6#placeOrder@4]\n- **FR-002**: plain [evidence: src/services/orders.ts:7]\n");
});

test("edited code is never auto-fixed; it stays flagged", () => {
  const { repo } = gitRepo();
  const p = path.join(repo, "src/services/orders.ts");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('status: "awaiting_payment"', 'status: "pending"'));
  const spec = "- **FR-001**: holds for payment [evidence: src/services/orders.ts:5#placeOrder@3]\n";
  const { result, applied } = fixSpec(repo, spec, { range: "HEAD", symbols: openSymbols(repo) });
  assert.equal(applied, 0);
  assert.deepEqual(result.stale.map((s) => [s.fr, s.change]), [["FR-001", "edited"]]);
});

test("prCheck fails a PR that changes cited code without touching the spec, and passes one that does", () => {
  const { repo, g } = gitRepo();
  fs.writeFileSync(path.join(repo, "spec.md"), "- **FR-001**: holds for payment [evidence: src/services/orders.ts:5]\n- **FR-002**: logs [evidence: src/log.ts:2]\n");
  g("add", "spec.md");
  g("commit", "-qm", "spec");
  g("checkout", "-qb", "pr");
  const p = path.join(repo, "src/services/orders.ts");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('status: "awaiting_payment"', 'status: "pending"'));
  g("commit", "-qam", "code only");
  const bad = prCheck(repo, "spec.md", { range: "main...HEAD" });
  assert.deepEqual(bad.unaddressed.map((u) => u.fr), ["FR-001"]);

  fs.writeFileSync(path.join(repo, "spec.md"), "- **FR-001**: goes straight to the kitchen [evidence: src/services/orders.ts:5]\n- **FR-002**: logs [evidence: src/log.ts:2]\n");
  g("commit", "-qam", "spec updated");
  const good = prCheck(repo, "spec.md", { range: "main...HEAD" });
  assert.deepEqual(good.unaddressed, []);
  assert.equal(good.addressed, 1);
});

test("guard rewrites moved citations in place and reports edited ones", () => {
  const { repo } = gitRepo();
  // A spec not committed yet: its citations are judged by their hashes (render stamps them).
  const unstamped = "- **FR-001**: places [evidence: src/services/orders.ts:4-5#placeOrder@3]\n- **FR-002**: logs [evidence: src/log.ts:2]\n";
  fs.writeFileSync(path.join(repo, "spec.md"), stampSpec(repo, unstamped).spec);
  insertTop(repo, "src/services/orders.ts", ["// header"]);
  syncIndex(repo, "src/services/orders.ts", 1);
  fs.writeFileSync(path.join(repo, "src/log.ts"), "export function log(msg) {\n  console.error(msg);\n}\n");
  const report = guard(repo, { sync: false, env: { VERIDIC_SPECS: "spec.md" } });
  assert.equal(report.specs[0].fixed, 1);
  assert.equal(report.problems, 1);
  assert.deepEqual(report.specs[0].stale.map((s) => s.fr), ["FR-002"]);
  assert.match(fs.readFileSync(path.join(repo, "spec.md"), "utf8"), /orders\.ts:5-6#placeOrder@4~[0-9a-f]{6}/);
});

test("guard leaves an uncommitted spec without hashes alone: it can't know what its citations meant", () => {
  const { repo } = gitRepo();
  const text = "- **FR-001**: places [evidence: src/services/orders.ts:4-5#placeOrder@3]\n";
  fs.writeFileSync(path.join(repo, "spec.md"), text);
  insertTop(repo, "src/services/orders.ts", ["// header"]);
  syncIndex(repo, "src/services/orders.ts", 1);
  guard(repo, { sync: false, env: { VERIDIC_SPECS: "spec.md" } });
  assert.equal(fs.readFileSync(path.join(repo, "spec.md"), "utf8"), text);
});

test("applyEdits replaces each citation once, on its own line", () => {
  const { spec, applied } = applyEdits("a [evidence: x:1, x:1]\nb [evidence: x:1]", [
    { spec_line: 1, cite: "x:1", replacement: "x:2" },
    { spec_line: 1, cite: "x:1", replacement: "x:3" },
  ]);
  assert.equal(applied, 2);
  assert.equal(spec, "a [evidence: x:2, x:3]\nb [evidence: x:1]");
});

test("guard on a committed spec is idempotent: a second run changes nothing", () => {
  const { repo, g } = gitRepo();
  const specText = "- **FR-001**: places [evidence: src/services/orders.ts:4-5#placeOrder@3]\n- **FR-002**: plain [evidence: src/services/orders.ts:6]\n- **FR-003**: logs [evidence: src/log.ts:2]\n";
  fs.writeFileSync(path.join(repo, "spec.md"), specText);
  g("add", "spec.md");
  g("commit", "-qm", "spec");
  insertTop(repo, "src/services/orders.ts", ["// a", "// b"]);
  syncIndex(repo, "src/services/orders.ts", 2);
  fs.writeFileSync(path.join(repo, "src/log.ts"), "export function log(msg) {\n  console.error(msg);\n}\n");
  const env = { VERIDIC_SPECS: "spec.md" };

  const first = guard(repo, { sync: false, env });
  const afterFirst = fs.readFileSync(path.join(repo, "spec.md"), "utf8");
  assert.equal(first.specs[0].fixed, 2);
  assert.match(afterFirst, /orders\.ts:6-7#placeOrder@5/);
  assert.match(afterFirst, /orders\.ts:8\]/);
  assert.deepEqual(first.specs[0].stale.map((s) => s.fr), ["FR-003"]);

  const second = guard(repo, { sync: false, env });
  assert.equal(second.specs[0].fixed, 0);
  assert.deepEqual(second.specs[0].conflicts, []);
  assert.equal(fs.readFileSync(path.join(repo, "spec.md"), "utf8"), afterFirst);

  // Once the agent rewrites FR-003, nothing is left open.
  fs.writeFileSync(path.join(repo, "spec.md"), afterFirst.replace("**FR-003**: logs", "**FR-003**: logs errors"));
  const third = guard(repo, { sync: false, env });
  assert.equal(third.problems, 0);
});
