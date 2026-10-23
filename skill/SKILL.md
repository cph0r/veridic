---
name: veridic
description: Facts and checks for changing existing code safely. Use before changing a feature in an existing codebase (get every route, webhook, timer and table involved, with line numbers), after changing it (`veridic done`: did the change stay in scope, and does every rule have a test that really asserts), when writing, updating or checking a spec ("spec this feature", "document how X works"), when code changes may have made a spec stale, and when asked whether an API is safe to expose to AI agents. Every fact cites file:line and is verified by scripts, not a model.
---

# veridic

You read and reason; the `veridic` commands return facts and locations. They
are read-only on the target repo, print compact JSON, and exit 0 (ok), 1
(problems found) or 2 (usage error). Run them from inside the repo (`--repo`
defaults to it; `veridic help` lists them). Without the plugin they are
`node scripts/<command>.mjs --repo R …` next to this file.

If `R/.codegraph` is missing, ask the user to run `veridic init` (it builds the
code index); don't run it yourself. Commands keep an existing index up to date
on their own. Never write into the target repo. Write the spec where the user points.

## Changing existing code

Every change, with or without a spec, follows three steps:

1. **Claim before you edit.** `veridic claim "<METHOD /path>" [file …]` records
   what this task will change and prints its impact: every route that runs that
   code, what each one really does (money and deletes first), and which tests
   cover it. Not sure what a file touches? `veridic impact <file | file:12-40>`.
   For a whole feature's code, `veridic prepare "<METHOD /path>" …` (find routes
   with `veridic routes <word>`).
2. **Edit.** Stay inside the claim. If the work needs more, claim it again.
3. **Check before you say done.** `veridic done --card` (it uses the claim). It is
   DONE only when every changed line is in the code the claimed routes run, and
   every changed route has an asserting test that names it or the changed
   function. A *stray* is a change outside the claim: undo it, or claim it if it
   belongs. *Untested* means add a test that asserts what that route does. Don't
   say you're finished until it prints `VERDICT ● DONE`.

If the repo has a spec, use the spec form below instead (`done --spec`).

## Writing a spec: the sequence

Every tool call re-reads the whole conversation, so the cost of a run is mostly
its number of turns. Follow this order and don't repeat steps.

1. **Gather.** If the prompt already contains a "Feature context" document, use
   it and skip to step 3. **For a part, or a spec per part:** Veridic has
   already split the app. `veridic modules` lists them (with each one's
   `spec_path`); `veridic prepare --module <id> --out .veridic/context/<id>.md`
   gathers one, with what each route really does, its tables, screens, tests,
   existing rules and open findings. A frontend's screens are groups in the same
   list (`guest-app`, `admin-app`, …): `prepare --module <part>` gives their pages, files
   and the server rules their calls depend on; a screen rule links a server rule
   in one line (`Server rules: specs/orders FR-016`) instead of restating it.
   Use that split, write to the part's
   `spec_path`: a part has one spec, so extend it when it exists and never
   start a second spec file for that part. Put open findings
   under risks or open questions, never as MUST rules. Otherwise, once:
   ```bash
   veridic routes order payment                      # pick the feature's entry routes
   veridic prepare --out .veridic/context/orders.md "POST /api/orders" "GET /api/orders/:id" …
   ```
   then read that file in full. It holds the scope (routes, webhooks, timers,
   callers, tables), the contract comparison, and every relevant code range,
   numbered. Read all of it: handlers *and* services, webhooks, timers. The bugs worth finding live in
   the code a route list doesn't show. Open other files only for what the
   bundle doesn't show (a type, a test, a config value).
2. **Contract**: the context file already compares the OpenAPI file (if any) with
   the code. Add only what you confirm by reading (codes set in helpers aren't
   scanned). Field meanings: `references/drift.md`.
3. **Write `spec.md` once**, complete, in one Write (rules below). Don't build it
   up with many small edits.
4. **Verify once:** `veridic cite --spec spec.md` then
   `veridic claims --spec spec.md`. Both list only problems. A claims fact
   marked `elsewhere_in_file` (with `at`) means the citation is off or misses
   the line holding that fact. To re-read a rule's cited code:
   `veridic cite --spec spec.md --fr FR-007,FR-012`.
