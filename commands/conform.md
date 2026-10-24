---
description: Check a running app against its specs (the original first, then any rebuild): access, scoping, worked examples, product journeys
argument-hint: "<base url, e.g. http://localhost:3000>"
allowed-tools: Bash(veridic:*)
---

Run the conformance suite against: $ARGUMENTS

1. If `.veridic.json` has no `"conform": { "seed": "<command>" }`, say that checks needing a signed-in user or a record won't run, and offer to write a seed script: it creates two users (owner, other) and the records the routes' `:params` need, and prints `{ "users": { "owner": { "headers": {…} }, "other": { "headers": {…} } }, "seeds": { "<param>": "<value>" } }`. Write it only if the user agrees.
   Seed through the API itself (register, create), not the database, so the same seed works on a rebuild.
2. The checks come from the specs' example rows. A signed-out check comes from each route that needs sign-in (an optional guard doesn't); an "another user is refused" check only from a row the spec writes `as other` with `denied`, 403 or 404, since using the caller's id isn't refusing others. In a row's body or expected value, `{{unique}}` is fresh for every request (a journey replays rows that create records) and `{{name}}` is the seed's `name`.
3. Run `veridic conform --url <url>`. With a seed, show the user the seed command from `.veridic.json` and add `--run-seed` only once they've agreed to run it: it's a shell command from the repo. It refuses anything but a local address unless the user asked for `--allow-remote`.
4. Report the fidelity %, then each failed check with its rule and what it got, then what didn't run and why. On the original app, every failure is either a spec that's wrong or a seed that's missing something: say which.
