---
description: Write a spec for every module that has none, riskiest first, one agent per module (asks before starting)
argument-hint: "[module id …]"
allowed-tools: Bash(veridic:*), Agent, Read
---

Write specs for the modules of this app: $ARGUMENTS

Veridic has already split the app into modules. Use its split, never your own.

1. **Plan.** Run `veridic modules`. The modules to do are the ones named in the
   arguments, or else every module whose `specs` list is empty. Order them by
   risk: `moves_money` first, then `issues.high`, then `issues.medium`, then the
   number of routes. If none are left, say every module has a spec, show
   `veridic modules --md`, and stop.
2. **Ask.** Show the plan as a short table (module, routes, why it is where it
   is in the order) and say that each module is one agent writing one spec,
   that this uses Claude Code usage, and that nothing in the app's code changes.
   Unless the user named the modules, ask how many to do now (suggest the first
   four, or all of them if there are four or fewer) and wait for the answer.
3. **Write, one agent per module,** at most four at a time. Run the agents in
   the foreground, never in the background, and wait until every one has
   replied before going on: the specs are only done when the agents are. Give
   each agent this, with the module filled in:

   > Write the spec for the `<id>` module of this repo, following the veridic
   > skill's sequence for writing a spec. Gather once:
   > `veridic prepare --module <id> --out .veridic/context/<id>.md`, then read
   > that file in full. Write the spec at `<spec_path>`, each requirement a
   > list item labelled `**FR-001**:` (invariants `**INV-1**:`) ending in its
   > `[evidence: path:line-line]` citations (if a spec already
   > covers this module, extend it instead of writing a second one). Verify
   > with `veridic cite` and `veridic claims` until both are clean, then write
   > `traceability.md` with `veridic tests --spec <spec_path> --table`. The
   > module's open findings are risks or open questions, never MUST
   > requirements; an invariant they break is recorded with `holds: no`.
   > Don't change any of the app's code. Reply with the spec's path, its number
   > of requirements, its citations resolving out of total, and the risks you
   > recorded.

4. **Report.** Run `veridic modules --md` and show it. Then list the specs a
   person should read before trusting them: modules that move money, have high
   issues, or handle sign-in and roles. These specs were recovered from the code
   as it is, so someone has to confirm that each MUST is what the app should do.
   Finish with: `veridic report` shows them all.
