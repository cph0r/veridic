// How a repo tests, per package, so an agent writes tests that look like the repo's own:
// the framework and the command to run one file, where tests live, setup files and
// shared helpers (with their usage notes), whether tests go over HTTP or call code
// directly, the expected-failure marker, and the closest existing test to copy.
// Read from the repo; nothing is assumed. A package whose framework can't be told
// gets framework null, and the agent stops there rather than guessing.

import fs from "node:fs";
import path from "node:path";

const TEST_FILE = /(^|\/)(__tests__|tests?)\/.*\.[cm]?[jt]sx?$|\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE = /\.[cm]?[jt]sx?$/;
const HELPER_DIR = /(^|\/)(testkit|test-utils|__mocks__|fixtures?)\//;
const RUN = { vitest: "npx vitest run <file>", jest: "npx jest <file>", mocha: "npx mocha <file>", "node:test": "node --test <file>" };
const MARKER = { vitest: "it.fails", jest: "test.failing" };

const read = (repo, f) => {
  try {
    return fs.readFileSync(path.join(repo, f), "utf8");
  } catch {
    return "";
  }
};
const inDir = (dir, f) => dir === "." || f.startsWith(dir + "/");

/** A file's relative imports and requires, resolved to repo paths that exist. */
function importsOf(repo, file, exists) {
  const src = read(repo, file);
  const out = [];
  for (const m of src.matchAll(/(?:from\s+|require\(\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])).replace(/\.[cm]?js$/, "");
    const hit = [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"].map((e) => base + e), base + "/index.ts", base + "/index.js"].find((c) => exists.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

function frameworkOf(pkg, testSrcs, ancestors = []) {
  // The package's own dependencies, then those of the packages above it (a workspace root
  // often installs the test framework), then what the tests themselves import.
  for (const p of [pkg, ...ancestors]) {
    const deps = { ...(p.dependencies ?? {}), ...(p.devDependencies ?? {}) };
    for (const f of ["vitest", "jest", "mocha"]) if (deps[f]) return f;
  }
  // The package's own test script says node:test; then real import lines (at a line's start,
  // so a fixture string mentioning a framework doesn't count).
  if (/\bnode\s+--test\b/.test(pkg.scripts?.test ?? "")) return "node:test";
  const imports = (re) => testSrcs.some((s) => re.test(s));
  if (imports(/^\s*import\b[^\n]*\bfrom\s+["']vitest["']/m)) return "vitest";
  if (imports(/^\s*import\b[^\n]*\bfrom\s+["']@jest\/globals["']/m)) return "jest";
  if (imports(/^\s*import\b[^\n]*\bfrom\s+["']node:test["']|^\s*(?:const|let|var)\b[^\n]*require\(\s*["']node:test["']\s*\)/m)) return "node:test";
  return null;
}

function setupFiles(repo, dir, files, pkg) {
  const out = [];
  const cfg = files.find((f) => path.posix.dirname(f) === dir && /^(vitest|vite|jest)\.config\.[cm]?[jt]s$/.test(path.posix.basename(f)));
  const list = (text) => [...(text.match(/setupFiles(?:AfterEach|AfterEnv)?\s*:\s*\[([^\]]*)\]/)?.[1] ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  const names = [...(cfg ? list(read(repo, cfg)) : []), ...(pkg.jest?.setupFiles ?? []), ...(pkg.jest?.setupFilesAfterEach ?? [])];
  for (const n of names) {
    const rel = path.posix.normalize(path.posix.join(dir, n.replace(/^<rootDir>\//, "")));
    if (files.includes(rel)) out.push(rel);
  }
  return out;
}

/** The leading comment of a file, as plain text (at most 400 characters). */
function leadingNote(src) {
  const m = src.match(/^\s*(\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n)+)/);
  if (!m) return "";
  return m[1].replace(/^\/\*+|\*+\/$/g, "").replace(/^\s*(\*|\/\/)\s?/gm, "").trim().slice(0, 400);
}

/**
 * @returns Map<packageDir, { dir, framework, run, layout, setup, helpers: {file, note}[], style, marker, tests }>
 */
export function testRecipe(repo, files) {
  const exists = new Set(files);
  const pkgDirs = files.filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules/")).map((f) => path.posix.dirname(f));
  // Each file belongs to its nearest package.
  const owner = (f) => pkgDirs.filter((d) => inDir(d, f)).sort((a, b) => b.length - a.length)[0];
  const out = new Map();
  for (const dir of pkgDirs) {
    let pkg = {};
    try {
      pkg = JSON.parse(read(repo, dir === "." ? "package.json" : `${dir}/package.json`));
    } catch {}
    const mine = files.filter((f) => owner(f) === dir && !f.includes("node_modules/"));
    const tests = mine.filter((f) => TEST_FILE.test(f) && !HELPER_DIR.test(f) && /\b(?:it|test)(?:\.\w+)?\s*\(/.test(read(repo, f)));
    const srcs = tests.map((f) => read(repo, f));
    const ancestors = pkgDirs.filter((d) => d !== dir && (d === "." || inDir(d, dir))).sort((a, b) => b.length - a.length).map((d) => {
      try {
        return JSON.parse(read(repo, d === "." ? "package.json" : `${d}/package.json`));
      } catch {
        return {};
      }
    });
    const framework = frameworkOf(pkg, srcs, ancestors);
    const rel = (f) => (dir === "." ? f : f.slice(dir.length + 1));
    const where = { colocated: 0, __tests__: 0, "test-dir": 0 };
    for (const t of tests) where[/(^|\/)__tests__\//.test(t) ? "__tests__" : /^tests?\//.test(rel(t)) ? "test-dir" : "colocated"]++;
    const layout = tests.length ? Object.entries(where).sort((a, b) => b[1] - a[1])[0][0] : "colocated";
    const counts = new Map();
    for (const t of tests) for (const imp of importsOf(repo, t, exists)) if (HELPER_DIR.test(imp) && !TEST_FILE.test(imp) && SOURCE.test(imp)) counts.set(imp, (counts.get(imp) ?? 0) + 1);
    const helpers = [...counts].filter(([, n]) => n >= 2).map(([file]) => ({ file, note: leadingNote(read(repo, file)) }));
    out.set(dir, {
      dir,
      framework,
      run: framework ? RUN[framework] : null,
      layout,
      setup: setupFiles(repo, dir, mine, pkg),
      helpers,
      style: srcs.some((s) => /["']supertest["']|\brequest\(\s*app\s*\)/.test(s)) ? "http" : "direct",
      marker: framework ? MARKER[framework] ?? null : null,
      tests,
    });
  }
  return out;
}

/** The closest existing test to copy for a cited file: one that imports it, else one in its folder. */
export function exampleTest(repo, recipe, citedFile) {
  const exists = new Set([...recipe.tests, citedFile]);
  return recipe.tests.find((t) => importsOf(repo, t, exists).includes(citedFile)) ?? recipe.tests.find((t) => path.posix.dirname(t) === path.posix.dirname(citedFile)) ?? null;
}
