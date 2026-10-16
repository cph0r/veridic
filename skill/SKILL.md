---
name: veridic
description: Write or update an evidence-backed spec for existing code, and keep it honest. Use when asked to "spec this feature", "recover a spec", "document how X works" for a brownfield codebase, to check a spec's citations, to compare an OpenAPI contract with the code, or to find which requirements a change made stale. Every requirement cites file:line evidence that scripts verify.
---

# veridic

You read and reason; the `veridic` commands return facts and locations. They
are read-only on the target repo, print compact JSON, and exit 0 (ok), 1
(problems found) or 2 (usage error). Run them from inside the repo (`--repo`
defaults to it; `veridic help` lists them). Without the plugin they are
`node scripts/<command>.mjs --repo R …` next to this file.

If `R/.codegraph` is missing, ask the user to run `codegraph init`; don't run it
yourself. Never write into the target repo. Write the spec where the user points.

## Writing a spec: the sequence

Every tool call re-reads the whole conversation, so the cost of a run is mostly
its number of turns. Follow this order and don't repeat steps.

1. **Gather.** If the prompt already contains a "Feature context" document, use
   it and skip to step 3. Otherwise, once:
   ```bash
   veridic routes order payment                      # pick the feature's entry routes
   veridic prepare --out <folder>/context.md "POST /api/orders" "GET /api/orders/:id" …
   ```
   then read `context.md` in full. It holds the scope (routes, webhooks, timers,
   callers, tables), the contract comparison, and every relevant code range,
   numbered. Read all of it: handlers *and* services, webhooks, timers. The bugs worth finding live in
   the code a route list doesn't show. Open other files only for what the
   bundle doesn't show (a type, a test, a config value).
2. **Contract**: `context.md` already compares the OpenAPI file (if any) with
   the code. Add only what you confirm by reading (codes set in helpers aren't
   scanned). Field meanings: `references/drift.md`.
3. **Write `spec.md` once**, complete, in one Write (rules below). Don't build it
   up with many small edits.
4. **Verify once:** `veridic cite --spec spec.md` then
   `veridic claims --spec spec.md`. Both list only problems. A claims fact
   marked `elsewhere_in_file` (with `at`) means the citation is off or misses
   the line holding that fact. To re-read a requirement's cited code:
   `veridic cite --spec spec.md --fr FR-007,FR-012`.
5. **Fix** all problems in as few edits as possible, then run step 4 once more.
   Stop when both exit 0.
6. **Traceability:** `veridic tests --spec spec.md --table > traceability.md`.
   Read each `related` test it lists and change that row to `covered` only if
   the test asserts that requirement's behavior.

Don't run `metrics`, `anchor`, `mutate` or `stale` while writing a spec; they
are for maintenance (`references/maintenance.md`).

## Spec rules (Spec Kit format)

Sections: User Scenarios & Testing (with acceptance scenarios), Edge Cases,
Functional Requirements, Key Entities, Success Criteria, Assumptions, Open
Questions & Observed Risks.

- Requirements describe behavior, not implementation: "MUST reject a quantity
  outside 1–20", not "checks `item.quantity < 1`".
- **Every FR ends with `[evidence: path:line]` or `[evidence: path:start-end]`.**
  Several citations are comma-separated. No citation, no requirement. Cite the
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
requirement tests: `references/tests.md`.
