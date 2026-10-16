---
description: Check a spec's citations resolve and hold the facts each requirement states
argument-hint: "<spec.md>"
allowed-tools: Bash(plumb:*)
---

Check the spec at `$ARGUMENTS`:

```bash
plumb check --spec $ARGUMENTS
```

This prints two JSON documents: `cite` (does each citation resolve; the cited text) and `claims` (do the cited lines hold the facts the requirement states).

Report the summary numbers first: citations resolving, claims supported. Then, for each problem, re-read the cited code yourself and say whether the citation is wrong (give the corrected `path:start-end`), the requirement's wording is off, or the flag is noise. Don't edit the spec unless the user asks.
