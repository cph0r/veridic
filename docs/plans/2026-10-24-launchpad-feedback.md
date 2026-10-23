# Veridic 0.12 (Launchpad feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Veridic's numbers trustworthy on a real, actively edited app: citations checked by
their text, every story and rule read, a product spec above the parts, tests that run the code
counted, statuses through thrown errors, parts named by folder.

**Architecture:** Mostly changes inside existing modules (`core/report.mjs`, `core/citations.mjs`,
`core/staleness.mjs`, `core/tests.mjs`, `core/link.mjs`, `core/contract.mjs`, `core/modules.mjs`),
plus one new module, `core/product.mjs`, for the product spec. Every new format is read alongside
the old one.

**Tech Stack:** Node ≥22.5 ESM, `node:test`, no new dependencies.

**Spec:** `docs/specs/2026-10-24-launchpad-feedback-design.md`

## Global Constraints

- Branch `v0.12` off `adapters` (or `main` once `adapters` is merged).
- Express output byte-identical (`test/adapter-snapshot.mjs`, `test/metrics-baseline.mjs` on RealWorld, Gobbles, a frozen launchpad copy) except the changes an item names; each named change is listed in that task's Expected line.
- Launchpad is read only, through a fresh frozen `rsync -a --no-specials --exclude node_modules` copy in the scratchpad; never write to the live repo.
- Private apps (launchpad, Gobbles) never appear in committed tests, fixtures, docs or the benchmark; tests use synthetic repos (`test/fake.mjs` or temp git repos).
- Old specs keep working: nothing rewrites a spec without `--fix`, `--stamp` or `render`.
- Hash: first 6 hex of SHA-256 over the cited lines, each line trimmed of leading and trailing whitespace, joined with `\n`. Written as `path:10-20~3f9a1c` or `path:10-20#name@10~3f9a1c`.
- Product spec path: `specs/product/spec.md`. Journey ids `J-001`, guarantee ids `G-001`. A reference to a part rule: `apps:FR-003` (spec folder, colon, id).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Pushing, merging, publishing need the user.

## Review Focus

1. A citation whose cited lines appear twice in the file (two identical blocks): "moved" must pick the copy nearest the old line, never silently the first. Test in Task 4.
2. A spec with citations both with and without a hash: each kind checked its own way in one run. Test in Task 5.
3. A product spec referencing a part rule that doesn't exist, or a spec folder that isn't there: `check` names it; the report doesn't crash. Test in Task 6.
4. A repo where the runner's coverage tool isn't installed (`@vitest/coverage-v8` missing): `--run` falls back to static reach and says so, never "weak" for all. Test in Task 10.
5. Two parts whose folders share a name (`api/auth`, `admin/auth`): ids `api-auth` and `admin-auth`, never `auth-2`. Test in Task 12.

---

## Phase 1: quick fixes and citations by text

### Task 1: Stories in the forms the agents write

**Files:** Modify `core/report.mjs` (`specDoc`), `bin/veridic` (the `check` command); Test `test/specs.test.mjs` (create)

**Interfaces:**
- Produces: `parseStoryHeading(h3: string) -> { n, title, priority } | null`; `storyHeadingProblems(text: string) -> [{ line, heading }]` (both exported from `core/report.mjs`).

- [ ] **Step 1: Failing test** `"stories: the heading forms spec agents write"`: each of `User Story 2 - Pay (Priority: P1)`, `Story 2: Pay (P1)`, `Story 2 - Pay`, `US-2: Pay [P2]`, `User Story 2: Pay (Priority: P3)` parses to `n: 2, title: "Pay"` with the priority given (null when none). `Storyboard notes` and `Stories` return null. `storyHeadingProblems("### Story two: Pay\n### Story 3: Ok (P1)")` → `[{ line: 1, heading: "Story two: Pay" }]`.
- [ ] **Step 2:** Run `node --test test/specs.test.mjs`. Expected: FAIL, `parseStoryHeading` not exported.
- [ ] **Step 3:** Implement both; `specDoc` uses `parseStoryHeading`. `veridic check` prints each problem as a warning (`spec.md:12 "Story two: Pay" looks like a story but isn't read`) without changing its exit code.
- [ ] **Step 4:** `npm test` passes; Express snapshots and metrics identical.
- [ ] **Step 5:** Commit `"specs: read the story headings agents write; check warns on the rest"`.

### Task 2: Success criteria counted apart

