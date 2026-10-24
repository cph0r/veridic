---
description: Check a running app against its specs (the original first, then any rebuild): access, scoping, worked examples, product journeys
argument-hint: "<base url, e.g. http://localhost:3000>"
allowed-tools: Bash(veridic:*)
---

Run the conformance suite against: $ARGUMENTS

1. If `.veridic.json` has no `"conform": { "seed": "<command>" }`, say that checks needing a signed-in user or a record won't run, and offer to write a seed script: it creates two users (owner, other) and the records the routes' `:params` need, and prints `{ "users": { "owner": { "headers": {…} }, "other": { "headers": {…} } }, "seeds": { "<param>": "<value>" } }`. Write it only if the user agrees.
2. Run `veridic conform --url <url>`. It refuses anything but a local address unless the user asked for `--allow-remote`.
3. Report the fidelity %, then each failed check with its rule and what it got, then what didn't run and why. On the original app, every failure is either a spec that's wrong or a seed that's missing something: say which.
