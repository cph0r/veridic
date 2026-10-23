---
description: Keep this repo's specs in step automatically (git pre-commit and Claude Stop hooks)
---

Explain what each hook does, then ask the user which to install. Installing writes into the repo, so wait for a clear yes.

- **git pre-commit**: `veridic install-hook` installs it (it refuses to overwrite an existing hook). It updates citations that only moved and stages the spec, and blocks a commit that changes code a rule cites until the rule is updated. Bypass once with `VERIDIC_ALLOW_STALE=1`.
- **Claude Code Stop hook** (ships with the plugin, off until a repo opts in): `veridic init --enforce` writes `.veridic.json` with `{"stop": ["done", "stale"]}`. From then on, when Claude tries to finish, the hook runs `veridic done` against the task's claim and sends it back once if the change strayed outside the claim or a changed route has no asserting test; with `stale` it also updates moved citations and sends it back to update rules whose cited code changed. Commit `.veridic.json` to turn it on for everyone working in the repo; delete it to turn it off.
- **CI**: copy `${CLAUDE_PLUGIN_ROOT}/skill/hooks/github-actions.yml` to `.github/workflows/veridic.yml` and adjust the veridic path.

All three find specs as every tracked `*spec.md`, or the comma-separated `VERIDIC_SPECS`.
