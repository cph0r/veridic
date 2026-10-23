---
description: Open the Veridic report in the browser (specs, routes, findings with fixes, tests, current change)
argument-hint: "[spec.md ...]"
allowed-tools: Bash(veridic:*)
---

Run this; it writes one HTML page and opens it in the user's browser:

```bash
veridic report $ARGUMENTS
```

The page is written to `.veridic/report.html` in the repo (git-ignored by its own `.gitignore`). Then tell the user, in two or three lines: where the page is (the `wrote` path), and the top thing to fix from its findings (`findings.high` first). If `opened` is false (no display, CI), give them the path to open themselves.

The page has tabs: Overview, Specs (rules with their cited code, tests and freshness), Routes (what each route really does and who can call it), Findings (each with a suggested fix), Tests (what they check), and Current change (the claim, stray edits, untested routes). For the same data as JSON, use `veridic report --json`.
