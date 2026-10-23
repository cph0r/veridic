---
description: Which spec rules the current code changes affect; "fix" updates citations that only moved
argument-hint: "<spec.md> [fix]"
allowed-tools: Bash(veridic:*), Bash(codegraph sync:*)
---

Arguments: `$ARGUMENTS`. The first is the spec; if the word `fix` follows, update citations that only moved.

1. If the repo has a `.codegraph/` directory, run `codegraph sync .` so anchored citations are checked against current code.
2. Run `veridic stale --spec <spec>` (add `--fix` if asked).
   A citation with a hash (`a.ts:10-20~3f9a1c`) is judged by its text: out of date only when the cited lines changed, moved when the same lines are elsewhere. A spec that isn't committed yet is never compared with the last commit. For a spec whose citations have no hash, offer `veridic stale --spec <spec> --stamp` (after `veridic check` passes) so it's judged by its text from then on.
3. Report: rules whose cited code changed (`stale` / `open`), citations updated or to update, and any `conflicts`.
4. For each changed rule, read the new code at `now` and propose the updated rule text and citation. Apply it only if the user asks.
