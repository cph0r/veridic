# Rules to tests: design

Date: 2026-10-18. Status: draft for review.

## Goal

Make a module's written rules enforceable. For a module, every rule in its own
spec ends with a passing test that Veridic counts (named with the rule's id,
reaching the cited code, asserting something), or with an expected-failure test
that proves the code currently breaks the rule. Claude writes the tests;
Veridic gathers what Claude needs before and verifies the result after.

Success is measured, not assumed (see Measurement): on public apps with specs,
the share of rules with a counted test rises sharply, the tests would catch a
real break (mutation sample), and the work list makes Claude cheaper and more
reliable than the same task without it.

Out of scope here (separate designs): `done` checking rules, fixing
out-of-date rules, one-spec-per-module enforcement, `veridic next`, session
hooks.

## Decisions taken in review

- Tests follow the repo: unit tests with the repo's mocks where its tests are
  unit tests, HTTP tests where it already has an HTTP test setup. Veridic adds
  no test infrastructure.
- An existing test that already checks a rule is linked by adding the rule id
  to its title, e.g. `it("FR-007: rejects a checkout for a paid order")`.
- A test for a rule the code currently breaks uses the framework's
  expected-failure marker (`it.fails` in Vitest, `test.failing` in Jest), so CI
  stays green and the rule shows as "broken, proven".
- Only test files change. The app's code is never edited by this workflow.

## 1. The work list: `veridic tests --module <id>`

A new mode of `veridic tests`. Deterministic. Compact Markdown by default
(`--json` for the data), ending with the next commands to run.

Per rule of the module's own spec(s) (specs whose folder is the module, or
otherwise the module that claims them; see report.mjs `specOwner`):

- status: `tested` (a passing test named with the id reaches the cited code),
  `broken` (an expected-failure test named for it), `failing` (a named test
  fails and isn't marked), `weak` (a named test checks nothing real),
  `untested`. Without `--run`, `tested` reads `covered` as today.
- the rule text, its verification criteria (`VC1…`), its cited `file:line`s.
- link candidates: existing tests that reach the cited code and assert
  something (strong or weak), with title and location; the agent reads each and
  links only those that check the rule.
- where a new test goes: an existing test file for the cited file if any,
  else the package's convention (Section 2).
- order: rules on routes that move money or delete data first, then
  invariants, then the rest.
- ambiguity: when a test matching the id would reach code cited by the same id
  in another spec, the entry says so and the title must carry the module,
  `FR-001 (orders): …`, which test matching accepts.

Totals per module: rules, tested, broken, failing, weak, untested.

## 2. The repo's test recipe

Part of the same output, computed per package (the nearest package.json above
the cited files):

- framework (vitest, jest, mocha, node:test) from dependencies and config
  files; the command to run one file from the package folder
  (`npx vitest run <file>`, `npx jest <file>`, …).
- layout: co-located `*.test.*`, `__tests__/`, or a top-level `test/`,
  whichever most of the package's tests use.
- setup: setup files named in the framework config; shared helpers, i.e. files
  under `testkit/`, `test-utils/`, `__mocks__/`, `fixtures/` imported by two or
  more tests, with their header comment (usage notes).
- style: HTTP (imports supertest or calls `request(app)`) or direct calls.
- example per cited file: a test that already imports it, else one in the same
  folder.
- expected-failure marker: `it.fails` (vitest), `test.failing` (jest). Mocha
  and node:test have none: a broken rule's test is skipped with `[broken]` in
  its title and counts as `broken, not proven`.
- When the framework can't be determined, the output says so and the agent
  stops for that package rather than guessing.

## 3. The command and the test-writer agent

- `/veridic:tests <module> [more modules]`: runs `veridic tests --module <id>`,
  shows the plan (rules to link, rules to write, riskiest first), asks before
  starting, then hands each module to the test-writer agent (foreground, up to
  four at a time), then shows the new totals.
- `agents/veridic-test-writer.md` (plugin agent): one job, one module. Steps:
  read the work list; link candidates that genuinely check a rule (title edit
  only); write missing tests in the recipe's style; run each test file with the
  recipe's command; a test that fails because the code breaks the rule becomes
  an expected-failure test with a one-line reason; finish with
  `veridic tests --module <id> --run` and report the totals. Tools: Read,
  Write, Edit, Glob, Grep, Bash(veridic:*), Bash for the recipe's test command.
  Never edits non-test files.
- Next-step lines: the work list, `veridic tests` and `veridic modules` end
  with one or two commands that move the work on (e.g. "4 untested → run
  /veridic:tests orders").

## 4. Verification in Veridic

- Test parsing learns `it.fails`, `test.fails`, `test.failing` (today only
  `todo|skip|only|concurrent` are read), and counts them as `broken` for the
  rule named.
- `--run` already runs Vitest; extend to Jest (`--json` reporter) so `tested`
  and `failing` are real results there too. Mocha and node:test stay `covered`
  (not run) in this design.
- Optional `--mutate N`: for N sampled rules marked `tested`, run the existing
  mutation check and report how many tests caught the change.
- The report and module pages show `broken` rules as "broken, proven" next to
  the rule.

## Measurement

`veridic-bench/tests-e2e.mjs`, like `specs-e2e.mjs`: fresh copies of public
apps that have tests (proshop-v2 has none, so: realworld, node-express-boilerplate,
hackathon-starter), specs written first with `/veridic:specs` for two
modules, then:

- Arm B (this design): `/veridic:tests <modules>` unattended.
- Arm A (baseline): the same modules, a plain prompt "write tests for every rule
  in specs/<id>/spec.md; name each test with its rule id", no work list, no agent.

Scored per module with Veridic: rules with a counted test (tested + broken) /
rules; tests passing; mutation catch rate on a sample of 5 rules; non-test
files changed (must be 0); cost, minutes, turns. B passes if it beats A on
counted rules and catch rate at no more than A's cost, with zero non-test edits.
Each implementation step reports its own check (unit tests in veridic's suite)
before the e2e run.

## Error handling

- Module unknown: list module ids (as `prepare --module` does).
- Module without a spec: say so and point at `/veridic:specs <id>`.
- Package with no test framework: reported per package; its rules stay
  untested with that reason.
- Test run fails to start (missing deps): reported as `could not run`, not as
  failing rules.

## Testing Veridic itself

Unit tests in `test/generalize.test.mjs` with small fixture repos: work-list
statuses and ordering; recipe detection for a vitest package with a testkit
helper and a jest package; `it.fails`/`test.failing` parsing; title matching
with a module qualifier; no-framework reporting.
