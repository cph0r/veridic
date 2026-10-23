# Veridic 0.12: what cloudcrane-launchpad taught us

**Status:** draft, for review · **Date:** 2026-10-24 · **Source:** the report from the Claude
agent that ran Veridic 0.10.0 on cloudcrane-launchpad (11 specs, ~400 rules, 753 tests).

## Goal

Make Veridic's numbers trustworthy on a real, actively edited app: a rule is "out of date"
only when its cited code changed, a test that runs the code counts, every story and rule the
spec agents write is read, and the specs say what the product does end to end, not only per
part.

**Success:** on a frozen copy of launchpad, after re-running `/veridic:specs`' new product step
and `veridic check`:
- no rule is out of date while its cited lines are unchanged (today: any uncommitted edit to a
  cited file flags every rule citing it);
- `stale --fix` never moves a correct citation in an uncommitted spec;
- every spec's stories show on the dashboard (today: 9 of 11 show none);
- success criteria aren't counted as untested rules;
- the tests the agent had to "fix" by adding imports count as reaching their code without them;
- a product spec sits above the parts table.

## Constraints

- Express output stays byte-identical except where an item below changes it on purpose; each such
  change is listed in its item, tested, and shown on the snapshots (RealWorld, Gobbles, launchpad).
- Launchpad is read only, from a frozen rsync copy; another agent is working in it.
- Old specs keep working: every new format is accepted alongside the old one, and nothing
  rewrites a spec without `--fix` or an explicit command.
- Private apps (launchpad, Gobbles) never appear in committed fixtures, docs or the benchmark;
  tests use small synthetic repos.

## Workstreams, in build order

### A. Quick fixes (items 2, 10, 12, 13)

- **Stories (2).** `specDoc` accepts `### User Story N - Title (Priority: P1)` and the variants the
  agents write: `### Story N: Title (P1)`, `### US-N: Title [P2]`, `### Story N - Title`, priority
  in `()` or `[]`, with or without "Priority:". `veridic check` warns, per spec, about `###`
  headings that start with "Story"/"User Story"/"US" but don't parse.
- **Success criteria (12).** `SC-…` ids are criteria, not rules: left out of rule counts, proven
  and untested totals; shown on the spec page as their own list ("Success criteria: 4").
- **Qualified ids (10).** `--link` always writes the qualified title, `FR-012 (server): …`, for
  an id that more than one spec uses; a test already named with the bare id is re-titled to the
  qualified form instead of refused ("already named"). A bare id that's ambiguous is counted for
  no spec and listed by `check` as ambiguous (today: silently dropped).
- **`init --card` (13).** Accepted, or the README line corrected; whichever matches the code.

### B. Citations compared by their text, not by a commit (items 5, 6)

A citation records what it pointed at: `path:10-20#name@10~3f9a1c`, where `~3f9a1c` is the first
6 hex of a SHA-256 of the cited lines with surrounding whitespace trimmed per line.
- `veridic cite` and the spec agents write the hash; `veridic stale --stamp` adds hashes to a
  spec's existing citations (after `check` says they resolve), so old specs can opt in.
- **Fresh** when the cited lines in the working tree hash the same, whatever git says.
- **Moved** when they don't, but the same hash is found in the file (or the file it was renamed
  to, by git) at other lines: `--fix` rewrites the line numbers; nothing else does.
- **Out of date** when the text is nowhere: the rule needs a human (or the agent) to re-read it.
- Citations without a hash keep today's behaviour, but the default range for an untracked or
  modified spec is the working tree, never `HEAD`, so `--fix` can't shift a citation written
  against uncommitted code.
- The dashboard's "out of date" uses the same check, so editing an unrelated line of a cited
  file no longer flags its rules.
This also closes the `veridic stale` false-positive bug left open in 0.10.

### C. Product spec (item 1)

A spec for the whole app, `specs/product/spec.md` (same format as a part's spec):
- **Journeys:** the main things a person does across parts ("connect an assistant, ask for an
  app, install it, change it by asking"), each step naming the part rule that makes it work:
  `(apps: FR-003)`.
- **Guarantees:** promises that span parts ("a person's app data never reaches the server"),
  each listing the part rules that together make it true.
- Rules here cite part rules, not code; a guarantee is proven when all its part rules are, out of
  date when any is. Veridic checks every reference resolves (`check`).
- `/veridic:specs` writes it first, from the README, the routes and the parts, then the parts.
  `/veridic:spec product` writes or refreshes it alone.
- The dashboard shows it above the parts table: the README summary, then journeys and guarantees,
  each with its state.

### D. Tests that run the code count (item 4)

`reaches_cited_code` today follows only static imports from the test file. Add, in order:
1. tsconfig/jsconfig `paths` (`@/…`) and workspace packages (`@workspace/db` → the package's
   folder by its package.json `name`) in import resolution.
2. HTTP: a test that calls a route (`fetch`/supertest/an MCP client on `"/api/apps/mcp"`) reaches
   that route's handler and what it calls, using the route inventory.
3. A child process: `spawn`/`execFile` of a repo script reaches that script.
4. With `--run`, V8 coverage (`NODE_V8_COVERAGE`, which vitest and jest both honour): a test
   reaches the cited lines when they ran during it. When coverage is available it decides;
   static reach is the fallback. Coverage is per file of tests, not per test; a test counts
   only if its file's run covered the lines (documented as such).
5. A test skipped unless an env flag is set shows as "skipped (needs X)", not weak.

### E. Contract statuses through thrown errors (item 8)

Follow statuses thrown from helpers the handler calls (`findApp`, `requireOwner`), through the
app's error handler: an error class or factory carrying a status (`new HttpError(404)`,
`createError(403)`, `throw notFound()`) counts as a status the route returns. Fixture from the
pattern launchpad uses, written as a synthetic repo.

### F. Parts (item 3)

- An Express route whose handler is built in a loop or a factory, and an MCP endpoint
  (`/mcp` with an MCP server SDK), become parts.
- Middleware that routes by Host header (subdomain apps) is a part.
- A part is named after its folder (`oauth`), and a collision gets the folder path
  (`auth/oauth`), never "<name> 2".
Renaming changes part ids on existing repos: `veridic check` maps an old id in a spec's front
matter to its new id and says so, so no spec is orphaned.

### G. Specs that aren't parts, and traceability (items 9, 11)

- `tests --spec <path>` supports `--link` and `--run` like `--module`; `--module X --run` runs.
- `traceability.md` is regenerated by `veridic tests --link` from what is linked; hand-reviewed
  rows the agent adds are kept in a separate "Reviewed by hand" table, counted apart.

## Testing

Each item test-first on a synthetic repo. Then on the frozen launchpad copy: `check`, `report`,
`stale`, `tests --run`, before and after, with every change in a number explained. Express
snapshots and metrics compared with main after each workstream.

## Out of scope

Per-test (not per-file) runtime coverage; part detection for frameworks other than Express and
Next.js; rewriting existing specs to the new story or citation formats (opt-in commands only).