**Files:** Modify `core/report.mjs` (rule rows), `core/tests.mjs` (`testCoverage`), `core/report-page.js` (spec page); Test `test/specs.test.mjs`, `test/tests.test.mjs`

**Interfaces:**
- Produces: in `testCoverage(...)`'s result, `requirements` holds no `SC-…` ids and `criteria: [{ id, text }]` lists them; in the report data each spec has `criteria: [{ id, text }]`.

- [ ] **Step 1: Failing tests**: a spec with `FR-001`, `FR-002`, `SC-001`, `SC-002` → `testCoverage(...).requirements.map(r => r.id)` is `["FR-001", "FR-002"]`, `criteria.length === 2`; the report's untested count for that spec is 2, not 4.
- [ ] **Step 2:** Run them. Expected: FAIL (SC counted).
- [ ] **Step 3:** Implement. The spec page lists them under "Success criteria (N)", plain text, no state.
- [ ] **Step 4:** `npm test` passes. Expected snapshot changes: none (Express snapshots carry no spec data); Gobbles' metrics may change only in rule counts of specs that have SC rows; list them in the commit message.
- [ ] **Step 5:** Commit `"specs: success criteria are criteria, not untested rules"`.

### Task 3: Ids shared across specs, and init --card

**Files:** Modify `core/link.mjs` (`linkTests`), `core/tests.mjs` (bare id resolution), `skill/scripts/init.mjs`; Test `test/generalize.test.mjs` (where `linkTests` is tested), `test/tests.test.mjs`

- [ ] **Step 1: Failing tests**:
  - `"link: an id two specs use is always written qualified"`: two specs both with `INV-3`; `linkTests(repo, [["INV-3", "t.test.ts:4"]], { module: "apps", qualify: new Set(["INV-3"]) })` writes `INV-3 (apps): …` to the title.
  - `"link: a bare title for a shared id is re-titled, not refused"`: title `"INV-3: rejects"` becomes `"INV-3 (apps): rejects"`; result has no `already named` skip.
  - `"tests: a bare shared id counts for no spec and is listed as ambiguous"`: `testCoverage` for either spec doesn't count it; `ambiguous: [{ id: "INV-3", at: "t.test.ts:4", specs: ["apps", "auth"] }]`.
  - `"init: --card is accepted"`: `node skill/scripts/init.mjs --repo <fake> --card` doesn't exit with "unknown option".
- [ ] **Step 2:** Run. Expected: FAIL on each.
- [ ] **Step 3:** Implement. `--card` in init is a boolean that does nothing (init always prints its card).
- [ ] **Step 4:** `npm test`; snapshots and metrics identical.
- [ ] **Step 5:** Commit `"link: shared ids always qualified, bare ones repaired; init --card"`.

### Task 4: A citation's text, hashed

**Files:** Modify `core/citations.mjs` (`parseSpec`, cite format), `core/staleness.mjs` (`formatCite`); Create nothing; Test `test/citations.test.mjs`

**Interfaces:**
- Produces: `citeHash(lines: string[]) -> string` (6 hex); `parseSpec` citations carry `hash` when written; `textCheck(repo, citation, resolve) -> { state: "fresh" | "moved" | "stale" | "unhashed", start?, end? }` exported from `core/citations.mjs`, reading the working tree; `formatCite(file, start, end, anchor, hash)` keeps the hash.

- [ ] **Step 1: Failing tests** `"citations: checked by their text"` on a temp repo (no commit needed):
  - `src/a.ts:2-3~<hash of lines 2-3>` → `fresh`;
  - two lines inserted above → `moved` with `start: 4, end: 5`;
  - line 3 edited → `stale`;
  - the same two lines also at 20-21 and the citation was 2-3, block moved to 8-9 → `moved` to 8-9, the copy nearest the old place (Review Focus 1);
  - no hash → `unhashed`;
  - `parseSpec` reads `path:2-3#fn@2~abc123` as `{ start: 2, end: 3, anchor: { name: "fn", line: 2 }, hash: "abc123" }`.
- [ ] **Step 2:** Run. Expected: FAIL, `citeHash` not exported.
- [ ] **Step 3:** Implement. "Moved" searches the cited file (or the file git reports it renamed to, `git diff -M --name-status HEAD`) for a window of the same length with the same hash; nearest to the old start wins.
- [ ] **Step 4:** `npm test`; snapshots identical.
- [ ] **Step 5:** Commit `"citations: a hash of the cited text, and a check against it"`.

### Task 5: Stale, fix and the dashboard use the text

