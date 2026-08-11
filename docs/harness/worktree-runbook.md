# Optional Worktree Runbook

Git worktrees are optional. Work in the current checkout when the user prefers
that workflow and the working tree is clean. Use a separate worktree when
isolation is useful, such as when another branch has uncommitted work or a local
development server must keep running.

## Use The Current Checkout

Confirm the checkout is clean before switching or creating a branch:

```bash
git status --short --branch
git switch -c <short-topic>
```

Do not switch branches over unrelated uncommitted changes. Ask the user whether
to preserve the current checkout or use the optional isolated flow below.

## Create An Optional Worktree

```bash
git fetch origin --prune
git worktree add -b codex/<short-topic> ../worktrees/hermes-web-ui-<short-topic> origin/main
cd ../worktrees/hermes-web-ui-<short-topic>
```

If the repository uses a fork remote, push to the remote requested by the task.
Do not rewrite or reset unrelated branches.

After pushing, do not rely on the `git push` message or a local remote-tracking
ref. Verify the candidate through a fresh fetch:

```bash
npm run candidate:evidence -- --base <base-sha> --remote <remote> --branch <branch> \
  --ledger docs/harness/task-contracts.json --problem-key <key> \
  --issue <number> --method <id> --json
```

The command is the source of truth for Base, HEAD, Tree, Patch SHA-256 and the
remote equality check used in a handoff.

## Install

```bash
npm ci --include=dev --ignore-scripts
npm rebuild node-pty
```

Use `--include=dev` explicitly. Agent and packaging environments may export
`NODE_ENV=production`; relying on npm's implicit omit policy can otherwise leave
Vitest, Vue TypeScript tooling, and preview dependencies uninstalled.

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
