# Shared code semantics, library packs and trap tests

**Status:** draft, queued after 0.12 · **Date:** 2026-10-24

## Why

Building the Next.js adapter took about 30 fixes. About two-thirds weren't about Next.js. They
were about reading JavaScript (a `{` in a regex literal, type parameters, `(await x) as T`),
what code means in any framework ("a lookup that returns null isn't a sign-in check", "the
caller's id must be used in the query"), or libraries (Prisma ignoring `undefined`, Supabase
chains, `analytics.capture`). Today each adapter answers those questions its own way:
- Express judges guards by middleware **names** (`AUTH_GUARD`, `OWNER_GUARD`, `CALLER` in
  `core/access.mjs`);
- Next.js follows **definitions** (`checksSignIn`, `scopesCaller`, `definitionOf` in
  `core/frameworks/nextjs.mjs`).
Each new adapter would rediscover the same traps through a benchmark and a review.

## Goal

An adapter only says where routes and their handlers are, and what its framework's sign-in,
rejection and caller look like. What code means, and what libraries do, are answered once.
Every trap found so far is a test every adapter must pass.

## Design

1. **Trap tests (`test/traps/`).** A table of cases. Each has a name, the code in each
   framework's form (a small template per adapter), and the expected `access`, `scoped`,
   `flags` and effects. Seeded from `test/nextjs-review.test.mjs`, the semantic cases in
   `test/nextjs.test.mjs`, and Express's in `test/generalize.test.mjs`. Written first, so they
   record today's behaviour, wrong answers included (marked `known: "express"` and so on).
2. **A semantics layer (`core/semantics/`) for JavaScript/TypeScript.**
   - **Facts per function, computed once and memoized per repo.** Its extent and calls from
     CodeGraph (`g.nodes`, `g.usesInRange`), falling back to the parser. Whether it rejects
     (401/403, a redirect to sign-in, a throw a sign-in error handler maps). Its session sources
     (from the adapter's idioms). Its lookups: table, key and where each value comes from
     (caller, URL param, body, constant).
   - **Questions answered from those facts:** `checksSignIn(fn)`, `scopesParam(fn, param)`
     (per URL id, which closes the known "team checked, viewId not" miss), and
     `callerUsedInQuery(fn)`.
   - Definitions are followed across imports with one resolver (today there are three:
     `definitionOf`, `importResolver`, `reach.mjs`'s own).
3. **Library packs (`core/libraries/`).** One file per library: Prisma, Drizzle, Supabase,
   Stripe, Mongoose, Sequelize, knex, analytics SDKs. Each says how it's detected (package.json
   dependency), its effect patterns, and its pitfalls (e.g. Prisma ignores a filter whose value
   is `undefined`, so a check by `session?.user.id` passes when signed out). `effects.mjs`
   applies the packs a repo uses, whatever the framework, so the Express-only and
   Next.js-only pattern lists go away.
4. **Express onto the layer.** Middleware is judged by what its definition does, with the name
   rules kept only as a fallback when the definition can't be found (a package's middleware).
   This **changes Express output**: every change must be explained by a trap test, listed, and
   the Express benchmark's precision mustn't drop (new flags judged by hand).
5. **Bench judging as a script.** `node judge.mjs <app>` writes the two review packages, flagged
   issues (precision) and a fixed-seed sample of unflagged guarded or scoped routes (recall),
   for a reviewer, and records both verdicts. RESULTS.md shows recall next to precision.

## What stays per adapter

Route discovery, the framework's idioms (middleware files, decorators, request and response
forms), its trap templates, and a benchmark with hand verdicts.

## Success

- The trap suite passes for Express and Next.js with no `known:` markers left that the design
  claims to fix.
- Next.js output on the five bench apps doesn't get worse (precision, recall sample).
- Express benchmark precision doesn't drop, and every Express change has its trap.
- `core/frameworks/nextjs.mjs` loses `checksSignIn`, `scopesCaller`, `definitionOf`,
  `helperGuards` and its effect list. `core/access.mjs` loses the name rules except as a
  fallback.

## Out of scope

Python or other languages (a later language layer would follow this one's shape). Per-test
runtime coverage (0.12 covers per file).
