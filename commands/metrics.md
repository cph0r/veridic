---
description: Every veridic number for this repo's specs in one call
argument-hint: "[spec.md ...]"
allowed-tools: Bash(veridic:*)
---

Run this and show its output to the user exactly as printed (one card per spec: a measured line per check, a verdict, and what to fix first):

```bash
veridic metrics --card $ARGUMENTS
```

For a table across many specs instead, use `veridic metrics --md`.

With no arguments it measures every tracked `*spec.md` in the current repo. Exit code 1 only means the "Needs attention" list is not empty.

After the table, add one line saying which item in "Needs attention" to fix first and why. What the columns mean, if the user asks:

- **Cites OK %**: citations that resolve to real lines.
- **Claims supported %**: facts a requirement states (identifiers, messages, numbers) that appear in the lines it cites.
- **Anchored %**: citations tied to a symbol, so they can follow the code when it moves.
- **Stale reqs**: requirements whose cited code changed since the spec was last committed (or since HEAD, for a spec outside the repo).
- **Cites to update**: citations whose code only moved; `veridic stale --fix` updates them.
- **Deps cited %**: literal constants the cited code depends on that the spec also cites.
- **Spec coverage**: API routes with at least one citation in their handler.
