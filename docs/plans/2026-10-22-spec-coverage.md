# Spec coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Veridic measures how much of an app its specs describe, splits the app so timers, WebSocket code, helper-mounted routes and screens belong to parts, and `/veridic:specs` loops until the app is covered.

**Architecture:** A new `core/coverage.mjs` counts behaviour files against every rule's citations, per part. `findModules` gains non-route entry points (timers, sockets) and the route scan expands helper-mounted routes; a new `core/screens.mjs` groups frontend pages by URL area. `collectReport` carries `screens` and `coverage`, which `veridic coverage`, `veridic modules`, `prepare --module`, `/veridic:specs` and the dashboard read.

**Tech Stack:** Node ESM, node:test, the CodeGraph index via core/graph.mjs. No new dependencies.

**Spec:** docs/specs/2026-10-22-spec-coverage-design.md

## Global Constraints

- No new dependencies; no network; read-only on the target repo.
- Commands print compact JSON by default, `--md` for people; `veridic coverage` always exits 0 ("it's a measure, not a gate").
- Skips are listed with their reason, never silent.
- A file counts as covered when any rule in any spec cites a line in it.
- Private client apps are never named in this repo (call one "App A"); benchmark numbers only.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Tests: `npm test` (`VERIDIC_NO_SYNC=1 node --test "test/*.test.mjs"`) stays green after every task.

## Review Focus

1. A spec that cites a file through an alias or a base-relative path (`src/x.ts` for `apps/api/src/x.ts`) still counts that file as covered (Task 1 test `coverage resolves cited paths like cite does`).
2. A repo with no routes and no frontend still gets a coverage report: every behaviour file "in no part", nothing crashes (Task 1 test `coverage on a repo with no parts`).
3. A timer or socket in a file a route module already owns joins that module; it never creates a second module for the same file (Task 2 test `an entry point in a module's file joins that module`).
4. In a monorepo, frontend files that belong to a screen group are not counted "in no part" (Task 5 test `screen files are in their group, not in no part`).
5. A generated file is recognised from a banner in its first lines, without reading a huge file whole (Task 1 test `generated banner is read from the first lines only`).

---

### Task 1: `core/coverage.mjs` and `veridic coverage`

**Files:**
- Create: `core/coverage.mjs`, `skill/scripts/coverage.mjs`, `test/coverage.test.mjs`
- Modify: `bin/veridic` (command table: `coverage`), `README.md` (one line in the command list)

**Interfaces:**
- Produces: `skipReason(file: string, head: string, text: () => string): string | null` — `head` is the file's first 10 lines; returns `"test"`, `"generated"`, `"types only"`, `"config or build"`, `"seed or script"`, or null.
- Produces: `specCoverage(repo, data, { files? }) → { behaviour: number, covered: number, pct: number, parts: [{ id, name, kind: "module" | "screens", total, covered, uncovered: string[] }], orphans: string[], orphanFolders: [{ folder, files: string[] }], skipped: [{ file, reason }], cited: Map<string, string[]> }` — `orphanFolders` groups the orphans by their folder two levels below the package root (`src/lib/menuEnrichment/`), biggest first; `/veridic:specs` gives each its own part — `data` is `collectReport` output (uses `data.specs[].requirements[].cites[].file`, `data.modules[].files/code`, and `data.screens` when Task 4 lands; absent screens = none). `files` defaults to `repoFiles(repo)` filtered to `/\.[cm]?[jt]sx?$/`.
- Produces: `coverageMarkdown(c, { module? }): string`.

Skip rules (in order): `isTestFile(f)` or `/(^|\/)(testkit|fixtures|__mocks__)\//` → "test"; `/\/generated\//` or head matches `/@generated|do not edit|auto-?generated/i` → "generated"; `.d.ts`, or code (comments stripped by `codeOnly`) has no `/\b(function|class|const|let|var)\b|=>|module\.exports|exports\./` → "types only"; `/(^|\/)[^/]*\.config\.[cm]?[jt]s$|(^|\/)build\.[cm]?[jt]s$|(^|\/)(eslint|vite|vitest|jest|tsconfig)[^/]*$/` → "config or build"; `/(^|\/)scripts\/|(^|\/)seeds?\b|seedData/` → "seed or script".

