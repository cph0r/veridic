---
description: Keep this repo's specs in step automatically (git pre-commit and Claude Stop hooks)
---

Explain what each hook does, then ask the user which to install. Installing writes into the repo, so wait for a clear yes.

- **git pre-commit**: `plumb install-hook` installs it (it refuses to overwrite an existing hook). It updates citations that only moved and stages the spec, and blocks a commit that changes code a requirement cites until the requirement is updated. Bypass once with `PLUMB_ALLOW_STALE=1`.
- **Claude Code Stop hook**: add this to the repo's `.claude/settings.json`, merging with any existing `hooks`:

  ```json
  {"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/skill/hooks/claude-stop.mjs\""}]}]}}
  ```

  Write the path above with `${CLAUDE_PLUGIN_ROOT}` already expanded. Before an agent finishes, it updates moved citations and sends the agent back once to update any requirement whose code it changed.
- **CI**: copy `${CLAUDE_PLUGIN_ROOT}/skill/hooks/github-actions.yml` to `.github/workflows/plumb.yml` and adjust the plumb path.

All three find specs as every tracked `*spec.md`, or the comma-separated `PLUMB_SPECS`.
