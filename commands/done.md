---
description: Is it done? The change stayed in the claimed requirements' seam, and every criterion has an asserting test
argument-hint: "<spec.md> [FR-002 ...] [--run]"
allowed-tools: Bash(veridic:*)
---

Run this and show the card exactly as printed:

```bash
veridic done --card --spec $ARGUMENTS
```

If the first argument isn't a spec path, find the spec the user means (`git ls-files '*spec.md'`) and pass the requirement ids after it. With no ids it checks every requirement the change touched.

After the card, add one line: the first thing to fix, or that it's done. A stray file is a change outside every claimed requirement: claim the requirement it belongs to, declare it in that requirement's `seam` in spec.json, or undo it.
