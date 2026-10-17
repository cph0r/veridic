---
description: Set this repo up for Veridic (find or install the code indexer, build the index, check routes)
argument-hint: "[--install]"
allowed-tools: Bash(veridic:*)
---

Setting up builds a code index in `.codegraph/` (it ignores itself in git) and, with `--install`, installs the `@colbymchenry/codegraph` CLI globally with npm. Say that to the user and wait for a clear yes before running:

```bash
veridic init $ARGUMENTS
```

Show the card it prints exactly as printed. If codegraph is missing, offer `veridic init --install`. Veridic runs codegraph with its telemetry off.

If the card says modules have no spec, offer to continue with `/veridic:specs`
(it writes one spec per module, riskiest first, and asks before starting any
agents). Run it only after a clear yes.
