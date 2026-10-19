# Rules to tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a module's written rules into tests Veridic counts: a work list and test recipe from Veridic, a test-writer agent that links and writes tests, and verification that recognises expected-failure tests and runs them.

**Architecture:** Two new core files (`core/recipe.mjs`: how a package tests; `core/worklist.mjs`: per-rule status and what to do) on top of `core/tests.mjs` (parsing, coverage, runners). The CLI `veridic tests --module` renders the work list; a plugin command and agent do the writing; `veridic-bench/tests-e2e.mjs` measures it against a baseline.

**Tech Stack:** Node ≥ 22.5 ESM, node:test for Veridic's own tests, no new dependencies.

**Spec:** `docs/specs/2026-10-18-rules-to-tests-design.md`

## Global Constraints

- Only test files change in a target repo; the workflow never edits app code.
- Statuses exactly: `tested`, `broken`, `failing`, `weak`, `untested` (work list); `covered` stands in for `tested` without `--run`.
- Expected-failure markers: `it.fails`, `test.fails` (vitest), `test.failing` (jest). Mocha and node:test: skipped test with `[broken]` in the title counts as `broken, not proven`.
- Module-qualified titles accepted: `FR-001 (orders): …`.
- No new npm dependencies.
- Dogfooding: this work is itself specified in `specs/rules-to-tests/spec.md` (Task 0). Every new test's title starts with the rule id it proves. Each task starts with `veridic claim <files>` and ends with `veridic done` reporting DONE.

## Review Focus

- A test file with both `it.fails` and normal tests for the same rule: the rule is `tested` if any normal named test passes; `broken` only when every named test is expected-failure. (Task 1 test.)
- A package whose test script uses a framework not installed (`npx --no-install` fails): reported `could not run`, not as failing rules. (Task 4 test.)
- A module whose rules all live in a spec owned by another module: the work list says the module has no spec of its own and names the owner. (Task 3 test.)
- Two specs with the same id (`FR-001`) and a test reaching both cited files: entry marked ambiguous, title must carry the module. (Task 3 test.)
- A rule with no resolvable citations: listed as `untested` with reason `no cited code`, not dropped. (Task 3 test.)

---

### Task 0: The spec for this work, in Veridic's own repo

**Files:**
- Create: `specs/rules-to-tests/spec.md`

- [ ] **Step 0:** `veridic init` in this repo (builds `.codegraph/`, which ignores itself in git), so `claim`/`done`/`cite` can run here.
- [ ] **Step 1:** Write the spec with one requirement per behaviour below, each `- **FR-0NN**: … [evidence: file:line]`. Evidence points at the lines the requirement will live in once built; until then cite the existing neighbour (e.g. `core/tests.mjs:21` for title parsing). FR-001 expected-failure parsing; FR-002 broken status; FR-003 module qualifier; FR-004 recipe framework + run command; FR-005 recipe layout; FR-006 recipe helpers/setup; FR-007 recipe style + example; FR-008 work-list statuses + order; FR-009 link candidates; FR-010 ambiguity; FR-011 node:test and jest runners; FR-012 could-not-run reporting; FR-013 CLI `--module` Markdown with next steps; FR-014 no-spec / unknown module errors; FR-015 report shows broken rules.
- [ ] **Step 2:** `veridic cite --spec specs/rules-to-tests/spec.md` → exits 0. Commit.

### Task 1: Expected-failure and qualified titles in test parsing

**Files:** Modify `core/tests.mjs` (TITLE at :21, `findTaggedTests` :202, `testCoverage` :377); Test `test/generalize.test.mjs`.

**Interfaces:** Produces: tagged test objects gain `expectFail: boolean`, `qual: string|null`; `testCoverage` statuses gain `broken`; `testCoverage(repo, spec, { module })` drops tagged tests whose `qual` names another module.

