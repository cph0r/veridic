# Rebuild Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Specs that carry the data schema, the environment, worked examples and screen
behaviour, plus `veridic conform`: a black-box suite from the specs that scores any
implementation, the original first.

**Architecture:** Two new generated spec sections (data per part, an app-level environment
spec) built like `generatedSections` in `core/specdata.mjs`; examples as a rule field; a
generator plus runner in `core/conform/`; a UI section per screen group; a rebuild benchmark
in veridic-bench.

**Tech Stack:** Node ≥22.5 ESM, `node:test`, `fetch` for the runner, Playwright only if the
repo has it (screenshots), no new dependencies.

**Spec:** `docs/specs/2026-10-24-rebuild-fidelity-design.md`

**Starts after:** 0.12 (citation hashes, product spec). Library packs (shared-semantics plan,
Task 4) improve Task 2's service list but aren't required: without them, Task 2 reads
package.json.

## Global Constraints

- Generated sections are marked `(generated)` in their heading and rewritten whole by `render`; written parts are never overwritten.
- No secret values: env files are read for variable names only; the suite and specs never contain a value read from `.env*`.
- `veridic conform` refuses a base URL whose host isn't `localhost`, `127.0.0.1`, `[::1]` or ends in `.test`/`.localhost`, unless `--allow-remote`.
- Express and Next.js both supported wherever routes are involved (route inventory carries `framework`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; pushing, merging, publishing need the user.

## Review Focus

1. A Prisma schema and SQL migrations for the same table: the schema wins, and their disagreement is reported, not merged.
2. An env var read with a fallback (`process.env.X ?? "dev"`) vs one checked at startup (zod env schema, `required()`): `required` differs.
3. A test whose request is built from variables, not literals: no example row is invented from it.
4. A conform check for a route whose seed record can't be created: reported as "not run (no seed)", never as pass.
5. A rebuild that answers 404 where the original answers 403 for another user's record: both count as "denied" (equivalent), and the report says which.

---

## Phase 1: what the code already says

### Task 1: Data spec

**Files:** Modify `core/data.mjs` (columns), `core/specdata.mjs` (`generatedSections` adds `data`), `skill/scripts/render.mjs`, `bin/veridic` (`check` reports drift); Test `test/data.test.mjs` (create)

**Interfaces:**
- Produces: `tableShape(repo, table) -> { name, at, hash, columns: [{ name, type, nullable, default?, enum? }], primaryKey: [col], unique: [[col]], foreignKeys: [{ columns, table, references }] }`; `dataMarkdown(tables) -> string` (section `## Data (generated)`); `dataDrift(specText, repo) -> [{ table, problem }]`.

- [ ] **Step 1: Failing tests** per source: a Prisma model with `@id`, `@unique`, `@default`, an enum and a relation; a Drizzle `pgTable` with `.notNull()`, `.default()`, `.references()`; a SQL `CREATE TABLE` with constraints; Review Focus 1.
- [ ] **Step 2:** Run. Expected: FAIL, `tableShape` missing.
- [ ] **Step 3:** Implement; the section lists the part's owned tables (`dataByModule`), each citing its definition with the 0.12 hash.
- [ ] **Step 4:** `npm test`; Express and Next.js snapshots identical (no route data changes).
- [ ] **Step 5:** Commit `"specs: a data section per part, from the schema"`.

### Task 2: Environment spec

**Files:** Create `core/environment.mjs`; Modify `skill/scripts/render.mjs`, `commands/specs.md` (writes `specs/environment/spec.md`); Test `test/environment.test.mjs` (create)

**Interfaces:**
- Produces: `environment(repo, g) -> { vars: [{ name, at: [file:line], default?, required: boolean }], services: [{ name, via: "pack"|"dependency", at }], schedules: [{ what, when, at }], deploy: [{ file, services: [{ name, ports?, image? }] }] }`; `environmentMarkdown(env) -> string`.

- [ ] **Step 1: Failing tests:** `process.env.X`, `import.meta.env.X`, `env.X` from a zod/t3 env schema (required unless `.optional()`/`.default()`), Review Focus 2; `.env.example` names only and never a value (a test asserts a value in `.env` never appears in the output); Vercel `crons` in `vercel.json`, `cron.schedule("0 * * * *", …)`, a BullMQ `Queue`; a compose file's services and ports.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test`.
- [ ] **Step 5:** Commit `"specs: an environment spec: env vars, services, schedules, deployment"`.
- [ ] **Step 6: Checkpoint.** Data and environment specs for RealWorld, a Next.js bench app and a frozen launchpad copy; show the user; stop until they say go.

## Phase 2: logic as examples

### Task 3: Examples under rules

**Files:** Modify `core/specdata.mjs` (rule field `examples`), `core/report.mjs` (`specDoc` reads them), `core/tests.mjs` (mining), `skill/references/spec-json.md`, `commands/spec.md`; Test `test/examples.test.mjs` (create)

**Interfaces:**
- Produces: spec.json rule field `examples: [{ given: {method, path, body?, as?: "owner"|"other"|"anon"}, then: {status, fields?: {k: v}, effect?}, proven_by?: "file:line" }]`; rendered as a table under the rule; `mineExamples(repo, test) -> examples` from a linked test (supertest/fetch request with literal method, path, body; asserted status and literal fields).

- [ ] **Step 1: Failing tests:** a supertest test `request(app).post("/orders").send({ items: 3, total: 120 }).expect(201)` + `expect(res.body.discount).toBe(12)` mines one row; Review Focus 3 (variables → no row); a rule citing a status write gets its transition rows from `stateMachine`; `specDoc` reads the table back.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; rows without `proven_by` render as unproven.
- [ ] **Step 4:** `npm test`.
- [ ] **Step 5:** Commit `"specs: worked examples under rules, mined from their tests"`.

## Phase 3: the conformance suite

### Task 4: Generating checks

**Files:** Create `core/conform/generate.mjs`; Test `test/conform.test.mjs` (create)

**Interfaces:**
- Produces: `conformChecks(repo) -> [{ id, rule: "spec:FR-003"|null, kind: "access"|"scope"|"status"|"example"|"journey", request: {method, path, as, body?}, expect: {status: number|"denied"|number[], fields?}, needs: ["seed:<name>"] }]` written to `.veridic/conform/checks.json`.

- [ ] **Step 1: Failing tests:** an auth route yields an `anon → 401` check; a scoped `:id` route yields `other → "denied"` (Review Focus 5); each documented status and each example row yields a check; a product journey (0.12) yields one ordered check; a route needing a record lists its seed.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement from the specs and the route inventory.
- [ ] **Step 4:** `npm test`.
- [ ] **Step 5:** Commit `"conform: checks generated from the specs"`.

### Task 5: Running them

**Files:** Create `core/conform/run.mjs`, `skill/scripts/conform.mjs`; Modify `bin/veridic` (`conform`), `commands/` (a `conform.md`); Test `test/conform.test.mjs`

**Interfaces:**
- Consumes: `.veridic.json` `conform: { seed: "<command>", users: { owner: {...}, other: {...} }, login: "<route or command that returns a cookie/token>" }`.
- Produces: `veridic conform --url http://localhost:3000 [--json]` → `{ checks, passed, failed: [{ id, rule, got }], not_run: [{ id, why }], fidelity_pct }`.

- [ ] **Step 1: Failing tests** against a tiny in-process Express app started by the test: passing checks; a failing one reports what it got; Review Focus 4; the URL guard refuses `https://example.com` without `--allow-remote`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement: run seed, log in as each user, run checks in order (journeys in sequence), compare.
- [ ] **Step 4:** `npm test`.
- [ ] **Step 5:** Commit `"conform: run the checks against a running app"`.
- [ ] **Step 6: Checkpoint.** RealWorld: write its seed hook, run `conform` against the original; every failure is either a spec fix or a seed fix (recorded). Show the user; stop until they say go.

## Phase 4: UI, and the rebuild benchmark

### Task 6: UI spec per screen group

**Files:** Modify `core/screens.mjs`, `core/ui.mjs`, `core/specdata.mjs` (UI section), `commands/spec.md`; Create `core/tokens.mjs`; Test `test/ui-spec.test.mjs` (create)

**Interfaces:**
- Produces: `screenFacts(repo, screen) -> { url, calls: [routeId], forms: [{ fields: [{ name, type, required }] }] }`; `designTokens(repo) -> { colors, fonts, spacing, radii }` from Tailwind config and CSS custom properties.

- [ ] **Step 1: Failing tests:** a React page with `useQuery` on `/api/orders` and a form (`<input name="email" required>`, react-hook-form with a zod schema) gives its calls and fields; a `tailwind.config.js` `theme.extend.colors` and `:root { --brand: … }` give tokens.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; the spec agent writes each screen's states (loading, empty, error, success); with Playwright in the repo, `veridic screens --shots` stores reference screenshots under `specs/<group>/shots/`.
- [ ] **Step 4:** `npm test`.
- [ ] **Step 5:** Commit `"specs: what each screen calls, its forms, and the design tokens"`.

### Task 7: Rebuild benchmark

**Files:** In `../veridic-bench`: create `rebuild/` (README, `run.mjs`), `REBUILD.md`

- [ ] **Step 1:** RealWorld at its pinned commit: write specs (`/veridic:specs`), data and environment sections, examples, and the seed hook; `conform` against the original must be 100% (or each failure explained).
- [ ] **Step 2:** A fresh agent session gets only `specs/` and builds the API in another stack (Fastify or Next.js route handlers); the prompt and transcript are kept.
- [ ] **Step 3:** `conform` against the rebuild; record fidelity per check kind (access, scope, status, example, journey) and the misses by gap (data, logic, UI).
- [ ] **Step 4:** `REBUILD.md` with the numbers and what each miss says the specs lack; commit; ask before pushing.

## Results

**Phase 1 (2026-10-24).** Data and environment specs:

| App | Tables (columns read) | Columns | Foreign keys | Env vars (required) | Services |
|---|---|---|---|---|---|
| RealWorld (Prisma) | 8 (8) | 31 | 3 | 4 (0) | none |
| saas-starter (Next.js, Drizzle) | 5 (5) | 35 | 6 | 5 (1) | Postgres, Stripe |
| CloudCrane copy (Drizzle) | 19 (19) | 154 | 28 | 38 (1) | Postgres |

Found on CloudCrane and fixed with a test: an apostrophe in a schema comment hid a table's
columns (13 -> 19 of 19). Vite and system built-ins (DEV, PROD, BASE_URL, HOME, PATH) are left
out of the env vars. CloudCrane gate: every number unchanged; Express unchanged.
