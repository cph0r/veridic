# Shared Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer "what does this code mean" and "what does this library do" once, for every
JavaScript adapter, and make every known trap a test each adapter must pass.

**Architecture:** `test/traps/` (cases × framework templates), `core/semantics/` (per-function
facts from CodeGraph, plus questions over them), `core/libraries/` (effect and pitfall packs).
Next.js moves onto it first, then Express (with listed output changes), then the bench gets a
judging script.

**Tech Stack:** Node ≥22.5 ESM, `node:test`, CodeGraph's index (`core/graph.mjs`), no new dependencies.

**Spec:** `docs/specs/2026-10-24-shared-semantics-design.md`

**Starts after:** 0.12 (`docs/plans/2026-10-24-launchpad-feedback.md`) is merged.

## Global Constraints

- Trap tests are written before the code they pin, and record today's answers, wrong ones included (`known: "<adapter>"` with the reason).
- Next.js output on the five bench apps: precision and the 30-route recall sample no worse.
- Express output may change only in Task 5, each change explained by a trap and listed in that task's commit; Express bench precision mustn't drop, and every new Express flag is judged by hand.
- Private apps never appear in traps, fixtures or docs.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; pushing, merging, publishing need the user.

## Review Focus

1. A function CodeGraph didn't index (generated, or in an unindexed folder): facts fall back to the parser, and no guard is granted from a missing definition.
2. A wrapper from a package (`next-auth`, `passport`): no definition to read; the adapter's idioms decide, never "auth" by default.
3. Recursive or mutually recursive helpers: facts terminate and are memoized.
4. A lookup whose key is a URL id and whose other key is the caller: scoped for that id only; a second id in the same URL stays unscoped unless its own lookup pairs it.
5. A repo with two ORMs (Prisma and raw SQL): both packs apply.

---

### Task 1: The trap suite

**Files:** Create `test/traps/cases.mjs`, `test/traps/templates.mjs`, `test/traps.test.mjs`

**Interfaces:**
- Produces: `cases: [{ name, kind: "access"|"scope"|"effect"|"route", code: { handler, helpers? }, expect, known? }]`; `templates[adapter](case) -> files` for `express` and `nextjs`.

- [ ] **Step 1:** Move each semantic case from `test/nextjs-review.test.mjs`, `test/nextjs.test.mjs` (guards, scoping, effects) and `test/generalize.test.mjs` (Express access and effects) into `cases.mjs`, written once in a framework-neutral form (handler body, helper files). A route-discovery case stays in its adapter's own test file.
- [ ] **Step 2:** Templates render each case as an Express route (`router.delete("/x/:id", mw, handler)`) and a Next.js `route.ts`.
- [ ] **Step 3:** `test/traps.test.mjs` runs every case on both adapters. A case marked `known: "express"` asserts today's (wrong) answer and is reported as a known trap, not a failure.
- [ ] **Step 4:** `npm test`. Expected: passes; the list of known traps is printed (it is the work list for Tasks 3 and 5).
- [ ] **Step 5:** Commit `"traps: every known trap, as one table run on each adapter"`.

### Task 2: Per-function facts

**Files:** Create `core/semantics/facts.mjs`, `core/semantics/definitions.mjs`; Test `test/semantics.test.mjs`

**Interfaces:**
- Produces: `definitionOf(g, fromFile, name) -> { file, start, end, body } | null` (one resolver: local, named/default import, tsconfig paths, workspace packages; CodeGraph nodes first); `factsOf(g, fn, idioms) -> { rejects: [{ kind: "status"|"signin-redirect"|"throw", line }], sessions: [{ var, source, line }], exitsIfMissing: [var], lookups: [{ line, keys: { key: { from: "caller"|"param:<name>"|"body"|"const"|"unknown" } } }], calls: [name], passes: [name] }`, memoized per `g` and `(file, name)`; `idioms` is the adapter's `{ sessionSources, callerExprs, rejections }`.

- [ ] **Step 1: Failing tests:** facts for each helper shape in the trap cases (getServerSession then exit, lookup returning null, catch-block 401, membership lookup `{ userId_teamId: { userId, teamId } }`, current-user lookup `{ id: session.user.id }`, a `{` inside a regex literal, `(await x) as T`), and Review Focus 1–3.
- [ ] **Step 2:** Run. Expected: FAIL, module missing.
- [ ] **Step 3:** Implement on CodeGraph's extents and call edges, the parser only as a fallback; catch blocks never contribute rejections or calls.
- [ ] **Step 4:** Tests pass; `npm test`.
- [ ] **Step 5:** Commit `"semantics: facts per function, from the code index"`.

