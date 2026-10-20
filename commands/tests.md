---
description: Turn a module's rules into tests Veridic counts (link existing tests, write the rest); or, given a spec, which requirements have real tests
argument-hint: "<module id> [more ids] [--yes] | <spec.md> [run | scaffold <test path>]"
allowed-tools: Bash(veridic:*), Agent, Read
---

Arguments: `$ARGUMENTS`.

## Module ids: turn the rules into tests

1. **Plan.** For each module, run `veridic tests --module <id>` and read it: its
   totals, its test recipe, and per rule the status, link candidates and test
   file. If a module has no spec of its own, say so and stop for that module
   (the output says where its rules are, or that `/veridic:specs <id>` writes
   them). If the recipe says a package has no test framework, its rules are
   tested from a package that has one, or left untested with that reason.
2. **Ask.** Show a short plan per module: rules to link (existing tests that
   may already check them), rules to write, riskiest first. Say that only test
   files change, and that one agent works per module. Wait for a yes, unless
   the arguments include `--yes` (an unattended run).
3. **Write.** For each module, run the `veridic-test-writer` agent with the
   module id, in the foreground, at most four at a time, and wait for every one
   to finish. A module with only links to make (nothing to write) needs no
   agent: read the candidates yourself and apply them with one
   `veridic tests --module <id> --link ID=file:line …`.
4. **Report.** Run `veridic tests --module <id> --run` for each module and show
   the totals line, before and after. List any rule now `broken`: the code
   breaks it today, proven by an expected-failure test. Those are bugs to fix,
   not tests to change.

## A spec file (`*.md`): which requirements have real tests

- Default: `veridic tests --spec <spec>`. Report tested % and list the untested requirements, most important first (security and money paths before cosmetics).
- `run`: `veridic tests --spec <spec> --run`. Report passing / failing per requirement; for a failing one, show the assertion that failed.
- `scaffold <test path>`: `veridic scaffold --spec <spec> --out <test path> --harness express` (add `--harness express` only for Express routes). Show the skeleton; write it with `--write` only if the user asks. Then offer to fill the highest-value placeholders, following the skill's section 5: each test named with its requirement id, and proven to fail when the guarded line changes.

A requirement counts as tested only when a test named with its id reaches the code it cites.
