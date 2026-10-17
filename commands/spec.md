---
description: Write an evidence-backed spec for an existing feature (gathers context first; runs on Sonnet)
argument-hint: "<feature, route, or file> [output folder]"
model: claude-sonnet-5-5
allowed-tools: Bash(veridic:*)
---

Write a spec for: $ARGUMENTS

Follow the veridic skill. This command uses its cheapest proven path: gather
the feature's context once, before reading anything else.

0. **A module, or every module?** Use Veridic's split, not your own:
   `veridic modules --md` lists the modules and where each spec goes. For each
   one, `veridic prepare --module <id> --out specs/<id>/context.md`, then step 2
   onwards, writing to that module's `spec_path` (extend a spec that already
   covers it). Its open findings are risks or open questions, never MUST
   requirements. For several modules, start with those that move money or have
   high issues.
1. **Pick seeds.** `veridic routes <a word or two from the feature>` lists
   matching routes. Choose the feature's entry routes (several is normal: create,
   status, payment, webhook…). If the user named a file or function, seed with
   that instead.
2. **Gather once** into the output folder (default `specs/<feature>/` in the
   current project, never inside the target repo):
   ```bash
   veridic prepare --out <folder>/context.md "<METHOD /path>" "<METHOD /path>" …
   ```
   It prints a one-line summary. Then **read `<folder>/context.md` in full**
   (scope, contract comparison, every relevant code range with real line
   numbers). Read other files only for what it doesn't show; if the feature can
   unlock or limit other parts of the app, check those parts yourself.
3. Continue from step 3 of the skill's sequence: write `spec.md` once, verify
   once with `veridic cite` and `veridic claims`, fix, verify again, then
   `veridic tests --spec <folder>/spec.md --table > <folder>/traceability.md`.
4. Finish with `veridic metrics --md <folder>/spec.md` and show the table.