Cited paths resolve with `makeResolver(repo, { files })` from core/citations.mjs, exactly as `veridic cite` does.

- [ ] **Step 1: Write the failing tests** in `test/coverage.test.mjs` with a temp repo (no index needed: pass `data` directly):
  - `coverage counts cited behaviour files and lists skips`: files `src/a.ts` (cited), `src/b.ts` (not), `src/a.test.ts`, `src/gen/generated/api.ts`, `src/types.ts` (`export type X = { a: string };`), `vite.config.ts`, `scripts/seed.ts`; one spec citing `src/a.ts:1-2`. Assert `behaviour === 2`, `covered === 1`, `pct === 50`, `skipped` reasons `["test","generated","types only","config or build","seed or script"]` (sorted by file), `orphans` deep-equals `["src/b.ts"]`.
  - `coverage per part`: `data.modules = [{ id: "orders", name: "Orders", files: ["src/a.ts"], code: ["src/b.ts"] }]` → part `orders` `{ total: 2, covered: 1, uncovered: ["src/b.ts"] }`, `orphans` empty.
  - `coverage resolves cited paths like cite does`: file `apps/api/src/x.ts`, spec cites `src/x.ts:1` → covered 1.
  - `coverage on a repo with no parts`: no modules, no specs → `covered 0`, every behaviour file in `orphans`.
  - `generated banner is read from the first lines only`: a file whose line 1 is `// @generated by orval` → skipped "generated"; a file with "do not edit" on line 50 → not skipped.
- [ ] **Step 2: Run** `VERIDIC_NO_SYNC=1 node --test test/coverage.test.mjs` — Expected: FAIL, `Cannot find module '../core/coverage.mjs'`.
- [ ] **Step 3: Implement** `skipReason`, `specCoverage`, `coverageMarkdown` in `core/coverage.mjs`. Markdown: `Covered: 289 of 388 behaviour files (74%)`, then one `## <part name>` per part with `covered/total` and the uncovered files, then `## In no part`, then `## Skipped` grouped by reason with counts.
- [ ] **Step 4: Implement** `skill/scripts/coverage.mjs`: `--repo`, `--module <id>`, `--md`, `--json` (default); loads data with `collectReport(repo)`; exits 0. Register in `bin/veridic` as `coverage: ["skill/scripts/coverage.mjs", "how much of the app the specs describe: every behaviour file and the spec that cites it (--module <id>, --md)"]`.
- [ ] **Step 5: Run** the test file, then `npm test` — Expected: all pass.
- [ ] **Step 6: Commit** `coverage: how much of the app the specs describe, per part, with every skip and its reason`.

### Task 2: Timers and sockets join the split

**Files:**
- Modify: `core/scope.mjs` (export the entry finder), `core/modules.mjs` (`findModules`), `core/report.mjs` (modules without routes), `test/generalize.test.mjs` (new tests near the module tests)

**Interfaces:**
- Produces: `entryPoints(g, files: string[]) → [{ kind: "timer" | "socket", id: string, name: string | null, file, start, end }]` in core/scope.mjs. Timers: the existing `TIMER_CALL` units. Sockets: `/new\s+WebSocketServer\s*\(|\b[\w$]+\.on\(\s*["'](connection|upgrade)["']|\bio\.on\(\s*["']connection["']/`, extent by `matchParen` like timers. `id` is `"<kind> <name|(anonymous)> @ <file>:<start>"`. `scope()` calls it instead of its inline timer loop (behaviour unchanged).
- Produces: `findModules(g, inv)` modules gain `entries: [{ kind, id, file, start, end }]` (empty array when none); a module may have `routes: []`.
- Consumes: `footprintOf(g, unit)` from core/impact.mjs (works on any `{ id, file, start, end }`).

