# Worktree Runbook

Use a separate git worktree for agent changes so local user work remains
untouched.

## Create A Worktree

```bash
git fetch origin --prune
git worktree add -b codex/<short-topic> ../worktrees/hermes-web-ui-<short-topic> origin/main
cd ../worktrees/hermes-web-ui-<short-topic>
```

If the repository uses a fork remote, push to the remote requested by the task.
Do not rewrite or reset unrelated branches.

## Install

```bash
npm ci --ignore-scripts
npm rebuild node-pty
```

Desktop package dependencies are separate:

```bash
npm ci --prefix packages/desktop --no-audit --no-fund
```

## Isolated Runtime

Use per-worktree state and ports to avoid colliding with a running local app:

```bash
export PORT=18648
export HERMES_WEB_UI_HOME="$PWD/.tmp/hermes-web-ui"
export HERMES_WEBUI_STATE_DIR="$HERMES_WEB_UI_HOME"
export UPLOAD_DIR="$PWD/.tmp/uploads"
npm run dev
```

Do not point `HERMES_WEB_UI_HOME` at a user's real `~/.hermes-web-ui` when a task
only needs local verification.

## Browser Checks

For browser-visible changes:

```bash
npm run test:e2e
```

Prefer existing Playwright fixtures and mocked backend services. Add real-service
requirements only when the behavior cannot be represented with mocks.

## Cleanup

After a PR is pushed and no more local work is needed:

```bash
git worktree remove ../worktrees/hermes-web-ui-<short-topic>
```

Only remove the worktree you created.
