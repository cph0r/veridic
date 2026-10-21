# Spec coverage: design

Date: 2026-10-22. Status: draft for review.

## Goal

Veridic writes specs for the whole app, not just the code its routes reach, and
says how much of the app its specs describe. Run `/veridic:specs` on an app and
the result is a set of specs that cite nearly all of the app's behaviour code;
what's left is listed, each file with the reason it's left.

Why: on App A (a private Express + React app, 482 source files) Veridic's specs
covered every route but cited 148 of 388 behaviour files (38%). Nothing said so.
Whole areas were missing: every screen, the real-time conversation code
(WebSocket), an outbound integration and its retry timer, an AI processing
pipeline. Six hand-directed agents brought it to 289 of 388 (74%) with 11 new
specs. Veridic should get there by itself.

## Why the gaps happen

1. **Parts come from routes alone.** `findModules` (core/modules.mjs) builds
   units from route files and what their handlers reach. Code reached only from a
   WebSocket server, a timer, or a screen is in no part, so `prepare --module`
   never shows it and the spec writer never describes it. `core/scope.mjs`
   already finds timers and other entry points, but only for `prepare`'s scope.
2. **Some routes are invisible.** Routes registered through a helper with a
   template-string path (`router.get(\`${base}/stream\`, …)` inside
   a `mountRoutes(router, base)` helper) are not in the route inventory.
3. **Screens have no home.** A module lists the screens that call it, but the
   spec writer is asked to describe the module's routes, so screens are never
   specified.
4. **Nothing measures coverage.** Citations exist per rule; no command adds them
   up against the source files.

## Design

### 1. `veridic coverage`

New command and core module (`core/coverage.mjs`). For the repo:

- **Behaviour files:** every source file the index knows, minus files nobody
  needs to spec, each skip with its reason: tests, generated code (`/generated/`,
  a "do not edit" banner), type-only files (`.d.ts`, files that export only
  types), config and build files (`*.config.*`, `build.*`), seed data and dev
  scripts (`seed*`, `scripts/`). Skips are listed, never silent.
- **Cited:** a file is covered when any rule in any spec cites a line in it.
- **Output:** the share covered; per part (module or screen group): its files,
  covered, and the uncovered ones; files in no part; the skipped files with
  their reasons. `--json` for the data, `--md` for people, `--module <id>` for
  one part. Exit 0 always (it's a measure, not a gate).

### 2. A split that reaches more code

- **Entry points beyond routes.** `findModules` takes the entry points
  `core/scope.mjs` already finds: timers (`setInterval`, cron) and WebSocket
  servers and handlers (`new WebSocketServer`, `wss.on("connection")`,
  `server.on("upgrade")`, Socket.IO). Each joins the module whose code it shares
  most (the existing Jaccard step); one that shares nothing forms its own
  module, named after its file (e.g. `realtime`, `retry`).
- **Template-string routes.** The route scan resolves a template path when its
  parts are string constants in the same file or arguments of the call that
  mounts it (`mountRoutes(router, "/api/admin/jobs")`). What it can't
  resolve it records as a route with `path: null` and its file and line, so its
  handler still joins a module.
- **Library code reached by nothing.** After the split, files no entry point
  reaches are grouped by folder; `coverage` lists them as "in no part".

### 3. Screens get their own specs

- **Screen groups.** For a frontend, Veridic groups pages by who uses them,
  from the router: the first URL segment and the route guard (`/admin/*` behind
  a staff guard → "staff screens"; `/owner/*` → "owner screens"; public pages →
  "guest screens"). A page's group includes the components, hooks and lib files
  only its pages import. `veridic modules` lists screen groups after the server
  modules, each with its `spec_path` (`specs/<group>-app/spec.md`, e.g.
  `specs/guest-app/spec.md`).
- **Linking, not repeating.** A screen rule that depends on a server rule says
  so in one line ("Server rules: specs/orders FR-016"). `prepare --module
  <screen group>` lists, for each API the screens call, the server spec rules
  that cite its handler, so the writer can link them.

### 4. `/veridic:specs` covers the app

The command becomes a loop over coverage:

1. **Plan** from `veridic coverage`: parts with no spec, riskiest first (money,
   high issues, size), then parts whose spec misses more than a fifth of their
   files, then files in no part.
2. **Ask** as today: show the plan and the coverage now, ask how many to do.
3. **Write**, one agent per part (at most four at a time). A part with a spec is
   extended, not duplicated; its agent gets the part's uncovered files from
   `veridic coverage --module <id>` and must cite them or say why not.
4. **Measure again** and report: coverage before and after, and what's left with
   reasons. Stop when nothing is left but skipped files and files an agent
   explained.

The spec skill (SKILL.md, commands/spec.md) gains one step: after cite and
claims are clean, run `veridic coverage --module <id>` and cite or explain each
uncovered file.

### 5. The dashboard shows coverage

The page stays specs only. It gains a third gauge, **Covered**: behaviour files
cited by a spec, of all behaviour files. Under "When you have time", one card:
"N files no spec describes", pointing at the part with the most. The data comes
from `collectReport`, which adds `coverage` (the same numbers `veridic coverage`
prints).

## Testing

- `core/coverage.mjs`: fixture repo with a cited file, an uncited file, a test,
  a generated file and a types-only file; covered share, skips with reasons, per
  part.
- Split: fixtures for a timer-only file, a WebSocket handler and a
  template-string route; each lands in a module.
- Screen groups: fixture router with public, staff-guarded and owner-guarded
  pages; three groups, each with only its own components.
- Report model: the Covered gauge and the one coverage card (test/report-page).
- `/veridic:specs`: the command text is checked by reading, as today.

## Measurement

Benchmark on a fresh copy of App A with its original 19 specs (run locally;
App A is private, so only the numbers are published): run `/veridic:specs` with the new Veridic and compare coverage with the
hand-directed result (289 of 388 behaviour files, 74%). Success: at least 74%,
every new spec clean under cite and claims, at no more than the hand-directed
run's cost. A second app, public and with a frontend (juice-shop, from the bench list),
checks it isn't fitted to App A.

## Out of scope

Specs for third-party SDK wrappers beyond what the app's own code calls; a gate
that fails CI below a coverage threshold (later, if wanted); changing what a
rule may cite.
