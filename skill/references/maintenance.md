# Keeping a spec in step with the code

## Anchor the citations

`plumb anchor --spec S --write` turns `path:120-140` into
`path:120-140#createOrder@26`: the smallest enclosing symbol and the line it
started on. An anchored citation can be moved automatically when code above it
changes, because CodeGraph knows where `createOrder` starts now. Citations at
file top level stay plain; that's fine.

## On a later change

```bash
plumb stale --spec S --fix                                  # local: update what only moved
plumb stale --spec S --range origin/main...HEAD --pr       # CI
```

- `--fix` rewrites citations whose code only moved (by the diff, confirmed by
  the anchor when the index has one). For a spec committed in the repo it
  compares against the committed version, so it is safe to run repeatedly.
  Run `codegraph sync` first, or anchored citations report a `conflict`.
- `open` / `stale`: requirements whose cited lines were `edited` or `deleted`.
  Never auto-fixed: re-read the new code (`now` gives the approximate new
  location), update the requirement's text and citation, or drop it.
- `conflicts`: the anchor and the diff disagree, or the index is out of date.
- `uncovered_hunks`: changed lines in cited files that no citation covers.
- `--pr` reads the spec as of the PR's base, finds what the PR's diff affects,
  and fails unless the PR's version of the spec updated it.

## Keep it automatic

- **git pre-commit**: `plumb install-hook` (refuses to overwrite an existing
  hook). Updates moved citations and stages the spec; blocks the commit when a
  cited requirement's code changed. Bypass once with `PLUMB_ALLOW_STALE=1`.
- **Claude Code Stop hook**: in the target repo's `.claude/settings.json`,
  `{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "node <path>/hooks/claude-stop.mjs"}]}]}}`.
- **CI**: `hooks/github-actions.yml` runs `stale --pr` on every spec.

All three find specs as every tracked `*spec.md`, or `PLUMB_SPECS`.
Installing a hook writes into the target repo: ask the user first.

## Measuring a spec

`plumb metrics --md`: citations resolving, claims supported, anchors,
staleness, dependency coverage, tests, and spec coverage of the API.