5. **Fix** all problems in as few edits as possible, then run step 4 once more.
   Stop when both exit 0.
   For a part, then run `veridic coverage --module <id>`: cite
   each file it lists in a rule, or say in Assumptions why it needs none.
6. **Traceability:** `veridic tests --spec spec.md --table > traceability.md`.
   Read each `related` test it lists and change that row to `covered` only if
   the test asserts that rule's behavior.

Don't run `metrics`, `anchor`, `mutate` or `stale` while writing a spec; they
are for maintenance (`references/maintenance.md`).

## Turning rules into tests

A rule counts as tested only when a passing test named with its id reaches the
code it cites. For a part, `veridic tests --module <id>` lists every rule's
status, the tests that may already check it, the test file to use, the cited
code of rules still to do, and the repo's test recipe (framework, run command,
helpers, an example test). Link the tests that really check a rule in one call:
`veridic tests --module <id> --link FR-002=src/a.test.ts:12,40 INV-1=…` puts
the id in each title, nothing else (where two of the part's spec files share an
id, name the file: `FR-002@orders-payment=…`). Link a test only if it checks what
the rule states, not just runs its code. `/veridic:tests <id>` does the whole job with the
`veridic-test-writer` agent; `/veridic:tests --link-only` only links existing tests. A rule the code breaks today gets an
expected-failure test (`it.fails`, `test.failing`): it shows as broken, proven.

## Implementing a rule: is it done?

After changing code for rules, run `veridic done --spec S FR-002 [FR-003 …] --card`
(add `--run` to run their tests). It is done only when every changed file is in
the seam of what you claimed (the files those rules cite or declare with
`seam`, plus their named tests) and every verification criterion has an
asserting test. A stray file means you changed something no claimed rule
covers: claim the rule it belongs to, add it to a seam in spec.json, or
undo it. Don't say "done" until this prints `VERDICT ● DONE`.

## Why the code is the way it is

`veridic why --spec S FR-002` lists the commits that wrote a rule's cited
lines, with their messages. Record a real reason as a decision in spec.json
(`references/spec-json.md`), citing the lines and the commit. Decisions are
append-only: never edit one, add a new one that `supersedes` it.

## Spec rules (Spec Kit format)

Sections: User Scenarios & Testing (with acceptance scenarios), Edge Cases,
Functional Requirements, Key Entities, Success Criteria, Assumptions, Open
Questions & Observed Risks.

- Requirements describe behavior, not implementation: "MUST reject a quantity
  outside 1–20", not "checks `item.quantity < 1`".
- **Every FR ends with `[evidence: path:line]` or `[evidence: path:start-end]`.**
  Several citations are comma-separated. No citation, no rule. Cite the
  narrowest range that shows the behavior, not the whole handler.
- Acceptance scenarios come from real branches (each 4xx/409 is a candidate).
- Mark what the code can't tell you with `[NEEDS CLARIFICATION: …]`: intent
  behind magic numbers, whether a behavior is deliberate, rules enforced
  elsewhere.
- No invented metrics. Success criteria state only what the code enforces.

## Find risks by reading flows across files

Risks are review prompts with evidence, not confirmed bugs. Look for:

- **Timing windows**: timers and timeouts that race each other or an external
  system (an auto-cancel shorter than the gateway's checkout window).
- **State machines**: every writer of a status column, and whether each
  transition checks the current state (`where status = …`).
- **Idempotency**: retries and re-initiation, replayed webhooks, in-memory
  dedup that does not survive restarts or multiple instances.
- **Ownership and authorization on id-addressed routes**: can someone act on
  an id that is not theirs? Is a paid feature enforced on the server?
  `veridic access <words>` lists who can call each route, whether a plan
  check runs on the server, and whether data is limited to the caller (`yes`,
  `weak` = only client-supplied ids, `no`); `--intended <csv>` compares it with
  the intended policy. `veridic agent-ready <words>` adds each route's real
  effect (GETs that write, money moved on ids the caller doesn't own).
- **Transactions**: multi-statement writes that can half-succeed.
- **Divergent paths**: `callers` that create or mutate the same entity with
  different rules.

Give each risk a severity (high/medium/low) and evidence.

## Test status, strictly

In the traceability table, `covered` only if a test **asserts** that FR's
behavior; `related` if a test only imports or calls the code (a hash-function
test does not cover the 409 duplicate path); `untested` otherwise. To write
rule tests: `references/tests.md`.
