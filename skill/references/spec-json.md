# spec.json (spec v2)

Write the spec as data; `veridic render --spec spec.json` validates it and
writes `spec.md` (Spec Kit layout) and `traceability.md` next to it. The
contract and state-machine sections are generated from the code; don't write
them. Fix every problem `render` reports and run it again.

```json
{
  "feature": "Guest table ordering and payment",
  "seeds": ["POST /api/orders", "POST /api/orders/:id/pay"],
  "stories": [
    {"id": "US1", "title": "Guest places an order", "priority": "P1", "why": "…",
     "scenarios": [{"given": "…", "when": "…", "then": "…", "proves": ["FR-003"]}]}
  ],
  "requirements": [
    {"id": "FR-001", "rule": "The system MUST …", "evidence": ["path/to/file.ts:114-120"]},
    {"id": "FR-002", "status": "planned", "rule": "The system MUST … (not built yet: evidence may be empty)"},
    {"id": "FR-003", "rule": "…", "evidence": ["a.ts:10"], "clarify": "what the code can't tell you"}
  ],
  "invariants": [
    {"id": "INV-1", "rule": "A paid order is never cancelled.", "holds": "no", "broken_by": ["R1"], "evidence": ["…"]}
  ],
  "decision_tables": [
    {"for": "FR-001", "title": "Line quantity", "columns": ["quantity", "status"], "rows": [[0, 400], [20, 201], [21, 400]], "evidence": ["…"]}
  ],
  "entities": [{"name": "Order", "description": "…", "evidence": ["…"]}],
  "edge_cases": [{"text": "…", "evidence": ["…"]}],
  "success_criteria": [{"text": "…", "evidence": ["…"]}],
  "assumptions": ["…"],
  "risks": [
    {"id": "R1", "severity": "high", "title": "One-line risk", "detail": "Why it happens and what it costs.", "evidence": ["…"]}
  ],
  "open_questions": ["…"]
}
```

Write evidence as `path:start-end`; `veridic render` adds a hash of the cited lines (`path:start-end~3f9a1c`) so the rule is judged by that text later. Don't write or edit hashes by hand.

- Ids: `FR-001`, `INV-1`, `R1`, `US1`; unique. Evidence: `path:line` or `path:start-end`.
- **Verification criteria**: give a requirement `"verification": [{"id": "VC1", "text": "…"}]`,
  one checkable condition each. Name tests `FR-001 VC1: …` (or the domain
  style `T-ORD-0001.1.1-API`); coverage is then reported per criterion.
- **`domain`** (2–6 capitals, e.g. `ORD`): `render` also writes `requirements.md` in
  the domain requirements format (`R-ORD-0001`, verification criteria, test mappings),
  with an Evidence line per requirement. Optional: `summary`, `overview`,
  `scope: {covers, excludes}`, `change` (the change request), and per requirement
  `title` and `category`.
- **Invariants** are rules across every route, timer and webhook ("never",
  "always"). The context's state-machine hints are good sources; say whether
  each holds (`yes`/`no`/`unclear`) and link the risks that break it.
- **Decision tables** for rules with several input cases: they become tests
  directly.
- `status: "planned"` is for spec-first work (the code doesn't exist yet). Give it
  a `"seam": ["src/new-file.ts", …]`: the files it will live in, so `veridic done`
  knows which changes belong to it before it cites any code.
- **Decisions**: why the code is the way it is, each checkable against git.
  ```json
  "decisions": [
    {"id": "D-001", "decision": "Cap an order at 20 lines.", "because": "Kitchen printers truncate longer tickets.",
     "evidence": ["src/orders.ts:40-44", "commit:4f2a9c1"], "for": ["FR-003"]},
    {"id": "D-002", "decision": "Cap at 30.", "because": "New printers.", "evidence": ["commit:9be01d2"], "supersedes": "D-001"}
  ]
  ```
  Find the commit with `veridic why --spec spec.md FR-003`. Only write a `because`
  the commit message, a comment or the code supports; otherwise ask. `render`
  checks every commit exists and changed the cited file, and refuses to render
  a committed decision that was edited or removed (append-only).
