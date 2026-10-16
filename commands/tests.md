---
description: Which spec requirements have real tests; "scaffold" generates placeholders, "run" runs them
argument-hint: "<spec.md> [run | scaffold <test path>]"
allowed-tools: Bash(veridic:*)
---

Arguments: `$ARGUMENTS`. The first is the spec.

- Default: `veridic tests --spec <spec>`. Report tested % and list the untested requirements, most important first (security and money paths before cosmetics).
- `run`: `veridic tests --spec <spec> --run`. Report passing / failing per requirement; for a failing one, show the assertion that failed.
- `scaffold <test path>`: `veridic scaffold --spec <spec> --out <test path> --harness express` (add `--harness express` only for Express routes). Show the skeleton; write it with `--write` only if the user asks. Then offer to fill the highest-value placeholders, following the skill's section 5: each test named with its requirement id, and proven to fail when the guarded line changes.

A requirement counts as tested only when a test named with its id reaches the code it cites.
