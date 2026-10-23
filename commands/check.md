---
description: Check a spec's citations resolve and hold the facts each rule states
argument-hint: "<spec.md>"
allowed-tools: Bash(veridic:*)
---

Check the spec at `$ARGUMENTS`:

```bash
veridic check --spec $ARGUMENTS
```

This prints two JSON documents: `cite` (does each citation resolve; the cited text) and `claims` (do the cited lines hold the facts the rule states).

Report the summary numbers first: citations resolving, claims supported. Then, for each problem, re-read the cited code yourself and say whether the citation is wrong (give the corrected `path:start-end`), the rule's wording is off, or the flag is noise. Don't edit the spec unless the user asks.
