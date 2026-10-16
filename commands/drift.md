---
description: Where the OpenAPI contract and the implementation disagree
argument-hint: "[\"METHOD /path\" ...]"
allowed-tools: Bash(veridic:*)
---

```bash
veridic drift $ARGUMENTS
```

Report the counts first (documented but not implemented, implemented but undocumented), then the per-operation mismatches: status codes the handler returns that the contract omits, documented codes it never returns, and request fields read from the body that the schema doesn't declare. Status codes set inside helper functions are not scanned; check those by reading.
