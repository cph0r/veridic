---
description: Write an evidence-backed spec for an existing feature (gathers context first; runs on Sonnet)
argument-hint: "<feature, route, or file> [output folder]"
model: claude-sonnet-5-5
allowed-tools: Bash(veridic:*)
---

Write a spec for: $ARGUMENTS

If the argument is `product`, write or refresh the app's product spec instead,
`specs/product/spec.md`: one sentence on what the app does (from the README),
`## Journeys` (`### J-001: Title`, numbered steps, each ending with the part
rules that make it work, `(apps:FR-003, auth:FR-001)`), and `## Guarantees`
(`- **G-001**: promise [rules: apps:FR-003, apps-host:FR-002]`). It cites part
rules, never code. Read the README, `veridic modules` and the part specs; run
`veridic check --spec specs/product/spec.md` until it's clean; then stop.

Follow the veridic skill. This command uses its cheapest proven path: gather
the feature's context once, before reading anything else.

0. **A part, or every part?** Use Veridic's split, not your own:
   `veridic modules --md` lists the parts and where each spec goes. For each
   one, `veridic prepare --module <id> --out .veridic/context/<id>.md`, then step 2
   onwards, writing to that part's `spec_path` (extend a spec that already
   covers it). Its open findings are risks or open questions, never MUST
   rules. For several parts, start with those that move money or have
   high issues.
1. **Pick seeds.** `veridic routes <a word or two from the feature>` lists
   matching routes. Choose the feature's entry routes (several is normal: create,
   status, payment, webhook…). If the user named a file or function, seed with
   that instead.
2. **Gather once.** The spec goes in `specs/<feature>/spec.md` in this repo
   (or the folder the user named); the context goes in `.veridic/context/`,
   which git ignores:
   ```bash
   veridic prepare --out .veridic/context/<feature>.md "<METHOD /path>" "<METHOD /path>" …
   ```
   It prints a one-line summary. Then **read that context file in full**
   (scope, contract comparison, every relevant code range with real line
   numbers). Read other files only for what it doesn't show; if the feature can
   unlock or limit other parts of the app, check those parts yourself.
3. Continue from step 3 of the skill's sequence: write `spec.md` once, verify
   once with `veridic cite` and `veridic claims`, fix, verify again. For a part,
   run `veridic coverage --module <id>` and cite each file it
   lists, or say in Assumptions why it needs none. Then
   `veridic tests --spec <folder>/spec.md --table > <folder>/traceability.md`.
4. Finish with `veridic metrics --md <folder>/spec.md` and show the table.
