---
description: Everything that belongs to a feature (routes, webhooks, timers, services) and what to read first
argument-hint: "\"POST /api/orders\" | <file> | <symbol>"
allowed-tools: Bash(veridic:*)
---

```bash
veridic scope $ARGUMENTS
```

Summarize the result: the core routes, webhooks and timers, other callers, and the first ten entries of `read_list` (file:lines). Point out anything pulled in that the user might not expect, such as a webhook or timer that shares state with the seed.
