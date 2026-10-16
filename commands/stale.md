---
description: Which spec requirements the current code changes affect; "fix" updates citations that only moved
argument-hint: "<spec.md> [fix]"
allowed-tools: Bash(veridic:*), Bash(codegraph sync:*)
---

Arguments: `$ARGUMENTS`. The first is the spec; if the word `fix` follows, update citations that only moved.

1. If the repo has a `.codegraph/` directory, run `codegraph sync .` so anchored citations are checked against current code.
2. Run `veridic stale --spec <spec>` (add `--fix` if asked).
3. Report: requirements whose cited code changed (`stale` / `open`), citations updated or to update, and any `conflicts`.
4. For each changed requirement, read the new code at `now` and propose the updated requirement text and citation. Apply it only if the user asks.