- [ ] **Step 1: failing tests** `FR-001: it.fails / test.failing are found and marked expectFail`; `FR-002: a rule whose only named tests are expected-failure is broken; one passing normal test makes it covered`; `FR-003: "FR-001 (menu): …" is ignored for module orders`. Fixture: a two-file temp repo with a spec citing `src/a.js:1` and a test file importing it.
- [ ] **Step 2:** Run `node --test test/generalize.test.mjs` → the three fail.
- [ ] **Step 3:** TITLE modifier group adds `fails|failing`; capture `(\w+)` after the id as qualifier when written `FR-001 (x):`; status order: real normal tests → existing logic; else all live named tests expectFail → `broken`; mocha/node:test skip with `[broken]` in title → `broken` with `proven: false`.
- [ ] **Step 4:** Tests pass; full suite `npm test` passes.
- [ ] **Step 5:** `veridic done` DONE; commit.

### Task 2: The test recipe

**Files:** Create `core/recipe.mjs`; Test `test/generalize.test.mjs`.

**Interfaces:** Produces `testRecipe(repo: string, files: string[]) => Map<packageDir, Recipe>` and `exampleTest(repo, recipe, citedFile) => string|null`, where `Recipe = { dir, framework: "vitest"|"jest"|"mocha"|"node:test"|null, run: string|null, layout: "colocated"|"__tests__"|"test-dir", setup: string[], helpers: {file, note}[], style: "http"|"direct", marker: "it.fails"|"test.failing"|null }`.

- [ ] **Step 1: failing tests** `FR-004` (vitest package → `npx vitest run <file>`; jest → `npx jest <file>`; no framework → `framework: null`), `FR-005` (layout by majority), `FR-006` (`testkit/x.ts` imported by two tests is a helper with its header comment; `setupFiles` from vitest config), `FR-007` (supertest import → `http`; example = test importing the cited file).
- [ ] **Step 2:** Run → fail. **Step 3:** Implement from package.json deps/devDeps and config file names; helpers by import counting over the package's test files; header note = leading comment block, ≤ 400 chars. **Step 4:** Pass. **Step 5:** `veridic done`; commit.

### Task 3: The work list

**Files:** Create `core/worklist.mjs`; Test `test/generalize.test.mjs`.

**Interfaces:** Consumes `testCoverage` (Task 1), `testRecipe`/`exampleTest` (Task 2), `loadModules`/`findModule` (`core/modulectx.mjs`). Produces `workList(repo, moduleId, { run?: boolean }) => Promise<{ module, specs: string[], rules: Rule[], totals, recipe, next: string[], error? }>` and `workListMarkdown(wl) => string`; `Rule = { id, spec, status, text, checks: string[], cites: string[], candidates: {at, title, strength}[], target: string, risk: 0|1|2, ambiguous: boolean, reason?: string }`.

- [ ] **Step 1: failing tests** `FR-008` (statuses map from coverage; money/destructive routes first, then INV, then rest), `FR-009` (candidates = strong/weak tests in files reaching the cited code, not already named), `FR-010` (same id in two specs + reach → `ambiguous`), `FR-014` (unknown id → error listing ids; module without own spec → error naming the owning module or `/veridic:specs <id>`), plus Review Focus: rule with no citations → `untested`, reason `no cited code`.
- [ ] **Step 2:** Run → fail. **Step 3:** Implement; candidates via `auditFile`-style per-test listing (add `testsIn(repo, file) => {line, title, strength}[]` to `core/tests.mjs`). **Step 4:** Pass. **Step 5:** `veridic done`; commit.

### Task 4: Runners and the CLI

**Files:** Modify `core/tests.mjs` (add `runJest`, `runNodeTest`; `testCoverage` picks the runner by the recipe), `skill/scripts/tests.mjs` (flags `--module`, `--md` default for module mode, `--json`, `--mutate N`), `skill/scripts/modules.mjs` (next-step line); Test `test/generalize.test.mjs`.

**Interfaces:** Produces `runJest(repo, files) / runNodeTest(repo, files)` with the same return shape as `runVitest`: `{ results: Map<"file\0title", "passed"|"failed"|...>, errors: {package|file, error}[] }`.

