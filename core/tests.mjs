// Requirement -> test traceability by name: a test whose title carries a
// requirement id (`it("FR-015: …")`) is that requirement's test. A test only
// counts as covering it if the test file reaches the code the requirement cites
// (imports it, directly or through one more relative import). With `run`, the
// linked test files are executed and each requirement gets passing/failing.
// A test file can bind itself to one spec with a `veridic-spec: <path>` comment.
// A named test counts only if it checks something: empty tests, tests with no
// assertion (or one on a literal, `expect(true).toBe(true)`) and skipped tests
// (`.skip`, `xit`, inside `describe.skip`) never cover a requirement. Tests whose
// only checks are loose (`toBeTruthy`, `toBeDefined`, bare `toHaveBeenCalled()`)
// count but are reported as weak.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { importResolver } from "./resolve.mjs";
import { testRecipe } from "./recipe.mjs";
import os from "node:os";
import path from "node:path";
import { parseSpec, makeResolver } from "./citations.mjs";
import { basisOf, basisComment } from "./basis.mjs";
import { openGraph } from "./graph.mjs";
import { routeInventory } from "./routes.mjs";

/** The name a qualified title uses for a spec file: its folder (specs/voice-conversation/spec.md -> voice-conversation). */
export const specQual = (specPath) => String(specPath ?? "").match(/(?:^|\/)([^/]+)\/[^/]*spec\.md$/)?.[1] ?? null;

