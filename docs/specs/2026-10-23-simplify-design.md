# Simplify: parts, specs, rules

Date: 2026-10-23. Status: draft for review.

## Goal

Someone who knows the requirements, not the code, should need three words to use
Veridic: a **part** of the app, its **spec**, and the spec's **rules**. Each part
has one spec; the dashboard lists parts, not spec files.

## Why

- **Too many words for three things.** A part of the app is a *module*, *part*,
  *screen group* or *folder in no part*; a rule is a *requirement*, *FR*, *INV*,
  *rule* or *check*; a spec is *spec.md*, *spec.json*, *requirements.md* and
  *traceability.md*. The dashboard says "rules", the skill "requirements",
  `veridic modules` "modules", `veridic coverage` "parts".
- **Specs stopped mapping to parts.** App A has about 21 parts and 30 spec files:
  Orders has four (`orders`, `orders-payment`, `orders-payment-gateway`,
  `orders-analytics`), Menu and its enrichment five, Voice two. "What does Orders
  do?" means finding and reading four files.

## Design

### 1. Three words, everywhere a person reads

| Say | Instead of | Means |
|---|---|---|
| **part** | module, screen group, folder in no part | A piece of the app: a server feature, a group of screens, or leftover code |
| **spec** | spec.md, spec.json, requirements.md, traceability.md, sibling spec files | What one part should do |
| **rule** | requirement, FR, INV, verification criterion | One sentence the app must obey, citing the code |
| **story** | user story, scenario | An example of using the part (Given / When / Then) |

- Where: the dashboard, CLI human output (`--md`, cards, help text), the skill and
  commands' prose, the README.
- Rule ids (FR-002, INV-1) stay, shown small, as a reference to the line in the
  spec. A rule's checks (VC1…) show only inside an opened rule.
- Not changed: JSON keys and flags (`modules`, `--module`, `requirements`), so
  agents and scripts keep working. `veridic parts` is added as the same command as
  `veridic modules`.

### 2. One spec per part

- **Which part a spec file belongs to:** the part whose code its rules cite most;
  with no citations, the part its folder is named after (`specs/orders-…` →
  orders); else it stands alone under "Other specs". On App A this places every
  file (e.g. `orders-payment-gateway` → Orders, `menu-live` → its enrichment part).
- **A part's spec** is all its files, read as one: their rules, stories and counts
  added up; each file a section, titled by its own title.
- **The dashboard table lists parts**, every part including those with no spec yet
  ("No spec" in Health), so the table also shows what's missing. Columns: Part,
  Health, Rules, Proven, Broken, Out of date, Not tested, Stories, Covered (the
  part's files a spec cites, of its files). Clicking a row opens the part's spec,
  its files as sections.
- **Writing keeps it one spec.** `veridic modules`/`parts` gives each part one
  `spec_path`: its existing main file (the one named after it, else its largest),
  or `specs/<part>/spec.md`. `/veridic:specs` and the spec skill extend that file;
  they never start a sibling file for a part that has a spec.

### 3. The plumbing stays out of sight

`spec.json`, `requirements.md` and `traceability.md` keep their jobs but are never
shown or named on the dashboard; the README mentions them once, under "files
Veridic writes".

## Out of scope

- Merging existing sibling files into one file. They are grouped on the page now;
  a merge command, applied only after the person approves the diff, can follow.
- Renaming JSON keys or flags.
- How Veridic names parts (App A has a part called "clients" holding
  recommendations).

## Testing

- Report model: spec files grouped into parts by citations, then folder name, then
  "Other specs"; a part with no spec is a row with health "No spec"; counts add up
  across a part's files; rows filter and sort as before.
- `moduleList`: one `spec_path` per part, the existing main file when there is one.
- A wording check: the dashboard model's user-facing strings and the `--md` outputs
  of `modules`, `coverage` and `tests` don't use "requirement", "FR", "module" or
  "screen group" as words for these things.
