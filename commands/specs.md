---
description: Write specs until the whole app is covered: parts with no spec, specs that miss their files, then code in no part; one agent per part, riskiest first (asks before starting)
argument-hint: "[part id …]"
allowed-tools: Bash(veridic:*), Agent, Read
---

Write specs for this app until its behaviour is covered: $ARGUMENTS

Veridic has already split the app into parts: server parts and, for a
frontend, its screens grouped by who uses them (`guest-app`, `admin-app`, …). Use its split, never your own.
`veridic coverage` measures how much of the app the specs describe.

1. **Plan.** Run `veridic coverage` and `veridic modules`. The parts to do are
   the ones named in the arguments, or else, in this order:
   1. parts whose `part_specs` list is empty, riskiest first: `moves_money`, then
      `issues.high`, then `issues.medium`, then size (routes, or pages);
   2. parts with a spec that misses more than a fifth of their files
      (`parts[].uncovered` against `total` in `veridic coverage`);
   3. folders of code in no part (`orphanFolders`), one part each, named after
      the folder, its spec at `specs/<folder>/spec.md`.

   If none are left, say the app is covered, show `veridic coverage --md`, and
   stop.
2. **Ask.** Show the plan as a short table (part, kind, why it is where it is,
   files not described yet) and the coverage now ("Covered: N%"). Say that each
   part is one agent writing or extending one spec, that this uses Claude Code
   usage, and that nothing in the app's code changes. Say too that afterwards
   the tests the app already has are linked to the new rules they really
   prove: only test titles change, and no new tests are written. Unless the user named the
   parts, ask how many to do now (suggest the first four, or all of them if
   there are four or fewer) and wait for the answer.
3. **The product spec first.** Unless `specs/product/spec.md` exists and the
   user named only parts, write it yourself before the parts: `# Product: <app>`,
   one sentence on what the app does (from the README), then `## Journeys`: the
   main things a person does across parts (`### J-001: Ask for an app`, then
   numbered steps in plain words), and `## Guarantees`: promises that span parts
   (`- **G-001**: Data stays on the phone: what a person saves never reaches the server`: a short title, a colon, then the promise). Read the
   README, `veridic routes` and `veridic modules` for this; no code citations.
   Leave the steps' and guarantees' rule references for step 5.
4. **Write, one agent per part,** at most four at a time. Never give two agents
   the same spec at once: parts that write or extend the same spec file go to
   one agent, together. Run the agents in
   the foreground, never in the background, and wait until every one has
   replied before going on: the specs are only done when the agents are. Give
   each agent this, with the part filled in:

   > Write the spec for the `<id>` part of this repo, following the veridic
   > skill's sequence for writing a spec. Gather once:
   > `veridic prepare --module <id> --out .veridic/context/<id>.md`, then read
   > that file in full (for a folder in no part, read its files instead). Write
   > the spec at `<spec_path>`, each rule a list item labelled
   > `**FR-001**:` (invariants `**INV-1**:`) ending in its
   > `[evidence: path:line-line]` citations, and each story headed
   > `### User Story 1 - Title (Priority: P1)`. If a spec already covers this
   > part, extend it instead of writing a second one. For screens, run
   > `veridic screens --group <id> --md` first (each page's URL, the routes it
   > calls, its form fields, the design tokens) and describe
   > what someone using them sees and can do, each screen's states (loading,
   > empty, error, success), and link a server rule in one
   > line (`Server rules: specs/orders FR-016`) instead of restating it. Verify
   > with `veridic cite` and `veridic claims` until both are clean. Then run
   > `veridic coverage --module <id>`: cite each file it lists in a rule, or
   > say in Assumptions why it needs none. Write `traceability.md` with
   > `veridic tests --spec <spec_path> --table`. Open findings are risks or
   > open questions, never MUST rules; an invariant they break is
   > recorded with `holds: no`. Don't change any of the app's code. Reply with
   > the spec's path, its number of rules, its citations resolving out
   > of total, the files you left uncited and why, and the risks you recorded.

5. **Tie the product spec to the parts.** End each journey step with the part
   rules that make it work, `(apps:FR-003, auth:FR-001)` (spec folder, colon,
   rule id), and each guarantee with `[rules: apps:FR-003, apps-host:FR-002]`.
   Run `veridic check --spec specs/product/spec.md` until it's clean. A step or
   guarantee no rule makes true is a gap: say so in the report.
6. **The environment spec.** Run `veridic environment --write`: it writes
   `specs/environment/spec.md` from the code (env vars and whether startup needs
   them, services, schedules, deployment; names only, never values). Read it,
   and add a line under any service whose purpose the code doesn't make clear.
7. **Measure again.** Run `veridic coverage` and report coverage before and
   after, and what's left: each part or folder still not described, with the
   reason its agent gave. If parts from step 1 remain and the user agreed to
   all of them, continue with the next four; else stop, and say which are left.
8. **Link the tests you already have.** For each part a spec was written or
   extended for, run `veridic tests --module <id>`. For the parts with link
   candidates, run the `veridic-test-writer` agent with the part id and "link
   only: steps 1, 2 and 5", at most four at a time, in the foreground, and
   wait for every one. Report rules proven before and after, per part. The
   yes from step 2 covers this; skip it if the user said not to touch tests.
9. **Report.** Show `veridic modules --md`. Then list the specs a person
   should read before trusting them: parts that move money, have high issues,
   or handle sign-in and roles. These specs were recovered from the code as it
   is, so someone has to confirm that each MUST is what the app should do.
   Finish with: `veridic report` shows them all.
