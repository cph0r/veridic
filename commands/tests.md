---
description: Turn a part's rules into tests Veridic counts (link existing tests, write the rest); or, given a spec, which rules have real tests
argument-hint: "[--link-only] <part id> [more ids] [--yes] | <spec.md> [run | scaffold <test path>]"
allowed-tools: Bash(veridic:*), Agent, Read
---

Arguments: `$ARGUMENTS`.

## Part ids: turn the rules into tests

Any part `veridic parts` lists works: a server part (`orders`) or a group of screens (`guest-app`).

**`--link-only`:** prove rules with the tests the app already has, and write
none. With no part ids, do every part `veridic parts` lists whose work list has
link candidates. Steps are the same, except that the plan lists only rules to
link, each agent is told "link only: steps 1, 2 and 5", and a part whose rules
have no candidates is skipped.

1. **Plan.** For each part, run `veridic tests --module <id>` and read it: its
   totals, its test recipe, and per rule the status, link candidates and test
   file. If a part has no spec of its own, say so and stop for that part
   (the output says where its rules are, or that `/veridic:specs <id>` writes
   them). If the recipe says a package has no test framework, its rules are
   tested from a package that has one, or left untested with that reason.
2. **Ask.** Show a short plan per part: rules to link (existing tests that
   may already check them), rules to write, riskiest first. Say that only test
   files change (with `--link-only`, only test titles), and that one agent
   works per part. Wait for a yes, unless
   the arguments include `--yes` (an unattended run).
3. **Write.** For each part, run the `veridic-test-writer` agent with the
   part id, in the foreground, at most four at a time, and wait for every one
   to finish (with `--link-only`, tell it: link only, steps 1, 2 and 5). A
   part with only a few links to make (nothing to write) needs no agent: read
   the candidates yourself, judge them as the agent's step 2 says, and apply
   them with one `veridic tests --module <id> --link ID=file:line …`.
4. **Report.** Run `veridic tests --module <id> --run` for each part and show
   the totals line, before and after. List any rule now `broken`: the code
   breaks it today, proven by an expected-failure test. Those are bugs to fix,
   not tests to change. If the run says "Could not run", show that line: a
   runner that can't start (missing packages) is the project's to fix, and tests
   that need an environment variable (a database flag like `DB_TESTS=1`) get it
   from `.veridic.json`: `{ "testEnv": { "DB_TESTS": "1" } }`.

## A spec file (`*.md`): which rules have real tests

- Default: `veridic tests --spec <spec>`. Report tested % and list the untested rules, most important first (security and money paths before cosmetics).
- `run`: `veridic tests --spec <spec> --run`. Report passing / failing per rule; for a failing one, show the assertion that failed.
- `scaffold <test path>`: `veridic scaffold --spec <spec> --out <test path> --harness express` (add `--harness express` only for Express routes). Show the skeleton; write it with `--write` only if the user asks. Then offer to fill the highest-value placeholders, following the skill's section 5: each test named with its rule id, and proven to fail when the guarded line changes.

A rule counts as tested only when a test named with its id reaches the code it cites.
