---
date: 2026-06-09
pr: 1451
feature: Claude Code root permission mode
impact: Claude Code runs started by Web UI avoid the root-only failure from dangerous permission bypass mode.
---

Non-root launches keep `--dangerously-skip-permissions`. Root launches use
`--permission-mode auto` because Claude Code refuses dangerous bypass mode under
root or sudo.
