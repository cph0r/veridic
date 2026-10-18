# Rules to tests

Status: in progress (see docs/specs/2026-10-18-rules-to-tests-design.md and docs/plans/2026-10-18-rules-to-tests.md).

Veridic turns a module's written rules into tests it counts. Each requirement below cites the code that implements it; until a requirement is built, it cites the existing code it extends. Every test proving one is named with its id.

## Requirements

### Test parsing and status

- **FR-001**: Test parsing MUST recognise expected-failure tests (`it.fails`, `test.fails`, `test.failing`) and mark them as expected failures. [evidence: core/tests.mjs:21, core/tests.mjs:202-232]
- **FR-002**: A rule whose only live named tests are expected-failure tests MUST have status `broken`; one normal named test that reaches the cited code and asserts MUST take precedence. [evidence: core/tests.mjs:377-470]
- **FR-003**: A test title written `FR-001 (orders): …` MUST count only for module `orders` when coverage is computed for a module. [evidence: core/tests.mjs:202-232]

### The test recipe

- **FR-004**: The recipe MUST name each package's test framework (vitest, jest, mocha, node:test, or none) and the command to run one test file from that package's folder. [evidence: core/tests.mjs:345-370]
- **FR-005**: The recipe MUST report where most of a package's tests live: next to the code, in `__tests__/`, or in a top-level test folder. [evidence: core/tests.mjs:319-327]
- **FR-006**: The recipe MUST list setup files from the framework config and shared helpers (files under testkit/, test-utils/, __mocks__/ or fixtures/ imported by two or more tests) with their leading comment. [evidence: core/tests.mjs:319-327]
- **FR-007**: The recipe MUST say whether tests call routes over HTTP or call functions directly, and for a cited file name an existing test to copy from. [evidence: core/tests.mjs:290-317]

### The work list

- **FR-008**: The work list MUST give each rule of a module's own spec one status of tested, broken, failing, weak or untested, ordered with rules on money or delete routes first, then invariants, then the rest. [evidence: core/tests.mjs:377-470, core/modulectx.mjs:20-24]
- **FR-009**: For each rule the work list MUST list link candidates: existing tests, not yet named for it, that reach its cited code and assert something. [evidence: core/tests.mjs:433-436]
- **FR-010**: A rule whose id also appears in another spec, with a test reaching both specs' cited code, MUST be marked ambiguous so its test title carries the module. [evidence: core/tests.mjs:377-470]
- **FR-014**: An unknown module MUST be reported with the list of module ids; a module with no spec of its own MUST be reported with the module that owns its rules or the command that writes one. [evidence: skill/scripts/prepare.mjs:23]

### Running and the command line

- **FR-011**: Coverage with `--run` MUST run node:test and jest test files as well as vitest ones and record pass or fail per named test. [evidence: core/tests.mjs:345-370]
- **FR-012**: A test runner that cannot start MUST be reported as could-not-run, never as failing rules. [evidence: core/tests.mjs:356-360]
- **FR-013**: `veridic tests --module <id>` MUST print the work list as Markdown with module totals and end with a line naming the next command. [evidence: skill/scripts/tests.mjs:12-27]
- **FR-015**: The report MUST show a broken rule as "broken, proven". [evidence: core/report-page.js:54]
