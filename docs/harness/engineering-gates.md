# Engineering Gates

These gates prevent two recurring delivery failures: restarting the same failed
architecture under a new Issue, and reporting a candidate as pushed when the
remote branch does not contain it.

## Stable problem direction and shared rework budget

`docs/harness/task-contracts.json` is the durable ledger for architecture or
protocol directions that have entered bounded design/rework cycles.

- Keep one stable `key` across successor Issues for the same underlying problem.
- `maxTotalReworks` applies to the whole direction, not to each Issue or branch.
- Every validation method has a unique `id`. A stopped method cannot be restarted
  under a new Issue.
- A successor method requires an explicit `restarts` record with the prior and
  next method, authorizing role, and concrete reason the validation method
  changed.
- Exhausting the shared budget leaves the direction `stopped`. Restart requires a
  new authorized method and available budget; changing only the Issue number is
  invalid.

Run the gate directly with:

```bash
npm run contracts:check
```

`npm run harness:check` also validates the ledger.

## Candidate evidence after push

Never hand-copy candidate identity or infer remote success from `git push`
output. After commit and push, run:

```bash
npm run candidate:evidence -- \
  --base <base-sha> \
  --remote <remote> \
  --branch <branch> \
  --ledger docs/harness/task-contracts.json \
  --problem-key <stable-direction-key> \
  --issue <issue-number> \
  --method <active-method-id> \
  --json
```

The command fails closed unless:

1. the current worktree is clean;
2. the Issue is registered under the named active problem direction and active
   validation method;
3. the current branch matches the requested branch;
4. Base is an ancestor of HEAD;
5. a fresh fetch of the named remote branch succeeds;
6. local HEAD, `FETCH_HEAD`, and the remote-tracking ref are identical.

Only after those checks does it emit Base, HEAD, Tree and a SHA-256 over the exact
bytes from `git diff <base> <head>`. The emitted JSON is the evidence
source for review handoff; a manually assembled identity is not equivalent.

## Required failure tests

The harness tests use real temporary Git repositories and bare remotes. They must
continue to prove that dirty worktrees, wrong or missing branches, and unpushed
commits are rejected, while a clean pushed candidate succeeds.