### Task 3: Questions over the facts; Next.js moves onto them

**Files:** Create `core/semantics/questions.mjs`; Modify `core/frameworks/nextjs.mjs` (remove `checksSignIn`, `scopesCaller`, `definitionOf`, `helperGuards`), `core/access.mjs` (per-id scoping for routes that carry it); Test `test/semantics.test.mjs`, `test/traps.test.mjs`

**Interfaces:**
- Produces: `checksSignIn(g, fn, idioms) -> boolean`; `scopesParam(g, fn, param, idioms) -> boolean`; `callerUsedInQuery(g, fn, idioms) -> boolean`; a route may carry `scope: { [param]: true }` instead of `scope: "caller"`, and access flags an id only when its own param isn't scoped (Review Focus 4).

- [ ] **Step 1: Failing tests:** the papermark-shaped known miss (team membership on `teamId`, a `viewId` read by itself) flags `viewId`; Review Focus 4.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; Next.js adapter calls the questions with its idioms.
- [ ] **Step 4:** `npm test` (traps: no Next.js known traps left); Next.js bench apps: precision and the recall sample no worse (re-run the recall reviewer on the same seed); Express snapshots identical.
- [ ] **Step 5:** Commit `"semantics: sign-in and scoping answered once; Next.js uses them"`.

### Task 4: Library packs

**Files:** Create `core/libraries/{index,prisma,drizzle,supabase,stripe,mongoose,sequelize,knex,analytics}.mjs`; Modify `core/effects.mjs`, `core/semantics/facts.mjs` (pitfalls); Test `test/libraries.test.mjs`

**Interfaces:**
- Produces: a pack is `{ name, detect(pkgDeps) -> boolean, effects: [[kind, RegExp]], pitfalls?: (lookup) -> string | null }`; `packsFor(repo) -> pack[]`; `routeEffects` applies `packsFor(repo)` instead of `EFFECTS`/`NEXT_EFFECTS`.

- [ ] **Step 1: Failing tests:** each pack's effect cases (moved from the effect traps); Prisma's pitfall: `where: { id, authorId: session?.user.id }` on a route that may be signed out → the lookup's caller key is `unknown`, not `caller` (taxonomy's bug); Review Focus 5.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; a repo with no detected pack gets the generic SQL/HTTP patterns.
- [ ] **Step 4:** `npm test`; Next.js bench no worse. Express snapshots: list every effect that changes (packs now apply to Express) — this list is Task 5's input, not yet committed as accepted.
- [ ] **Step 5:** Commit `"libraries: effect and pitfall packs, applied by what a repo uses"`.

### Task 5: Express onto the layer

**Files:** Modify `core/access.mjs` (name rules become the fallback), `core/frameworks/express.mjs` (idioms: `req.user`, `req.session`, `passport`), `core/effects.mjs`; Test `test/traps.test.mjs`

- [ ] **Step 1:** Remove the `known: "express"` markers: those traps now fail (RED).
- [ ] **Step 2:** Implement: a middleware's guard comes from `checksSignIn` on its definition; names (`AUTH_GUARD`…) only when the definition can't be found (Review Focus 2).
- [ ] **Step 3:** `npm test` green. Express snapshots (RealWorld, Gobbles, frozen launchpad) and the 10 Express bench apps: list every change in access, scoping and effects, each with the trap that explains it.
- [ ] **Step 4: Checkpoint.** Judge every new Express bench flag by hand; precision mustn't drop below today's. Show the user the change list and the numbers; stop until they say go.
- [ ] **Step 5:** Commit `"express: guards and effects from what the code does"`.

### Task 6: Judging as a script

**Files:** In `../veridic-bench`: create `judge.mjs`; modify `run.mjs` (recall column), `verdicts.json` (a `_recall` section)

- [ ] **Step 1:** `node judge.mjs <app> [--seed N]` writes `issues/<app>.precision.json` (flagged high/medium) and `issues/<app>.recall.json` (30 unflagged guarded or scoped routes, fixed seed), each with the handler location and what Veridic believed.
- [ ] **Step 2:** `run.mjs` reads `_recall` verdicts and adds "recall sample: N of M right" per app and in the summary.
- [ ] **Step 3:** Run on the five Next.js apps with the existing recall verdicts; RESULTS.md shows both numbers.
- [ ] **Step 4:** Commit in the bench repo; ask before pushing.

## Results

(filled in at the checkpoint)