- [ ] **Step 1: failing tests** `FR-011` (node:test run of a fixture with one passing and one failing named test → `tested`/`failing`), `FR-012` (missing framework binary → `errors` entry and status `covered`, never `failing`), `FR-013` (`tests --module` Markdown contains the totals line and ends with a line starting `Next:`).
- [ ] **Step 2:** Run → fail. **Step 3:** node:test via `node --test --test-reporter=tap <files>` parsed for `ok`/`not ok` + names; jest via `--json --outputFile`; `--mutate N` calls the existing `mutationScore(repo, spec, { validate: N })` (core/mutate.mjs:73) and reports its catch rate. **Step 4:** Pass. **Step 5:** `veridic done`; commit.

### Task 5: Command, agent, and the report

**Files:** Create `commands/tests.md`, `agents/veridic-test-writer.md`; Modify `core/report-page.js` (REQ map: `broken` → "broken, proven"), `skill/SKILL.md` (one paragraph: rules to tests); Test: `veridic tests --spec specs/rules-to-tests/spec.md --run` on Veridic itself.

- [ ] **Step 1:** Write the command (plan → ask → agent per module, foreground, ≤4 → totals) and agent (steps and tools exactly as spec Section 3; frontmatter `name`, `description`, `tools`).
- [ ] **Step 2:** `FR-015`: report test asserting a `broken` rule renders "broken". Run → fail → implement → pass.
- [ ] **Step 3: Dogfood check:** `veridic tests --spec specs/rules-to-tests/spec.md --run` on this repo → every FR `tested`. Record the output in the commit message.
- [ ] **Step 4:** `veridic done`; commit.

### Task 6: Measurement

**Files:** Create `veridic-bench/tests-e2e.mjs`, outputs `tests-e2e.json`, `TESTS-E2E.md`.

- [ ] **Step 1:** Copy `specs-e2e.mjs` structure. Per app (realworld, node-express-boilerplate, hackathon-starter), two fresh copies: run `/veridic:specs <two riskiest>` in each, then arm B `/veridic:tests <ids>` and arm A plain prompt (spec text "write tests for every rule in specs/<id>/spec.md; name each test with its rule id"). Budget flag per arm (default $4).
- [ ] **Step 2:** Score per module: counted rules (tested + broken) / rules via `veridic tests --module --run --json`; tests passing; mutation catch rate (`--mutate 5`); non-test files changed (`git diff --name-only` minus test files; must be 0); cost, minutes, turns.
- [ ] **Step 3:** Run on one app first (realworld, $8 cap), report, then the rest. Commit results. Verdict line: B passes if counted rules and catch rate beat A at ≤ A's cost, with 0 non-test edits.

## Dogfood report (filled in at the end)

Built with Veridic on Veridic: a spec for this work (16 rules), tests named by rule, a claim before each task and `veridic done` after.

**Helped**
- `veridic init` on itself found a real bug at once: routes declared in test files counted as app routes (12 fake routes, 9 fake modules). Fixed first.
- `veridic tests --spec … --run` on its own spec caught two bugs the unit tests didn't: a nested `node --test` printed no results, and a fixture string made the recipe think Veridic's tests were vitest (own spec 0/16 → 15/16 passing after the fix).
- It honestly flags the weakest test (FR-015 reads the report page as text): tagged_only, not tested.
- The end-to-end run found two more: results lost when the repo path is a symlink, and "covered" counted as tested under --run.

**Got in the way / gaps**
- On a repo with no routes (a CLI or library), `done`'s test check passes vacuously; only the claim guards the change.
- `done` missed an unclaimed edit to `bin/veridic`: files outside the code index (no extension) go unchecked.
- `claims` matches facts literally: behaviour written as a regex (`fails|failing`, `__tests__\/`) reads as unsupported (support 0.33–0.5 on this spec).
- `stale --fix` repaired 2 of 5 shifted citations after heavy edits; the rest were set by hand.
- Modules come from Express routes, so the module view and `tests --module` don't apply to Veridic itself.

**Result** (veridic-bench TESTS-E2E.md, realworld, 40 rules): `/veridic:tests` 39/40 rules counted (2 broken, proven: real bugs), 6/8 sampled rules' tests caught a code change; a plain prompt 14/40, 3/6. Zero non-test edits in both. But 3.8× the cost ($2.67 vs $0.70) and 2.5× the time.