**Files:** Modify `core/staleness.mjs` (`staleness`, `defaultRange`), `skill/scripts/stale.mjs` (`--stamp`), `skill/scripts/render.mjs`, `core/report.mjs` (out of date), `commands/spec.md`, `commands/specs.md`, `skill/references/spec-json.md`; Test `test/citations.test.mjs`

**Interfaces:**
- Consumes: `citeHash`, `textCheck` (Task 4).
- Produces: `stampSpec(repo, specText) -> { spec, stamped: n, skipped: [{ cite, why }] }` in `core/staleness.mjs`.

- [ ] **Step 1: Failing tests**:
  - `"stale: a hashed citation is fresh while its text is unchanged, whatever git says"`: the cited file edited elsewhere, uncommitted → not stale.
  - `"stale --fix: never moves a correct citation in an untracked spec"`: spec untracked, written against the working tree, file has uncommitted lines added above the cited code, citations already right → `fixes` empty (the 0.10 bug: they were shifted).
  - `"stale: hashed and unhashed citations in one spec"`: each judged its own way (Review Focus 2).
  - `"stale --stamp: adds hashes to resolving citations, skips the rest"`.
  - `"render: spec.json evidence gets hashes from the working tree"`.
  - `"report: out of date only when the cited text changed"`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Hashed citations: `textCheck` decides, `--fix` applies only `moved`. Unhashed: as today, but when the spec file is untracked or modified, the default range compares with the working tree, never `HEAD`. The report's out-of-date uses the same `staleness` call with that default. Skill docs: spec agents write evidence as rendered (render stamps); `veridic stale --stamp` named in `commands/stale.md` for old specs.
- [ ] **Step 4:** `npm test`; Express snapshots identical; metrics: list any out-of-date count that changes on Gobbles and why.
- [ ] **Step 5:** Commit `"stale: compare the cited text, not a commit"`.
- [ ] **Step 6: Phase 1 checkpoint.** On a fresh frozen launchpad copy: `veridic check` (story warnings), `veridic report --json` (stories per spec, criteria, out-of-date count before/after `stale --stamp`), and an uncommitted edit to a cited file's unrelated line → no rule out of date. Record in Results; show the user; stop until they say go.

## Phase 2: the product spec

### Task 6: Product spec: format, check and state

**Files:** Create `core/product.mjs`; Modify `bin/veridic` (`check`), `core/report.mjs` (`collectReport`), `core/parts.mjs` (`specHomes` skips `specs/product`); Test `test/product.test.mjs` (create)

**Interfaces:**
- Produces: `parseProduct(text) -> { title, summary, journeys: [{ id, title, steps: [{ text, refs: ["apps:FR-003"] }] }], guarantees: [{ id, text, refs }] }`; `productProblems(product, specsByFolder) -> [{ id, ref, why }]`; `productState(product, ruleState: (ref) => "proven"|"broken"|"stale"|"untested"|null) -> same shape with `state` on each journey, step and guarantee`.
- Format: `### J-001: Ask for an app` then numbered steps ending `(apps:FR-003, auth:FR-001)`; `- **G-001**: text [rules: apps:FR-003, apps-host:FR-002]`.

- [ ] **Step 1: Failing tests**: parse a sample with 2 journeys and 2 guarantees; a guarantee is `proven` when every ref is, `stale` when any is, `broken` when any is, else `untested`; a ref to a missing rule or folder is a problem and its state is `null` (Review Focus 3); `specHomes` doesn't treat `specs/product` as a part; `check` exits non-zero on a problem and names it.
- [ ] **Step 2:** Run. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. `collectReport` adds `product` (or null) using the same rule states the parts table uses.
- [ ] **Step 4:** `npm test`; snapshots and metrics identical (no product spec in those repos).
- [ ] **Step 5:** Commit `"product: a spec for the whole app, checked against the parts' rules"`.

### Task 7: Writing it, and showing it

**Files:** Modify `commands/specs.md`, `commands/spec.md`, `skill/SKILL.md`, `core/report-page.js`, `core/report-blueprint.css`; Test `test/report-page.test.mjs`