Placement (after step 3's Jaccard joins, before naming): an entry whose file a group already owns joins that group; else it joins the group whose domain files have Jaccard ≥ 0.3 with the entry's reach; else entries are grouped by file into a new module named from the file's basename (`retryPushes.ts` → "Retry pushes", id `retry-pushes`). Report stats for such a module are zeros; `does` lists the entries' names.

- [ ] **Step 1: Write failing tests** (use the existing `fakeRepo` plus `nodes` for reach, or a real indexed fixture via `test/fixture.mjs` if reach needs edges):
  - `a timer that shares nothing becomes its own module`: route file `src/orders.ts` (`router.get("/orders", …)`), timer file `src/jobs/retryPushes.ts` (`setInterval(retry, 60000)`) → modules include id `retry-pushes` with `entries[0].kind === "timer"` and `routes.length === 0`.
  - `an entry point in a module's file joins that module`: `setInterval` inside `src/orders.ts` → no new module; module `orders` has one entry.
  - `a WebSocket server is an entry point`: `const wss = new WebSocketServer({ server }); wss.on("connection", onConn)` in `src/realtime/index.ts` → an entry of kind `socket`.
- [ ] **Step 2: Run** them — Expected: FAIL (no `entries`).
- [ ] **Step 3: Implement** `entryPoints`, the placement above, and make `collectReport`'s module loop tolerate `routes: []` (stats 0, `does` from entry names).
- [ ] **Step 4: Run** `npm test` — Expected: all pass, including the existing module-split tests unchanged.
- [ ] **Step 5: Commit** `modules: timers and WebSocket handlers belong to a part`.

### Task 3: Routes mounted through a helper

**Files:**
- Modify: `core/routes.mjs` (`routeInventory`), `test/generalize.test.mjs`

**Interfaces:**
- Produces: routes from `helper(routerVar, arg)` calls: when a file calls an imported or local function with a mounted router variable as its first argument, and that function's body calls `<firstParam>.(get|post|put|patch|delete|all)(path, …)`, each such call is a route on `routerVar`. `${name}` in the path is replaced by the call's literal for `name`: a string second argument when the helper's second parameter is `name`, or the property `name` of an object-literal second argument (destructured `{ base }` or `opts.base`). Unresolved names keep today's `:name` form. `route.file/start/end` point at the call inside the helper.

- [ ] **Step 1: Write the failing test** `routes: a helper mounting routes on the router it is given`: `src/jobRoutes.ts` exports `function mountJobRoutes(router, { base }) { router.post(\`${base}/start\`, start); router.get(\`${base}/stream\`, stream); }`; `src/admin.ts` does `const router = Router(); mountJobRoutes(router, { base: "/admin/jobs" }); export default router;` and is mounted at `/api`. Assert ids include `POST /api/admin/jobs/start` and `GET /api/admin/jobs/stream`.
- [ ] **Step 2: Run** — Expected: FAIL (ids missing).
- [ ] **Step 3: Implement** in `routeInventory` alongside the existing chain walk (reuse `chainsOf`, `stringValue`, `routePathOf`, the import resolver).
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `routes: routes a helper mounts on the router it is given`.

### Task 4: Screen groups

**Files:**
- Create: `core/screens.mjs`, test cases in `test/generalize.test.mjs` (next to the existing `veridic-ui-` fixture)
- Modify: `core/ui.mjs` (export `importResolver`), `core/report.mjs` (`out.screens`), `core/modulectx.mjs` (`moduleList` lists screen groups after modules)

**Interfaces:**
- Produces: `screenGroups(repo, ui: { files: [{ file, kind }] }, all: string[], specs) → [{ id, name, pages: string[], files: string[], spec_path, specs: string[] }]` in core/screens.mjs.
  - A page is a `ui.files` entry of kind `page`, or a file under a `pages/` or `app/` folder with a default-exported component.
  - Its area is the first segment of its URL from the router (`path="/admin/orders"` / `path: "/admin/orders"` with the page's component, resolved through imports); without a router match, the first word of its path under `pages/` (`admin-orders.tsx`, `admin/…` → `admin`). Pages with no segment (`/`, `/t/:table`) and words used by one page only → `guest`.
  - `files` = the group's pages plus components, hooks and lib files imported (transitively, via `importResolver`) only by that group's pages. Imported by pages of several groups → in no group (shared UI).
  - `name`: `"<Area> screens"` (`"Admin screens"`, `"Guest screens"`); `spec_path`: `specs/<id>-app/spec.md`; `specs`: existing spec paths whose citations cover the most of the group's files (any spec citing ≥ 1 of them, most first).
- Ruling: areas come from the URL only, not the route guard the design also mentions; the URL area separates guest, staff and owner pages in App A and the fixtures, and a guard-based split can follow if an app needs it.
- `data.screens` holds these groups; `specCoverage` (Task 1) reads them as parts of kind `"screens"`.

- [ ] **Step 1: Write failing tests**:
  - `screens group by URL area`: router file with `/` → `Landing`, `/t/:table` → `Order`, `/admin/orders` → `AdminOrders`, `/owner/clients` → `OwnerClients`; components `CartPanel` (imported by Order only) and `Button` (imported by all). Assert group ids `["admin","guest","owner"]`, guest files include `CartPanel`, no group includes `Button`.
  - `screen files are in their group, not in no part`: with `data.screens` from the above and no specs, `specCoverage(...).orphans` excludes `CartPanel` and includes `Button`.
- [ ] **Step 2: Run** — Expected: FAIL (no core/screens.mjs).
- [ ] **Step 3: Implement** `screenGroups`; call it in `collectReport` after `linkUi` (`out.screens`); `moduleList` appends `{ id, name, kind: "screens", pages: n, spec_path, specs }` rows.
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `screens: frontend pages grouped by who uses them, each with its own spec`.

### Task 5: `prepare --module` for screens, and the coverage step in the spec skill

**Files:**
- Modify: `core/modulectx.mjs` (`moduleMarkdown` for a screen group), `skill/scripts/prepare.mjs` (accept a screen group id), `skill/SKILL.md`, `commands/spec.md`, test in `test/generalize.test.mjs`

**Interfaces:**
- Consumes: `data.screens`, `specCoverage`.
- Produces: `prepare --module <screen group id>` Markdown: the group's pages with their URLs, its files numbered like a module's code, the API calls its files make (from `linkUi`) and, for each, the server spec rules that cite that route's handler (`specs/orders FR-016`), and the group's uncovered files.

- [ ] **Step 1: Write the failing test** `prepare for a screen group lists its pages and the server rules its calls depend on`: fixture where `Order` calls `POST /api/orders` and `specs/orders/spec.md` FR-001 cites that handler → Markdown contains `/t/:table` and `specs/orders/spec.md FR-001`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**; in SKILL.md ("Writing a spec", after step 5) and commands/spec.md add: "Then `veridic coverage --module <id>`: cite each uncovered file in a rule, or say in Assumptions why it needs none. A screen rule that depends on a server rule links it in one line (`Server rules: specs/orders FR-016`) instead of restating it."
- [ ] **Step 4: Run** `npm test` — Expected: all pass.
- [ ] **Step 5: Commit** `prepare: a screen group's context; the spec skill checks coverage before it's done`.

### Task 6: `/veridic:specs` loops on coverage

**Files:**
- Modify: `commands/specs.md`

**Interfaces:**
- Consumes: `veridic coverage` (JSON: `pct`, `parts[].uncovered`, `orphans`), `veridic modules` (modules and screen groups with `spec_path`).

- [ ] **Step 1: Rewrite** the command's steps as the design's loop: Plan from `veridic coverage` (parts with no spec, riskiest first: money, high issues, size; then parts whose spec misses more than a fifth of their files; then orphan folders, one part each); Ask (plan table plus "covered now: N%"); Write (one agent per part, at most four at a time, foreground; an agent extending a spec gets `veridic coverage --module <id>` and must cite each uncovered file or say why not); Measure again and report before/after and what's left with reasons; stop when only skips and explained files remain.
- [ ] **Step 2: Check by reading** the command against the design's section 4, line by line.
- [ ] **Step 3: Commit** `specs: /veridic:specs writes until the app is covered`.

### Task 7: Covered on the dashboard

**Files:**
- Modify: `core/report.mjs` (`out.coverage = specCoverage(...)` without `cited`), `core/report-page.js` (model `counts.coverage`, a third gauge, one later card), `test/report-page.test.mjs`

**Interfaces:**
- Consumes: `D.coverage = { behaviour, covered, pct, parts: [{ id, name, total, covered, uncovered }], orphans }`.
- Produces: model `counts.covered`, `counts.behaviour`; `later` gains `{ tone: "todo", html: "N files no spec describes", w: "Most in <part> (k).", spec: <that part's first spec path or null> }`. A card with `spec: null` opens nothing.

- [ ] **Step 1: Write failing tests** in test/report-page.test.mjs:
  - `the dashboard shows how much of the app the specs describe`: `D.coverage = { behaviour: 10, covered: 7, pct: 70, parts: [{ id: "orders", name: "Orders", total: 5, covered: 2, uncovered: ["a","b","c"] }], orphans: [] }` → `m.counts.covered === 7`, `m.counts.behaviour === 10`, a later card matching `/3 files no spec describes/`.
  - `no coverage data, no gauge`: without `D.coverage` → `m.counts.behaviour === 0` and no such card.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement**: the model reads `D.coverage`; the view adds a third ring "Covered: 7 of 10 files described by a spec" when `behaviour > 0`; `collectReport` sets `out.coverage`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass. Regenerate the report on the realworld bench copy and check the gauge renders (headless screenshot).
- [ ] **Step 5: Commit** `report: a Covered gauge and one card for what no spec describes`.

### Task 8: Measure

**Files:**
- Modify: `docs/plans/2026-10-22-spec-coverage.md` (results section), no code

- [ ] **Step 1:** Copy App A at its 19-spec state (its specs before the hand-directed run) to a temp folder; run `veridic coverage` (expect ≈ 38%), then `/veridic:specs` headless with the new Veridic, then `veridic coverage` again. Record coverage, number of specs, cite/claims exit codes for each new spec, and cost/time from the run JSON.
- [ ] **Step 2:** Same on juice-shop from the bench cache (it has an Angular frontend): coverage before/after, specs added.
- [ ] **Step 3:** Write the numbers (App A anonymised) under "Results" here; success is ≥ 74% on App A with every new spec clean, at no more than the hand-directed cost.
- [ ] **Step 4: Commit** `plan: measured coverage before and after /veridic:specs`.

## Results (2026-10-22)

**App A** (private Express + React app; a fresh copy with its original 19 specs; `/veridic:specs` headless on Sonnet, before the final-review fixes):

| | Before | After `/veridic:specs` | Hand-directed (6 agents, Opus) |
|---|---|---|---|
| Behaviour files cited by a spec | 149 / 384 (39%) | **380 / 384 (99%)** | 289 / 388 (74%) |
| Specs | 19 | 44 | 30 |
| Agents | | 30 (3 screen groups, 5 parts with gaps, 22 folders in no part) | 6 |
| Cost, time | | $15.43, 37 min, 43 turns | not recorded |

Checked independently after the run: every citation in all 44 specs resolves and `veridic claims` passes on all of them; 3 specs carry 4 range warnings (a citation starting on an import or a blank line), which their agents had reported as clean. The 4 files left: one an agent explained (a provider-name map), three in parts under the one-fifth threshold. No app code changed.

Found by the run and fixed: two agents extended the same spec at once (it merged cleanly, by luck); `/veridic:specs` now gives parts that share a spec to one agent. Screen specs were written to `specs/<area>` rather than `specs/<area>-app`; the final-review fix makes screen ids `<area>-app`, matching their spec paths.

**juice-shop** (public, Angular frontend, no specs): `veridic coverage` only, 0 / 371, 39 parts, no screen groups. Not run through `/veridic:specs`: Angular routes (no leading slash, no pages/ folder) give no screen groups, and data/static/codefixes (80 sample files) count as behaviour; both are recorded gaps.
