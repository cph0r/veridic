---
description: Open the Veridic dashboard in the browser: every part of the app, its spec, and how many of its rules are up to date and proven
argument-hint: "[spec.md ...]"
allowed-tools: Bash(veridic:*)
---

Run this; it writes one HTML page and opens it in the user's browser:

```bash
veridic report $ARGUMENTS
```

The page is written to `.veridic/report.html` in the repo (git-ignored by its own `.gitignore`). Then tell the user, in two or three lines, where the page is (the `wrote` path) and how many specs it shows. If `opened` is false (no display, CI), give them the path to open themselves.

The page shows the specs and nothing else: three gauges (rules up to date, proven, app covered), a table of the app's parts to search, filter and sort, and for each part a sheet with three tabs: Overview (its rules by state, what needs attention), Stories, and Rules (each with its cited code and the tests that prove it). It only shows; it changes nothing. For the same data as JSON, use `veridic report --json`.