const TEST_FILE = /(^|\/)(__tests__|tests?)\/.*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;
// Modifiers: skipped (todo, skip), focused, and expected to fail (vitest it.fails, jest test.failing).
const TITLE = /(?<![\w$.])(x?)(?:it|test|describe)(?:\.(todo|skip|only|concurrent|fails|failing))?\s*\(\s*(["'`])((?:(?!\3).)*)\3/g;
const REQ_ID = /\b((?:FR|SC|NFR|AC|INV)-\d+[a-z]?|R-[A-Z]{2,6}-\d{4})(?:\s*[·.:/-]?\s*(VC\d+))?\b/g;
// Domain test ids: T-<DOMAIN>-<req>.<vc>.<n>[-API|-UI]
const T_ID = /\bT-[A-Z]{2,6}-(\d{4})\.(\d+)\.\d+(?:-[A-Z]+)?\b/g;
// R-ORD-0001 and T-ORD-0001.… name spec requirement FR-001.
const toFr = (n) => `FR-${String(Number(n)).padStart(3, "0")}`;

const resolvers = new Map();
const relImports = (repo, file, files) => {
  let src = "";
  try {
    src = fs.readFileSync(path.join(repo, file), "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|vi\.mock\(\s*|jest\.mock\(\s*|require\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])).replace(/\.[cm]?js$/, "");
    for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}/index.ts`, `${base}/index.js`]) if (files.has(c)) out.push(c);
  }
  // Path aliases (`@/lib/apps`) and workspace packages (`@workspace/db`).
  if (!resolvers.has(repo)) resolvers.set(repo, importResolver(repo, { workspaces: true }));
  const resolve = resolvers.get(repo);
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|vi\.mock\(\s*|jest\.mock\(\s*|require\(\s*)["']([^."'][^"']*)["']/g)) {
    if (/^node:/.test(m[1])) continue;
    const hit = resolve(file, m[1]);
    if (hit && files.has(hit)) out.push(hit);
  }
  // A script it runs in a child process: spawn("node", ["scripts/seed.mjs"]), execFile("tsx", ["x.ts"]).
  for (const m of src.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(([^)]*)\)/g))
    for (const a of m[1].matchAll(/["'`](\.{0,2}\/?[\w@.\/-]+\.(?:[cm]?[jt]s|sh|py))["'`]/g)) {
      const rel = a[1].replace(/^\.\//, "");
      const near = path.posix.dirname(file);
      for (const c of [rel, path.posix.normalize(path.posix.join(near, a[1])), ...pkgDirsOf(file).map((d) => path.posix.join(d, rel))]) if (files.has(c)) { out.push(c); break; }
    }
  return out;
};
// The folders above a file that hold a package.json-rooted project: scripts run from there.
const pkgDirsOf = (file) => { const out = []; for (let d = path.posix.dirname(file); d && d !== "."; d = path.posix.dirname(d)) out.push(d); return out; };

/** The repo files a test file reaches: imports (relative, aliases, workspace packages) and the scripts it spawns. */
export function reachedFiles(repo, file, levels = 2) {
  const files = new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean));
  return reach(repo, file, files, levels);
}

/** Files a test file reaches through relative imports, `levels` deep (two by default). */
function reach(repo, file, files, levels = 2) {
  const seen = new Set([file]);
  let frontier = [file];
  for (let depth = 0; depth < levels; depth++) {
    const next = [];
    for (const f of frontier) for (const g of relImports(repo, f, files)) if (!seen.has(g)) seen.add(g), next.push(g);
    frontier = next;
  }
  seen.delete(file);
  return seen;
}

// Assertions, after comments and strings are blanked. An assertion on a literal checks nothing.
// Custom assertion helpers count (`cy.expectChallengeSolved(…)`, `assertOrderPaid(…)`), and
// `cy.request(…)`, which fails the test on an error status by default.
const ASSERT = /\bexpect\s*\(|\bexpect\s*\.\s*(?:poll|soft|element)\s*\(|\bassert\w*\s*[.(]|\.should\b|\bt\.(?:is|not|true|false|deepEqual|throws\w*|regex|like|assert)\s*\(|\b(?:expect|assert|verify|check|should)[A-Z]\w*\s*(?:<[^()]*>)?\s*\(|\bcy\.(?:request|contains|get)\s*\(|\.and\s*\(\s*["'`]|\.waitFor(?:URL|Selector)\s*\(/;
// Only bare `expect(true)`: supertest's `.expect(200)` checks the response status.
const LITERAL_EXPECT = /(?<![\w$.])expect\s*\(\s*(?:true|false|null|undefined|-?\d+(?:\.\d+)?|""|''|``)\s*\)/g;
// Loose: passes for almost any value. `.not.toHaveBeenCalled()` and `toBeUndefined()` are exact, so not loose.
// `cy.get(…)` with nothing after it only checks the element exists.
const LOOSE = /\bcy\.get\s*\(|\.waitFor(?:URL|Selector)\s*\(|\.(?:toBeTruthy|toBeDefined|toBeFalsy)\s*\(\s*\)|\.not\.(?:toBeNull|toBeUndefined)\s*\(\s*\)|(?<!\.not)\.toHaveBeenCalled\s*\(\s*\)/g;

// A `/` starts a regex literal (not division) after an operator, an opening
// bracket, a comma, or a keyword like `return`.
const regexCanStart = (before) => {
  const t = before.trimEnd();
  if (!t) return true;
  if (/[(,=:[!&|?{};+\-*%~^<>]$/.test(t)) return true;
  return /\b(?:return|typeof|case|do|else|in|of|void|yield|await|throw|new|delete)$/.test(t);
};

// The closing backtick of the template opening at i, and the `}` closing an interpolation at k.
function templateEnd(src, i) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") j++;
    else if (src[j] === "`") return j;
    else if (src[j] === "$" && src[j + 1] === "{") j = exprEnd(src, j + 2);
  }
  return src.length;
}
function exprEnd(src, k) {
  let depth = 0;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === "`") k = templateEnd(src, k);
    else if (c === '"' || c === "'") {
      for (k++; k < src.length && src[k] !== c && src[k] !== "\n"; k++) if (src[k] === "\\") k++;
    } else if (c === "{") depth++;
    else if (c === "}" && depth-- === 0) return k;
  }
  return src.length;
}

/** Blank comments, string contents and regex literals (keeping offsets), so code checks don't see them. */
export function codeOnly(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") (out += " "), i++;
      out += src[i] ?? "";
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (c === "/" && regexCanStart(out)) {
      // A regex literal (`/a href="([^"]+)"/g`): its quotes aren't strings. Blank its body.
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[") (inClass = true), j++;
        else if (src[j] === "]") (inClass = false), j++;
        else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      if (src[j] !== "/") out += c; // not a regex after all (division at line end)
      else {
        out += `/${" ".repeat(j - i - 1)}/`;
        i = j;
      }
    } else if (c === "`") {
      // A template literal: its text is blanked, its `${…}` parts are code (and may hold templates).
      const end = templateEnd(src, i);
      out += "`";
      for (let j = i + 1; j < end; ) {
        if (src[j] === "\\") (out += src[j + 1] === "\n" ? " \n" : "  "), (j += 2);
        else if (src[j] === "$" && src[j + 1] === "{") {
          const close = exprEnd(src, j + 2);
          out += "${" + codeOnly(src.slice(j + 2, close)) + (close < end ? "}" : "");
          j = close + 1;
        } else (out += src[j] === "\n" ? "\n" : " "), j++;
      }
      out += src[end] ?? "";
      i = end;
    } else if (c === '"' || c === "'") {
      out += c;
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") (out += "  "), j += 2;
        else (out += src[j] === "\n" ? "\n" : " "), j++;
      }
      out += src[j] ?? "";
      i = j;
    } else out += c;
  }
  return out;
}

/** Index of the paren closing the call whose argument list starts at `from` (just after its `(`), in blanked code. */
function closeParen(code, from) {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return i;
  }
  return code.length;
}

// Test cases in a file: `it("…", fn)`, and table-driven `test.each([…])("…", fn)` /
// test.each`table`("…", fn), each counted once.
const EACH = /(?<![\w$.])(x?)(?:it|test)(?:\.(skip|only|concurrent))?\.each\s*(?:<[^()]*?>)?\s*([(`])/g;
function* testCases(src, code) {
  for (const t of src.matchAll(TITLE)) {
    if (code[t.index] === " " || /^x?describe/.test(t[0])) continue;
    const bodyEnd = closeParen(code, t.index + t[0].indexOf("(") + 1);
    // Mocha's `it("title")` with no function is pending: a reminder, not a test that runs.
    const pending = !/\S/.test(code.slice(t.index + t[0].length, bodyEnd).replace(/,/g, ""));
    yield { index: t.index, x: t[1] === "x", mod: pending ? "todo" : t[2], title: t[4], bodyStart: t.index + t[0].length, bodyEnd };
  }
  for (const m of code.matchAll(EACH)) {
    const tableOpen = m.index + m[0].length;
    const tableEnd = m[3] === "(" ? closeParen(code, tableOpen) : code.indexOf("`", tableOpen);
    if (tableEnd < 0) continue;
    const call = src.slice(tableEnd + 1).match(/^\s*\(\s*(["'`])((?:(?!\1)[^\n])*)\1/);
    if (!call) continue;
    const titleCall = tableEnd + 1 + call[0].indexOf("(") + 1;
    yield { index: m.index, x: m[1] === "x", mod: m[2], title: call[2], bodyStart: tableEnd + 1 + call[0].length, bodyEnd: closeParen(code, titleCall) };
  }
}

// A title that promises only that nothing fails ("should pass", "is a no-op", "does not
// throw"): awaiting or returning the call is the check, a loose one.
const NO_THROW_TITLE = /\b(?:should pass|passes|(?:does ?n[o']t|not|never|without) (?:throw|fail|error|crash)\w*|no-?op|succeeds?|works?|resolves?)\b/i;

/** How much a test body checks: empty | unasserted | weak | strong. */
export function testStrength(body, helpers = null) {
  if (!body.replace(/\basync\b|\bfunction\b|=>|[(){},;\s]|\b(?:done|ctx|t)\b/g, "")) return "empty";
  const real = body.replace(LITERAL_EXPECT, "literal(");
  const viaHelper = helpers ? (real.match(helpers) ?? []).length : 0;
  if (!ASSERT.test(real) && !viaHelper) return "unasserted";
  const total = (real.match(new RegExp(ASSERT.source, "g")) ?? []).length + viaHelper;
  const loose = (real.match(LOOSE) ?? []).length;
  return loose >= total ? "weak" : "strong";
}

/** The env flags a repo's tests are run with: this process's, plus `.veridic.json` "testEnv". */
const envOf = (repo) => {
  let extra = {};
  try {
    extra = JSON.parse(fs.readFileSync(path.join(repo, ".veridic.json"), "utf8")).testEnv ?? {};
  } catch {}
  return { ...process.env, ...extra };
};

/**
 * Test blocks gated on an env flag that isn't set: `describe.skipIf(!process.env.X)(…)`,
 * `it.runIf(process.env.X)(…)`, `(process.env.X ? describe : describe.skip)(…)`.
 * -> { gates: [[start, end, "X"]], matchable }: `matchable` is the source with each gate's
 * condition blanked (same length), so `describe(…)`'s title is found as usual.
 */
function envGates(src, code, env) {
  const gates = [];
  let matchable = src;
  const blank = (a, b) => (matchable = matchable.slice(0, a) + " ".repeat(b - a) + matchable.slice(b));
  const flag = (cond) => cond.match(/\b(?:process\.env|import\.meta\.env)\.(\w+)/)?.[1] ?? null;
  for (const m of code.matchAll(/\b(?:it|test|describe)(\.(?:skipIf|runIf)\s*\()/g)) {
    const condOpen = m.index + m[0].length;
    const condClose = closeParen(code, condOpen);
    const cond = src.slice(condOpen, condClose);
    const name = flag(cond);
    const call = code.indexOf("(", condClose + 1);
    if (!name || call < 0) continue;
    blank(m.index + m[0].length - m[1].length, condClose + 1);
    // skipIf(!X) / runIf(X): runs only with X set. skipIf(X) / runIf(!X): runs only without it.
    // A condition other than a bare flag or its negation isn't read.
    const neg = /^\s*!\s*(?:process\.env|import\.meta\.env)\.\w+\s*$/.test(cond);
    if (!neg && !/^\s*(?:process\.env|import\.meta\.env)\.\w+\s*$/.test(cond)) continue;
    const needsSet = m[1].startsWith(".skipIf") ? neg : !neg;
    if (needsSet ? !env[name] : !!env[name]) gates.push([m.index, closeParen(code, call + 1), needsSet ? name : `${name} unset`]);
  }
  for (const m of code.matchAll(/\(\s*(?:process\.env|import\.meta\.env)\.(\w+)\s*\?\s*(describe|it|test)\s*:\s*\2\.skip\s*\)\s*\(/g)) {
    const end = m.index + m[0].length - 1;
    blank(m.index, end);
    matchable = matchable.slice(0, end - m[2].length) + m[2] + matchable.slice(end);
    if (!env[m[1]]) gates.push([m.index, closeParen(code, end + 1), m[1]]);
  }
  return { gates, matchable };
}

/** Every test title in the repo that names a requirement id. */
export function findTaggedTests(repo, files) {
  const out = [];
  for (const file of files) {
    if (!TEST_FILE.test(file) || file.includes("node_modules/")) continue;
    const src = fs.readFileSync(path.join(repo, file), "utf8");
    const bound = src.match(/(?:veridic|plumb|specguard)-spec:\s*(\S+)/)?.[1] ?? null;
    const code = codeOnly(src);
    // Ranges of skipped describe blocks: tests inside them never run.
    const skipped = [...code.matchAll(/\b(?:xdescribe|describe\.skip)\s*\(/g)].map((m) => [m.index, closeParen(code, m.index + m[0].length)]);
    const lineOf = (idx) => src.slice(0, idx).split("\n").length;
    // Blocks that run only when an env flag is set; `matchable` blanks the gate so the title reads as usual.
    const { gates, matchable } = envGates(src, code, envOf(repo));
    for (const t of matchable.matchAll(TITLE)) {
      if (code[t.index] === " ") continue; // inside a comment or string
      const ids = [
        ...[...t[4].matchAll(REQ_ID)].map((m) => ({ id: /^R-/.test(m[1]) ? toFr(m[1].split("-").pop()) : m[1], vc: m[2] ?? null })),
        ...[...t[4].matchAll(T_ID)].map((m) => ({ id: toFr(m[1]), vc: `VC${Number(m[2])}` })),
      ];
      if (!ids.length) continue;
      const open = t.index + t[0].indexOf("(") + 1;
      const body = code.slice(t.index + t[0].length, closeParen(code, open));
      const todo = t[2] === "todo" || t[2] === "skip" || t[1] === "x" || skipped.some(([a, b]) => t.index > a && t.index < b);
      const strength = todo ? null : testStrength(body);
      // Expected to fail: the test proves the code currently breaks the rule. Frameworks with no
      // such marker (mocha, node:test) skip the test with "[broken]" in its title: broken, not proven.
      const expectFail = t[2] === "fails" || t[2] === "failing";
      const brokenSkip = todo && /\[broken\]/i.test(t[4]);
      const needs = gates.find(([a, b]) => t.index >= a && t.index < b)?.[2] ?? null;
      for (const { id, vc } of ids) {
        // "FR-001 (orders): …": the rule belongs to module orders (ids repeat across specs).
        const qual = t[4].match(new RegExp(`\\b${id}\\s*\\(([\\w-]+)\\)`))?.[1] ?? null;
        out.push({ id, vc, file, line: lineOf(t.index), title: t[4], todo: todo || !!needs, strength, spec: bound, expectFail, brokenSkip, qual, ...(needs ? { needs } : {}) });
      }
    }
  }
  return out;
}

/**
 * Every test in the repo, classified by what it checks (no spec needed):
 * strong, weak (only loose checks), unasserted, empty, or skipped.
 * Parameterized tests (`it.each`) aren't classified.
 */
export function auditTests(repo) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/"));
  const counts = { strong: 0, weak: 0, unasserted: 0, empty: 0, skipped: 0 };
  const flagged = { weak: [], unasserted: [], empty: [] };
  let testFiles = 0;
  for (const file of files) {
    const a = auditFile(repo, file);
    for (const k of Object.keys(counts)) counts[k] += a.counts[k];
    for (const k of Object.keys(flagged)) flagged[k].push(...a.flagged[k]);
    if (a.tests) testFiles++;
  }
  const live = counts.strong + counts.weak + counts.unasserted + counts.empty;
  return {
    summary: { test_files: testFiles, tests: live + counts.skipped, ...counts, checking_pct: live ? Math.round(((counts.strong + counts.weak) / live) * 1000) / 10 : null },
    flagged,
  };
}

/** One test file's tests, by what they check. */
// Functions the test file defines whose bodies assert (`const refused = (msg) => { expect(…) }`),
// and those that call them: a call to one is an assertion.
function localHelpers(code) {
  const defs = [];
  for (const m of code.matchAll(/(?:\bfunction\s+([A-Za-z_$][\w$]*)\s*\(|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\([^()]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>))/g)) {
    const after = m.index + m[0].length;
    // An expression-bodied arrow (`(x) => expect(x)…`): the body runs to the end of the statement.
    if (m[0].endsWith("=>") && !/^\s*\{/.test(code.slice(after))) {
      defs.push({ name: m[2], body: code.slice(after, after + Math.max(0, code.slice(after).search(/;|\n\s*\n|$/))) });
      continue;
    }
    // Past the parameters, which may destructure (`function check({ a, b }) {`).
    const params = m[1] || /\($/.test(m[0]) ? closeParen(code, after) : after;
    const brace = code.indexOf("{", params);
    if (brace < 0 || /;/.test(code.slice(params, brace))) continue;
    let depth = 0, end = brace;
    for (; end < code.length; end++) {
      if (code[end] === "{") depth++;
      else if (code[end] === "}" && --depth === 0) break;
    }
    defs.push({ name: m[1] ?? m[2], body: code.slice(brace, end) });
  }
  const asserting = new Set(defs.filter((d) => ASSERT.test(d.body.replace(LITERAL_EXPECT, "literal("))).map((d) => d.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of defs) {
      if (asserting.has(d.name) || ![...asserting].some((n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, "\\$")}\\s*\\(`).test(d.body))) continue;
      asserting.add(d.name);
      grew = true;
    }
  }
  const re = asserting.size ? new RegExp(`(?<![\\w$.])(?:${[...asserting].map((n) => n.replace(/\$/g, "\\$")).join("|")})\\s*\\(`, "g") : null;
  return { re, bodies: new Map(defs.map((d) => [d.name, d.body])) };
}

export function auditFile(repo, file) {
  const counts = { strong: 0, weak: 0, unasserted: 0, empty: 0, skipped: 0 };
  const flagged = { weak: [], unasserted: [], empty: [] };
  let tests = 0;
  {
    const src = safeRead(repo, file);
    const code = codeOnly(src);
    const skipped = [...code.matchAll(/\b(?:xdescribe|describe\.skip)\s*\(/g)].map((m) => [m.index, closeParen(code, m.index + m[0].length)]);
    const { re: helpers, bodies } = localHelpers(code);
    for (const t of testCases(src, code)) {
      tests++;
      const skip = t.mod === "todo" || t.mod === "skip" || t.x || skipped.some(([x, y]) => t.index > x && t.index < y);
      if (skip) {
        counts.skipped++;
        continue;
      }
      // `test.each(table)("…", testStoragePath)`: the body is a function the file defines.
      const body = code.slice(t.bodyStart, t.bodyEnd);
      const named = body.match(/^\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*(?:\d+\s*)?$/)?.[1];
      let s = testStrength(named && bodies.has(named) ? bodies.get(named) : body, helpers);
      if (s === "unasserted" && NO_THROW_TITLE.test(t.title) && /\b(?:await|return)\b|=>\s*\w/.test(body)) s = "weak";
      counts[s]++;
      if (flagged[s]) flagged[s].push({ at: `${file}:${src.slice(0, t.index).split("\n").length}`, title: t.title.slice(0, 100) });
    }
  }
  return { file, tests, counts, flagged, asserting: counts.strong + counts.weak };
}

/** The tests in one file, each with its line, title and strength (skipped tests left out). */
export function testsIn(repo, file) {
  const src = safeRead(repo, file);
  const code = codeOnly(src);
  const skipped = [...code.matchAll(/\b(?:xdescribe|describe\.skip)\s*\(/g)].map((m) => [m.index, closeParen(code, m.index + m[0].length)]);
  const { re: helpers, bodies } = localHelpers(code);
  const out = [];
  for (const t of testCases(src, code)) {
    if (t.mod === "todo" || t.mod === "skip" || t.x || skipped.some(([x, y]) => t.index > x && t.index < y)) continue;
    const body = code.slice(t.bodyStart, t.bodyEnd);
    const named = body.match(/^\s*,\s*([A-Za-z_$][\w$]*)\s*,?\s*(?:\d+\s*)?$/)?.[1];
    out.push({ line: src.slice(0, t.index).split("\n").length, title: t.title, strength: testStrength(named && bodies.has(named) ? bodies.get(named) : body, helpers) });
  }
  return out;
}

/** Every test file in the repo. */
export function testFilesOf(repo) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .filter((f) => f && TEST_FILE.test(f) && !f.includes("node_modules/"));
}

/**
 * Test files that reach any of `targets` through relative imports (`levels` deep),
 * each with how many of its tests assert. Map target -> [{ file, asserting, tests }].
 */
export function testsReaching(repo, targets, { levels = 4 } = {}) {
  const all = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const files = new Set(all);
  const out = new Map(targets.map((t) => [t, []]));
  for (const tf of all.filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/"))) {
    const reached = reach(repo, tf, files, levels);
    const hits = targets.filter((t) => reached.has(t) || t === tf);
    if (!hits.length) continue;
    const a = auditFile(repo, tf);
    if (!a.tests) continue; // a helper inside __tests__/, not a test
    for (const t of hits) out.get(t).push({ file: tf, asserting: a.asserting, tests: a.tests });
  }
  return out;
}

/**
 * A runner's file path as the repo-relative path tests are keyed by. Runners report real
 * paths (/private/var/… on macOS) while the repo may be given through a link (/var/…).
 */
export function relKey(repo, file) {
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return path.relative(real(repo), real(file));
}

/** Run vitest on these files (from their package) and return results by test title. */
export function runVitest(repo, testFiles) {
  const byPkg = new Map();
  for (const f of testFiles) {
    let dir = path.dirname(path.join(repo, f));
    while (dir.startsWith(repo) && !fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    if (!byPkg.has(dir)) byPkg.set(dir, []);
    byPkg.get(dir).push(path.relative(dir, path.join(repo, f)));
  }
  const results = new Map(); // "file\0title" -> status
  const errors = [];
  for (const [pkg, files] of byPkg) {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "veridic-vitest-")), "out.json");
    const r = spawnSync("npx", ["--no-install", "vitest", "run", ...files, "--reporter=json", `--outputFile=${outFile}`], { cwd: pkg, encoding: "utf8", timeout: 600_000, env: testEnv(repo) });
    if (!fs.existsSync(outFile)) {
      errors.push({ package: path.relative(repo, pkg) || ".", error: (r.stderr || r.stdout || "vitest produced no report").slice(-800) });
      continue;
    }
    const report = JSON.parse(fs.readFileSync(outFile, "utf8"));
    for (const tf of report.testResults ?? []) {
      const rel = relKey(repo, tf.name);
      for (const a of tf.assertionResults ?? []) results.set(`${rel}\0${a.title}`, a.status); // passed | failed | pending | todo | skipped
      if (tf.status === "failed" && !(tf.assertionResults ?? []).length) errors.push({ file: rel, error: (tf.message ?? "suite failed to load").slice(0, 800) });
    }
  }
  return { results, errors };
}

// The package a test file belongs to: its nearest folder with a package.json.
function byPackage(repo, testFiles) {
  const out = new Map();
  for (const f of testFiles) {
    let dir = path.dirname(path.join(repo, f));
    while (dir.startsWith(repo) && !fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir);
    if (!out.has(dir)) out.set(dir, []);
    out.get(dir).push(f);
  }
  return out;
}

/** The app's routes ({ path, file }), from the code index; none when there's no index. Cached per repo. */
const routeCache = new Map();
function appRoutes(repo) {
  if (!routeCache.has(repo)) {
    let rs = [];
    try {
      rs = routeInventory(openGraph(repo)).routes.map((r) => ({ path: r.path, file: r.file }));
    } catch {}
    routeCache.set(repo, rs);
  }
  return routeCache.get(repo);
}

/**
 * The handler files of the routes a test calls by URL. A URL in a string or template, with
 * `${…}` as any value and any origin or base before it, matches the end of a route's path
 * (a test may leave out a mount prefix like /api), when it names at least two literal segments.
 */
export function urlHandlers(text, routes) {
  if (!routes?.length || !text) return [];
  const urls = [];
  for (const m of text.matchAll(/["'`]([^"'`\n]*\/[^"'`\n]*)["'`]/g)) {
    const u = m[1].replace(/\$\{[^}]*\}/g, ":").replace(/^[a-z]+:\/\/[^/]+/i, "").replace(/[?#].*$/, "");
    const segs = u.split("/").filter(Boolean);
    if (segs[0] === ":" && !u.startsWith("/")) segs.shift(); // `${base}/x`: the base, not a segment
    if (segs.filter((x) => x !== ":").length >= 2) urls.push(segs);
  }
  const out = new Set();
  for (const r of routes) {
    const rs = String(r.path).split("/").filter(Boolean);
    const hit = urls.some((u) => u.length <= rs.length && u.every((x, i) => { const y = rs[rs.length - u.length + i]; return x === ":" || y.startsWith(":") || y === "*" || x === y; }));
    if (hit && r.file) out.add(r.file);
  }
  return [...out];
}

/** The environment a project's tests need (`.veridic.json` "testEnv", e.g. { "DB_TESTS": "1" }), over this process's. */
function testEnv(repo, base = process.env) {
  let extra = {};
  try {
    extra = JSON.parse(fs.readFileSync(path.join(repo, ".veridic.json"), "utf8")).testEnv ?? {};
  } catch {}
  return { ...base, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, String(v)])) };
}

/** Run node:test files, one at a time, and return results by test title (TAP output). */
export function runNodeTest(repo, testFiles) {
  const results = new Map();
  const errors = [];
  for (const [pkg, files] of byPackage(repo, testFiles))
    for (const f of files) {
      // Inside a node:test run, NODE_TEST_CONTEXT makes a nested `node --test` report to its parent
      // instead of printing results: clear it so this run prints its own TAP.
      const { NODE_TEST_CONTEXT, ...env } = testEnv(repo);
      const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.relative(pkg, path.join(repo, f))], { cwd: pkg, encoding: "utf8", timeout: 600_000, env });
      if (r.error || r.status == null) {
        errors.push({ file: f, error: String(r.error?.message ?? "node --test did not run").slice(0, 800) });
        continue;
      }
      // TAP escapes # and \ in names (`a \# b`): unescape so names match the test titles.
      for (const m of (r.stdout ?? "").matchAll(/^\s*(not ok|ok) \d+ - (.*?)(?:\s+#\s*(SKIP|TODO).*)?$/gm)) results.set(`${f}\0${m[2].replace(/\\([#\\])/g, "$1")}`, m[3] ? "skipped" : m[1] === "ok" ? "passed" : "failed");
    }
  return { results, errors };
}

/** Run jest on these files (from their package) and return results by test title. */
export function runJest(repo, testFiles) {
  const results = new Map();
  const errors = [];
  for (const [pkg, files] of byPackage(repo, testFiles)) {
    const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "veridic-jest-")), "out.json");
    const r = spawnSync("npx", ["--no-install", "jest", ...files.map((f) => path.relative(pkg, path.join(repo, f))), "--json", `--outputFile=${outFile}`], { cwd: pkg, encoding: "utf8", timeout: 600_000, env: testEnv(repo) });
    if (!fs.existsSync(outFile)) {
      errors.push({ package: path.relative(repo, pkg) || ".", error: (r.stderr || r.stdout || "jest produced no report").slice(-800) });
      continue;
    }
    const report = JSON.parse(fs.readFileSync(outFile, "utf8"));
    for (const tf of report.testResults ?? []) {
      const rel = relKey(repo, tf.name);
      for (const a of tf.assertionResults ?? []) results.set(`${rel}\0${a.title}`, a.status);
    }
  }
  return { results, errors };
}

/** Run named test files with each package's own framework (from the test recipe). */
/** Each test file's framework (vitest, jest, node:test) from the repo's test recipes. */
function frameworkOfFile(repo, files) {
  const recipes = testRecipe(repo, files);
  return (f) => [...recipes.values()].filter((r) => r.dir === "." || f.startsWith(r.dir + "/")).sort((a, b) => b.dir.length - a.dir.length)[0]?.framework ?? null;
}

/**
 * The lines one test file's run covered, from the runner's own coverage (lcov): node:test's
 * --experimental-test-coverage, vitest's v8 provider (needs @vitest/coverage-v8), jest's
 * --coverage. -> Map<repo file, Set<line>>, or { unavailable: why }. Per file of tests, not
 * per test: a test counts as reaching lines its file's run covered.
 */
export function fileCoverage(repo, framework, testFile) {
  const abs = path.join(repo, testFile);
  let pkg = path.dirname(abs);
  while (pkg.startsWith(repo) && pkg !== repo && !fs.existsSync(path.join(pkg, "package.json"))) pkg = path.dirname(pkg);
  const installed = (mod) => {
    for (let d = pkg; ; d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, "node_modules", mod))) return true;
      if (d === repo || d === path.dirname(d)) return false;
    }
  };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "veridic-cov-"));
  const lcov = path.join(out, "lcov.info");
  const rel = path.relative(pkg, abs);
  // As in runNodeTest: a nested `node --test` must report on its own, not to a parent run.
  const { NODE_TEST_CONTEXT, ...env } = testEnv(repo);
  const opts = { cwd: pkg, encoding: "utf8", timeout: 600_000, env };
  if (framework === "node:test") spawnSync(process.execPath, ["--test", "--experimental-test-coverage", "--test-reporter=lcov", `--test-reporter-destination=${lcov}`, rel], opts);
  else if (framework === "vitest") {
    if (!installed("@vitest/coverage-v8")) return { unavailable: "@vitest/coverage-v8 not installed" };
    spawnSync("npx", ["--no-install", "vitest", "run", rel, "--coverage.enabled", "--coverage.provider=v8", "--coverage.reporter=lcov", `--coverage.reportsDirectory=${out}`, "--coverage.all=false"], opts);
  } else if (framework === "jest") spawnSync("npx", ["--no-install", "jest", rel, "--coverage", "--coverageReporters=lcov", `--coverageDirectory=${out}`], opts);
  else return { unavailable: framework ? `no coverage for ${framework}` : "no test framework found" };
  if (!fs.existsSync(lcov)) return { unavailable: `${framework} wrote no coverage report` };
  const hits = new Map();
  let file = null;
  for (const l of fs.readFileSync(lcov, "utf8").split("\n")) {
    if (l.startsWith("SF:")) file = relKey(repo, path.resolve(pkg, l.slice(3)));
    else if (file && l.startsWith("DA:")) {
      const [n, c] = l.slice(3).split(",").map(Number);
      if (c > 0) (hits.get(file) ?? hits.set(file, new Set()).get(file)).add(n);
    }
  }
  fs.rmSync(out, { recursive: true, force: true });
  return hits;
}

export function runByFramework(repo, testFiles, files) {
  const frameworkOf = frameworkOfFile(repo, files);
  const groups = new Map();
  for (const f of testFiles) {
    const fw = frameworkOf(f);
    if (!groups.has(fw)) groups.set(fw, []);
    groups.get(fw).push(f);
  }
  const results = new Map();
  const errors = [];
  for (const [fw, fs2] of groups) {
    const run = { vitest: runVitest, jest: runJest, "node:test": runNodeTest }[fw];
    if (!run) {
      errors.push({ files: fs2, error: fw ? `${fw} tests aren't run by Veridic yet` : "no test framework found for these files" });
      continue;
    }
    const r = run(repo, fs2);
    for (const [k, v] of r.results) results.set(k, v);
    errors.push(...r.errors);
  }
  return { results, errors };
}

/**
 * @param opts { specPath (to honor `veridic-spec:` bindings), run: boolean, bases }
 * @returns {{ summary, requirements: [{ id, tests: [...], status }], errors? }}
 *   status: passing | failing | covered (not run) | unasserted (named tests check nothing) | tagged_only (test doesn't reach the cited code) | ambiguous (a plain id another spec shares, on a test running both rules' code) | todo | none
 */
/** A spec's success criteria (SC-…), with their text: outcomes, not rules to test. */
export function successCriteria(spec) {
  const out = [];
  for (const l of String(spec).split("\n")) {
    const m = l.match(/^\s*[-*]\s*(?:\*\*)?(SC-?\d+[a-z]?)(?:\*\*)?\s*[:.]\s*(.*)$/);
    if (m && !out.some((c) => c.id === m[1])) out.push({ id: m[1], text: m[2].replace(/\s*\[evidence:[^\]]*\]/g, "").trim() });
  }
  return out;
}

export function testCoverage(repo, spec, opts = {}) {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 }).split("\n").filter(Boolean);
  const fileSet = new Set(files);
  const parsed = parseSpec(spec);
  const resolve = makeResolver(repo, { aliases: parsed.aliases, bases: [...(opts.bases ?? []), ...parsed.bases], files });

  const cited = new Map(); // requirement id -> Set(files)
  const cites = new Map(); // requirement id -> ["file:start-end"]
  const texts = new Map(); // requirement id -> requirement text
  const specLines = spec.split("\n");
  for (const c of parsed.citations) {
    if (!/^(FR|NFR|AC|INV)-?\d+/.test(c.fr)) continue; // success criteria (SC) are listed apart
    const f = !c.bad && resolve(c.file).file;
    if (!cited.has(c.fr)) cited.set(c.fr, new Set());
    if (!cites.has(c.fr)) cites.set(c.fr, []);
    if (!texts.has(c.fr)) texts.set(c.fr, requirementText(specLines[c.spec_line - 1]));
    if (f) {
      cited.get(c.fr).add(f);
      cites.get(c.fr).push(`${f}:${c.start}${c.end !== c.start ? `-${c.end}` : ""}`);
    }
  }
  // A file is a test only if it declares test cases (not a helper in __tests__/).
  // Verification criteria rendered under a requirement: "  - VC1. text".
  const vcsOf = new Map();
  let current = null;
  for (const line of specLines) {
    const fr = line.match(/^\s*-\s*\*\*((?:FR|SC|NFR|AC|INV)-\d+[a-z]?)\*\*/);
    if (fr) current = fr[1];
    else if (current && /^\s+-\s*VC\d+\./.test(line)) (vcsOf.get(current) ?? vcsOf.set(current, []).get(current)).push(line.match(/(VC\d+)/)[1]);
    else if (/^\S/.test(line) || /^#/.test(line)) current = null;
  }
  const testFiles = files.filter((f) => TEST_FILE.test(f) && !f.includes("node_modules/") && /\b(?:it|test)(?:\.\w+)?\s*\(/.test(safeRead(repo, f)));

  const specRel = opts.specPath ? path.relative(repo, path.resolve(opts.specPath)) : null;
  // A qualified title ("FR-001 (orders): …") counts only for that spec: the folder it is filed
  // under (specs/<folder>/spec.md), else the part asked for. A part's spec files can share ids.
  const forModule = specQual(specRel) ?? opts.module ?? null;
  const checks = (t) => t.strength === "weak" || t.strength === "strong";
  const reachCache = new Map();
  // What a test runs: what it imports, and, for a test that drives the server over HTTP, the
  // code behind each route whose URL it calls (a harness hides that from the imports).
  const routes = opts.routes ?? appRoutes(repo);
  const reaches = (testFile, targets) => {
    if (!reachCache.has(testFile)) {
      const set = reach(repo, testFile, fileSet);
      for (const h of urlHandlers(safeRead(repo, testFile), routes)) for (const f of [h, ...reach(repo, h, fileSet)]) set.add(f);
      reachCache.set(testFile, set);
    }
    return [...targets].some((t) => reachCache.get(testFile).has(t));
  };
  // Specs often reuse ids (every spec has an FR-001). A plain tag for an id another spec also
  // has, on a test that doesn't run this rule's code, is the other spec's rule: it doesn't
  // count here, not even as tagged_only (the same test --link uses to qualify a title).
  // Other specs' rules by id, with the files each cites: `- **FR-008**: … [evidence: src/a.ts:3]`.
  const otherCode = new Map();
  for (const f of files.filter((f) => /(^|\/)spec\.md$/.test(f) && f !== specRel))
    for (const line of safeRead(repo, f).split("\n")) {
      const id = line.match(/\*\*((?:FR|SC|NFR|AC|INV)-\d+[a-z]?)\*\*/)?.[1];
      if (!id) continue;
      if (!otherCode.has(id)) otherCode.set(id, []);
      otherCode.get(id).push(new Set([...line.matchAll(/\[evidence:\s*([^\]:\s]+):/g)].map((m) => m[1])));
    }
  // A plain tag on a test that runs this rule's code and another spec's rule of the same id:
  // which one it means isn't said, so it counts for neither (the title should name its spec).
  // A test usually sits next to the code it tests: a folder (less a __tests__/test folder) that
  // holds one of the rule's cited files.
  const home = (f) => path.posix.dirname(f).replace(/\/(?:__tests__|tests?)$/, "");
  const near = (testFile, code) => [...code].some((c) => path.posix.dirname(c) === home(testFile));
  // Which spec a plain id means, when other specs have it too: the one whose rule code sits next
  // to the test, if only one does; "here", "elsewhere" or null (can't tell).
  const sideOf = (t) => {
    const reached = (otherCode.get(t.id) ?? []).filter((c) => c.size && reaches(t.file, c));
    if (!reached.length) return "here";
    const mine = near(t.file, cited.get(t.id)), theirs = reached.some((c) => near(t.file, c));
    return mine && !theirs ? "here" : theirs && !mine ? "elsewhere" : null;
  };
  const ambiguousTag = (t) => !t.todo && !t.qual && !t.spec && sideOf(t) === null;
  const ambiguous = new Map();
  const tagged = findTaggedTests(repo, files).filter((t) => {
    if (!cited.has(t.id)) return false;
    if (!(t.todo || t.qual || t.spec || !otherCode.has(t.id) || reaches(t.file, cited.get(t.id)))) return false;
    if ((t.qual && forModule && t.qual !== forModule) || (t.spec && specRel && t.spec !== specRel && path.resolve(repo, t.spec) !== path.resolve(opts.specPath))) return false;
    if (!t.todo && !t.qual && !t.spec && reaches(t.file, cited.get(t.id)) && sideOf(t) === "elsewhere") return false;
    if (reaches(t.file, cited.get(t.id)) && ambiguousTag(t)) {
      if (!ambiguous.has(t.id)) ambiguous.set(t.id, []);
      ambiguous.get(t.id).push(`${t.file}:${t.line}`);
      return false;
    }
    return true;
  });

  const named = [...new Set(tagged.filter((t) => !t.todo).map((t) => t.file))];
  const run = opts.run ? (opts.runner ? opts.runner(repo, named) : runByFramework(repo, named, files)) : null;
  // With --run, the runner's coverage decides what a test reaches, where it's available.
  const covOf = new Map();
  if (run && !opts.runner && opts.coverage !== false) {
    const fw = frameworkOfFile(repo, files);
    for (const f of named) covOf.set(f, fileCoverage(repo, fw(f), f));
  }
  const unavailable = [...new Set([...covOf.values()].filter((c) => c.unavailable).map((c) => c.unavailable))];
  const reachesNow = (t, id) => {
    const cov = covOf.get(t.file);
    if (!cov || cov.unavailable) return reaches(t.file, cited.get(id));
    return (cites.get(id) ?? []).some((c) => { const m = c.match(/^(.*):(\d+)(?:-(\d+))?$/); if (!m) return false; const hit = cov.get(m[1]); if (!hit) return false; for (let n = Number(m[2]); n <= Number(m[3] ?? m[2]); n++) if (hit.has(n)) return true; return false; });
  };
  const requirements = [...cited.keys()].map((id) => {
    const tests = tagged
      .filter((t) => t.id === id)
      .map((t) => {
        const result = run?.results.get(`${t.file}\0${t.title}`);
        return { at: `${t.file}:${t.line}`, title: t.title, todo: t.todo, ...(t.needs ? { needs: t.needs } : {}), ...(t.expectFail ? { expect_fail: true } : {}), ...(t.brokenSkip ? { broken_skip: true } : {}), ...(t.strength ? { strength: t.strength } : {}), reaches_cited_code: reachesNow(t, id), ...(run ? { result: result ?? "not run" } : {}) };
      });
    const real = tests.filter((t) => !t.todo && !t.expect_fail && t.reaches_cited_code && checks(t));
    const proving = tests.filter((t) => !t.todo && t.expect_fail && t.reaches_cited_code && checks(t));
    let status = "none";
    let proven;
    // An expected-failure test that ran and failed means the code now does what the rule says:
    // the marker is stale, and the rule isn't broken any more.
    if (!real.length && proving.length && run && proving.some((t) => t.result === "failed")) status = "marker_stale";
    else if (!real.length && proving.length) (status = "broken"), (proven = true);
    else if (!real.length && tests.some((t) => t.broken_skip && t.reaches_cited_code)) (status = "broken"), (proven = false);
    else if (real.length) status = run ? (real.some((t) => t.result === "failed") ? "failing" : real.some((t) => t.result === "passed") ? "passing" : "covered") : "covered";
    else if (tests.some((t) => !t.todo && t.reaches_cited_code)) status = "unasserted";
    else if (tests.some((t) => !t.todo)) status = "tagged_only";
    else if (ambiguous.has(id)) status = "ambiguous";
    else if (tests.some((t) => t.needs)) status = "skipped";
    else if (tests.length) status = "todo";
    // Tests that reach the cited code without being named for this requirement:
    // candidates for "covered" once someone checks they assert the behavior.
    const named = new Set(tests.map((t) => t.at.split(":")[0]));
    const related_tests = testFiles.filter((f) => !named.has(f) && reaches(f, cited.get(id)));
    // Per criterion: the named, real tests for it that reach the cited code.
    const verification = (vcsOf.get(id) ?? []).map((vc) => {
      const vt = tagged.filter((t) => t.id === id && t.vc === vc && !t.todo && checks(t) && reaches(t.file, cited.get(id)));
      return { id: vc, covered: vt.length > 0, tests: vt.map((t) => ({ at: `${t.file}:${t.line}`, title: t.title, ...(run ? { result: run.results.get(`${t.file}\0${t.title}`) ?? "not run" } : {}) })) };
    });
    const needs = status === "skipped" ? [...new Set(tests.filter((t) => t.needs).map((t) => t.needs))] : null;
    return { id, status, ...(needs ? { needs } : {}), ...(proven != null ? { proven } : {}), tests, ...(ambiguous.has(id) ? { ambiguous_tests: ambiguous.get(id) } : {}), related_tests, text: texts.get(id), cites: cites.get(id), ...(verification.length ? { verification, vc_covered: verification.filter((v) => v.covered).length } : {}) };
  });

  const count = (s) => requirements.filter((r) => r.status === s).length;
  const n = requirements.length;
  const pct = (a) => (n ? Math.round((a / n) * 1000) / 10 : null);
  const covered = count("covered") + count("passing") + count("failing");
  return {
    summary: {
      requirements: n,
      with_tests: covered,
      tested_pct: pct(covered),
      ...(run ? { passing: count("passing"), failing: count("failing"), passing_pct: pct(count("passing")) } : {}),
      ...(() => {
        const vcs = requirements.flatMap((r) => r.verification ?? []);
        return vcs.length ? { criteria: vcs.length, criteria_covered: vcs.filter((v) => v.covered).length, criteria_pct: Math.round((vcs.filter((v) => v.covered).length / vcs.length) * 1000) / 10 } : {};
      })(),
      tagged_only: count("tagged_only"),
      unasserted: count("unasserted"),
      ...(() => {
        const live = tagged.filter((t) => !t.todo);
        const by = (s) => live.filter((t) => t.strength === s).map((t) => `${t.file}:${t.line}`);
        const weak = [...new Set(by("weak"))], none = [...new Set([...by("empty"), ...by("unasserted")])];
        return { tests_checked: new Set(live.map((t) => `${t.file}:${t.line}`)).size, ...(none.length ? { tests_asserting_nothing: none } : {}), ...(weak.length ? { weak_tests: weak } : {}) };
      })(),
      todo: count("todo"),
      broken: count("broken"),
      untested: count("none"),
    },
    requirements,
    ...(run ? { coverage: !covOf.size ? "static (no tests run)" : unavailable.length ? `static (${unavailable.join("; ")})` : "runtime" } : {}),
    criteria: successCriteria(spec),
    // Bare ids another spec also declares: counted for neither until the title names its spec.
    ambiguous: [...ambiguous].flatMap(([id, ats]) => ats.map((at) => ({ id, at }))),
    // The code these results describe: cited files plus the tests named for them.
    basis: basisOf(repo, [...[...cited.values()].flatMap((s) => [...s]), ...tagged.map((t) => t.file)]),
    ...(run?.errors.length ? { errors: run.errors } : {}),
  };
}

const requirementText = (line = "") =>
  line
    .replace(/\[evidence:[^\]]*\]/g, "")
    .replace(/^\s*[-*]\s*/, "")
    .replace(/\*\*((?:FR|SC|NFR|AC)-?\d+[a-z]?)\*\*:?\s*/, "")
    .replace(/\s+[—–-]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The traceability table, generated: one row per requirement with its citations,
 * linked tests and a status. "related" means a test reaches the cited code
 * without being named for the requirement; read it, and call it covered only
 * if it asserts the behavior.
 */
/** The "## Reviewed by hand" section of an existing traceability.md, verbatim, or "". */
export function reviewedSection(text) {
  const i = String(text ?? "").search(/^## Reviewed by hand\b/m);
  return i < 0 ? "" : String(text).slice(i).trimEnd() + "\n";
}

/**
 * The traceability table, from what is linked. Rows someone checked by hand go in a
 * "## Reviewed by hand" section (`reviewed`, kept as written) and aren't counted as covered.
 */
export function traceabilityTable(cov, { reviewed = "" } = {}) {
  const cell = (s) => String(s).replace(/\|/g, "\\|");
  const short = (t, n = 90) => (t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : t);
  const statusOf = (r) =>
    r.status === "passing" ? "covered (passing)" : r.status === "failing" ? "covered (FAILING)" : r.status === "covered" ? "covered" : r.related_tests.length ? "related" : r.status === "unasserted" ? "untested (test asserts nothing)" : r.status === "todo" ? "untested (placeholder)" : "untested";
  const rows = cov.requirements.map((r) => {
    const named = r.tests.filter((t) => !t.todo).map((t) => `\`${t.at}\`${t.strength === "weak" ? " (weak)" : t.strength === "empty" || t.strength === "unasserted" ? " (asserts nothing)" : ""}`);
    const related = r.related_tests.slice(0, 3).map((f) => `\`${f}\` (related)`);
    const tests = [...named, ...related].join("<br>") + (r.related_tests.length > 3 ? `<br>+${r.related_tests.length - 3} more` : "") || "—";
    return `| ${r.id} | ${cell(short(r.text ?? ""))} | ${(r.cites ?? []).map((c) => `\`${c}\``).join("<br>") || "—"} | ${tests} | ${statusOf(r)} |`;
  });
  const count = (s) => cov.requirements.filter((r) => statusOf(r).startsWith(s)).length;
  return [
    "| FR | Requirement | Implementation | Tests | Status |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    `**Totals:** ${cov.requirements.length} requirements: ${count("covered")} covered, ${count("related")} related, ${count("untested")} untested.`,
    "",
    ...(cov.basis ? [`_Results as of code basis \`${cov.basis.digest}\` (${cov.basis.files} files). \`veridic metrics\` reports them outdated once that code changes._`, "", basisComment(cov.basis), ""] : []),
    "_Generated by `veridic tests --table`. Covered = a test named with the requirement id reaches the cited code and asserts something (weak = only loose checks such as toBeTruthy). Related = a test reaches the cited code without naming the requirement; it counts as covered only if it asserts the behavior. Rows checked by hand belong under \"## Reviewed by hand\" below; they're kept as written and not counted._",
    "",
    ...(reviewed ? [reviewed] : []),
  ].join("\n");
}

const safeRead = (repo, f) => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return "";
  }
};

/**
 * Rules no test is named for, whose cited code an existing test already runs: tests that may
 * prove them once someone checks and links them (`veridic tests --module <id> --link`). Cheap
 * enough for `init`: each test file's imports are followed once.
 * @param data  the report's data (`specs[].requirements[]` with status and cites)
 * @param files the repo's files (relative paths)
 * @returns { rules, bySpec: { [specPath]: n } }
 */
export function linkable(repo, data, files) {
  const fileSet = new Set(files);
  const run = new Set();
  for (const f of files) if (TEST_FILE.test(f) && !f.includes("node_modules/")) for (const g of reach(repo, f, fileSet)) run.add(g);
  const bySpec = {};
  let rules = 0;
  for (const s of data.specs ?? []) {
    const n = (s.requirements ?? []).filter((r) => r.requirement !== false && r.status === "none" && (r.cites ?? []).some((c) => run.has(c.file))).length;
    if (n) bySpec[s.path] = n, rules += n;
  }
  return { rules, bySpec };
}

/** linkable()'s per-spec counts, by part (`homes`: spec path -> part id): [[id, n]], most first. Specs in no part are left out. */
export function linkableParts(bySpec, homes) {
  const n = new Map();
  for (const [spec, k] of Object.entries(bySpec)) { const id = homes.get(spec); if (id) n.set(id, (n.get(id) ?? 0) + k); }
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
