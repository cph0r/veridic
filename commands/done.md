---
description: Is it done? The change stayed in the claimed rules' seam, and every criterion has an asserting test
argument-hint: "<spec.md> [FR-002 ...] [--run]"
allowed-tools: Bash(veridic:*)
---

Run this and show the card exactly as printed:

```bash
veridic done --card --spec $ARGUMENTS
```

If the first argument isn't a spec path, find the spec the user means (`git ls-files '*spec.md'`) and pass the rule ids after it. With no ids it checks every rule the change touched.

After the card, add one line: the first thing to fix, or that it's done. A stray file is a change outside every claimed rule: claim the rule it belongs to, declare it in that rule's `seam` in spec.json, or undo it.
