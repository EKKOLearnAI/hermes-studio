# Engineering Gates

These gates prevent two recurring delivery failures: restarting the same failed
architecture under a new Issue, and reporting a candidate as pushed when the
remote branch does not contain it.

## Stable problem direction and shared rework budget

`docs/harness/task-contracts.json` is the canonical durable ledger for
architecture or protocol directions that have entered bounded design/rework
cycles. Candidate evidence always reads this fixed repository path; callers
cannot substitute another ledger file.

- Keep one stable `key` across successor Issues for the same underlying problem.
- `maxTotalReworks` applies to the whole direction, not to each Issue or branch.
- Every validation method has a unique `id`. A stopped method cannot be restarted
  under a new Issue.
- A successor method requires an explicit `restarts` record with the prior and
  next method, authorizing role, and concrete reason the validation method
  changed.
- Historical directions, methods, Issue bindings, authorization records, and
  rework counts are checked as an append-only transition from a trusted Git
  commit. They cannot be deleted, renamed, reordered, or reset.
- A shared budget increase requires an appended authorized `budgetChange`
  recording its exact previous and next values. Silent expansion is invalid.
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
  --problem-key <stable-direction-key> \
  --issue <issue-number> \
  --method <active-method-id> \
  --json
```

The command first fetches the fixed trusted base branch `origin/main` and
requires `--base` to match it exactly. It reads the trusted ledger from that
protected Base. During the
one-time bootstrap where the protected Base does not yet contain the ledger, it
uses the frozen independently reviewed commit embedded in the gate and requires
that commit to remain an ancestor of HEAD.

The command fails closed unless:

1. the canonical ledger passes shared-budget, unique-method,
   restart-authorization, and active-state validation;
2. the trusted-to-candidate ledger transition is append-only and monotonic;
3. the supplied Base exactly matches a freshly fetched trusted base branch;
4. the current worktree is clean;
5. the Issue is registered under the named active problem direction and active
   validation method;
6. the current branch matches the requested branch;
7. Base and the frozen bootstrap anchor, when needed, are ancestors of HEAD;
8. a fresh fetch of the named remote branch succeeds;
9. local HEAD, `FETCH_HEAD`, and the remote-tracking ref are identical.

Only after those checks does it emit Base, HEAD, Tree and a SHA-256 over the exact
bytes from `git diff <base> <head>`. The emitted JSON is the evidence
source for review handoff; a manually assembled identity is not equivalent.

## Required failure tests

The harness tests use real temporary Git repositories and bare remotes. They
must continue to prove that replacement ledger paths, rewritten Issue/history,
decreased rework counts, stopped-method reactivation, silent budget expansion,
forged/disconnected anchors, dirty worktrees, wrong or missing branches, and
unpushed commits are rejected, while a clean pushed authorized transition
succeeds.
