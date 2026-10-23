# Rebuild fidelity: data, environment, examples, conformance, UI

**Status:** draft, queued after 0.12 · **Date:** 2026-10-24

## Why

Specs today rebuild a backend that behaves the same at the API level: its routes, access rules
and statuses. Four things are missing for a faithful rebuild:
- the **data schema**: Veridic finds table names (`core/data.mjs`), not their columns;
- **infra and config**: nothing records env vars, services, cron jobs or deployment;
- **fine-grained logic**: rules are prose, and formulas and edge cases don't survive prose;
- **UI**: screens are grouped (`screens.mjs`) and linked to routes (`ui.mjs`), but not described.

Above all, nothing **proves** a rebuild behaves the same.

## Goal

A spec set that rebuilds an app's backend faithfully and its UI at the level of behaviour, plus
a black-box conformance suite generated from the specs that measures any implementation against
them. The first implementation it measures is the original, which proves the specs right.

## Design

1. **Data spec (generated section).** Per part: the tables it owns (as `dataByModule` already
   decides), each with its columns (name, type, nullable, default), primary key, unique
   constraints, foreign keys and enum values. Read from Prisma models, Drizzle tables and SQL
   migrations; Mongoose, Sequelize and TypeORM where declared. Each table cites its definition
   with a 0.12 hash, so a schema change marks it out of date. `veridic check` reports drift
   between the spec's data section and the schema.
2. **Environment spec (generated, app level, `specs/environment/spec.md`).**
   - Every env var read: name, where, a default if any, and whether startup fails without it.
   - Outside services: from the library packs of the shared-semantics plan, else from
     package.json dependencies.
   - Cron jobs and queues: scheduler calls, Vercel `crons`, `node-cron`, BullMQ.
   - What Dockerfile, compose, CDK or CloudFormation files define: services, ports, volumes,
     resources.

   Names only, never values: `.env` files are read for names only.
3. **Examples under rules.** A rule may carry `Examples`: a small table of inputs and the
   expected output (status, fields, side effect). Rows come from the tests linked to the rule
   (the request a test sends and what it asserts, when both are literals); the spec agent adds
   rows for untested rules, marked unproven. Transition tables come from `states.mjs` where the
   rule cites a state change.
4. **Conformance suite (`veridic conform`).** Generated from the specs into
   `.veridic/conform/`, a set of HTTP checks runnable against a base URL:
   - per route: signed out gets 401 (unless public); another user's record gets 403 or 404
     (when scoped); the documented statuses;
   - per example row: the request and its expected status and fields;
   - per product journey (0.12): the steps in order.

   The app's own seed hook (a script named in `.veridic.json`: `conform.seed`, `conform.users`)
   creates two users and the records the checks need. It runs against the original first, where
   a failure means the spec or the seed is wrong, and then against any rebuild. Output: pass and
   fail per rule, and a fidelity percentage.
5. **UI spec (per screen group, generated plus written).** Per screen:
   - generated: its URL, the routes it calls (`ui.mjs`), its forms and their fields (from JSX
     form inputs and schemas), and the design tokens (Tailwind theme, CSS custom properties);
   - written by the spec agent: the states it shows (loading, empty, error, success);
   - optional: Playwright screenshots stored as reference images.

   Fidelity is the same screens, flows and calls, not pixels.
6. **Rebuild benchmark (veridic-bench).** RealWorld's specs, a rebuild by an agent from the specs
   alone in another stack, and `veridic conform` against both. The fidelity score is the headline
   number. Its misses show which gap (data, logic, UI) is still open.

## Constraints

- Deterministic extraction for data, environment and generated UI; the LLM only writes the
  parts code can't say (screen states, examples for untested rules).
- No secret values are ever read into a spec or the suite.
- `veridic conform` never runs against a URL the user didn't name, and never against production
  by default (it refuses a host without `localhost`/`127.0.0.1`/`.test` unless `--allow-remote`).
- Private apps never appear in committed fixtures, docs or the benchmark.

## Out of scope

Performance, caching and retry timing; pixel-level UI comparison; generating the rebuild itself
(the agent does that from the specs).