- [ ] **Step 1: Failing test** `"report: the product spec renders above the parts table"`: rendered HTML contains the journeys and guarantees section before the parts table, each item with its state class; no section when `product` is null.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Dashboard: README summary, then journeys (steps with their part rule links) and guarantees, each with the same state marks the parts use; read-only, no buttons. `/veridic:specs` writes `specs/product/spec.md` first (from the README, routes and parts), then the parts, then re-checks the product spec's refs; `/veridic:spec product` writes or refreshes it alone.
- [ ] **Step 4:** `npm test`; snapshots identical.
- [ ] **Step 5:** Commit `"product: written first by /veridic:specs, shown above the parts"`.
- [ ] **Step 6: Phase 2 checkpoint.** On the frozen launchpad copy, write its product spec with `/veridic:spec product` (in the copy) and render the dashboard; screenshot for the user. Stop until they say go.

## Phase 3: tests that run the code count

### Task 8: Static reach through aliases, workspace packages and child processes

**Files:** Modify `core/tests.mjs` (`relImports`, `reach`), `core/resolve.mjs` (workspace packages); Test `test/tests.test.mjs`

**Interfaces:**
- Consumes: `importResolver(repo)` from `core/resolve.mjs`.
- Produces: `importResolver` also resolves a workspace package by its `package.json` `name` (`@workspace/db` → that package's `main`/`exports["."]`/`src/index.ts`).

- [ ] **Step 1: Failing tests**: a test importing `@/lib/apps` (tsconfig paths) reaches `src/lib/apps.ts`; importing `@workspace/db` reaches `lib/db/src/index.ts` (pnpm workspace, package name in `lib/db/package.json`); `spawn("node", ["scripts/seed.mjs"])` or `execFile("tsx", ["scripts/x.ts"])` reaches that script.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement `relImports` with the resolver; child-process calls with a repo-relative script path count as reaching it.
- [ ] **Step 4:** `npm test`; Express snapshots identical (no test data in them); metrics: list test-reach count changes on Gobbles.
- [ ] **Step 5:** Commit `"tests: reach through path aliases, workspace packages and spawned scripts"`.

### Task 9: Tests skipped without an env flag

**Files:** Modify `core/tests.mjs` (test parsing, status), `core/report.mjs` (label); Test `test/tests.test.mjs`

- [ ] **Step 1: Failing test**: `describe.skipIf(!process.env.DB_TESTS)(…)`, `it.runIf(process.env.DB_TESTS)(…)`, `(process.env.DB_TESTS ? describe : describe.skip)(…)` → each test inside has `skipped: { needs: "DB_TESTS" }` and the rule shows "skipped (needs DB_TESTS)", not weak or untested; with `.veridic.json` `testEnv: { DB_TESTS: "1" }` they count normally.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`; snapshots identical.
- [ ] **Step 5:** Commit `"tests: a test that needs an env flag says so"`.

### Task 10: With --run, coverage decides

**Files:** Modify `core/tests.mjs` (`runVitest`, `runJest`, `runNodeTest`, `testCoverage`); Test `test/tests.test.mjs`

**Interfaces:**
- Produces: `fileCoverage(repo, runner, testFile) -> Map<repoFile, Set<line>> | { unavailable: why }`; `testCoverage(..., { run: true })` sets each test's `reaches_cited_code` from it when available, and `coverage: "runtime" | "static (<why>)"` on the result.

- [ ] **Step 1: Spike, then failing tests.** On a temp node:test repo, run `node --test --experimental-test-coverage --test-reporter=lcov` for one file and confirm the cited source lines appear in the lcov; for vitest, `--coverage.enabled --coverage.provider=v8 --coverage.reporter=json` (needs `@vitest/coverage-v8` in the repo); for jest, `--coverage --coverageReporters=json`. Ledger what works. Tests: node:test file that calls the cited function through an `import()` with a computed path (static reach can't see it) → reaches with `coverage: "runtime"`; a repo without `@vitest/coverage-v8` → `coverage: "static (@vitest/coverage-v8 not installed)"` and static results unchanged (Review Focus 4).
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement per test file (one run per file that names a rule); a test reaches when its file's run covered any cited line.
- [ ] **Step 4:** `npm test`; snapshots identical.
- [ ] **Step 5:** Commit `"tests: with --run, runtime coverage decides what a test reaches"`.
- [ ] **Step 6: Phase 3 checkpoint.** On the frozen launchpad copy: `veridic tests --run` per spec before/after; list the tests that moved from weak/unreached to reaching, and confirm the import-only workarounds the agent added are no longer needed (reach with them removed in a scratch copy). Stop until the user says go.

## Phase 4: statuses, parts, specs that aren't parts

### Task 11: Statuses thrown from helpers

**Files:** Modify `core/contract.mjs` (`calledStatuses`, error class statuses); Test `test/generalize.test.mjs`

- [ ] **Step 1: Failing test** on a synthetic Express repo shaped like the reported case: route handler → `getApp(ws, ref)` (service) → `withWorkspaceRead(ws, async (tx) => findApp(tx, ref))` → `throw new NotFoundError(…)`, where `class NotFoundError extends AppError { constructor(m) { super(404, "not_found", m) } }` and `AppError` stores `status` from its first argument; and `requireOwner` → `throw new ForbiddenError()` (403). Drift for an OpenAPI documenting 403 and 404 reports neither as "never returned".
- [ ] **Step 2:** Run. Expected: FAIL; ledger which link was missing (depth, the callback, or the subclass's `super(404, …)`).
- [ ] **Step 3:** Implement: follow functions passed as callbacks; read a subclass's status from `super(<status>, …)` or `super(…)` of a parent whose constructor assigns `this.status`; depth 3.
- [ ] **Step 4:** `npm test`. Expected snapshot changes: drift on Gobbles/launchpad may lose "never returned" entries; list each and confirm it's thrown from a helper.
- [ ] **Step 5:** Commit `"contract: statuses thrown from helpers and callbacks"`.

### Task 12: Parts found and named by folder

**Files:** Modify `core/modules.mjs` (`findModules`, naming), `bin/veridic` (`check`: old id map); Test `test/generalize.test.mjs`

- [ ] **Step 1: Failing tests**:
  - routes registered in a loop (`for (const t of tools) router.post(\`/mcp/${t.name}\`, handler(t))`) and an MCP endpoint (`app.post("/api/apps/mcp", mcpHandler)` with `@modelcontextprotocol/sdk` imported in its file) form a part named after their folder;
  - `app.use(hostRouter)` where `hostRouter` reads `req.hostname`/`req.headers.host` to pick an app forms a part;
  - parts in `api/auth` and `admin/auth` get ids `api-auth`, `admin-auth` (Review Focus 5); a single `auth/oauth` folder part is `oauth`;
  - a spec whose front matter names `auth-2`, now `oauth`: `check` prints `part auth-2 is now oauth` and the spec stays attached.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; record the old→new id map in `.veridic/parts-map.json` when ids change, read by `check` and the report.
- [ ] **Step 4:** `npm test`. Expected changes: part ids/names on Gobbles and launchpad where "<name> 2" existed; list them.
- [ ] **Step 5:** Commit `"parts: MCP endpoints, routes built in a loop, host routing; named by folder"`.

### Task 13: Specs that aren't parts, and traceability

**Files:** Modify `skill/scripts/tests.mjs`, `core/link.mjs` (`linkForSpec`), `core/tests.mjs` (`traceabilityTable`), `agents/veridic-test-writer.md`, `commands/tests.md`; Test `test/generalize.test.mjs`, `test/tests.test.mjs`

**Interfaces:**
- Produces: `linkForSpec(repo, specPath, args) -> same shape as linkForModule`.

- [ ] **Step 1: Failing tests**: `tests --spec specs/server/spec.md --link FR-001=t.test.ts:3` names the test `FR-001 (server): …`; `tests --module server --run` where `server` is a spec folder and no part runs and reports pass/fail; `traceabilityTable` keeps a `## Reviewed by hand` section from the existing file verbatim and its rows aren't counted as covered.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; `--link` rewrites `traceability.md`; agent docs say hand reviews go under "Reviewed by hand".
- [ ] **Step 4:** `npm test`; snapshots identical.
- [ ] **Step 5:** Commit `"tests: link and run specs that aren't parts; traceability from what's linked"`.

### Task 14: Launchpad acceptance

**Files:** Modify `docs/plans/2026-10-24-launchpad-feedback.md` (Results), `README.md` (product spec line if needed)

- [ ] **Step 1:** Fresh frozen launchpad copy. Run `check`, `report --json`, `stale`, `tests --run` per spec. Check each of the spec's success items: no rule out of date while its cited lines are unchanged; `stale --fix` moves no correct citation in an uncommitted spec; every spec's stories show; criteria not counted as untested; the import-workaround tests reach without the imports; a product spec above the parts.
- [ ] **Step 2:** Express snapshots and metrics against main: identical except the changes Tasks 2, 5, 8, 11 and 12 listed.
- [ ] **Step 3:** Record Results; commit `"docs: 0.12 results"`; show the user. Then the final whole-branch review.

## Results

(filled in at each checkpoint)
