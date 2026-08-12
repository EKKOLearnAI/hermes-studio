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
  next method, an approved authorizing role (`product-owner` or
  `technical-lead`), and a concrete reason the validation method changed.
- The predecessor must be stopped and must have consumed at least one rework.
  Only the final successor may be active.
- Historical directions, methods, Issue bindings, authorization records, and
  rework counts are checked as an append-only transition from a trusted Git
  commit. They cannot be deleted, renamed, reordered, or reset.
- An implementation candidate cannot append its own direction, successor,
  restart authorization, or budget increase. Those records must already exist
  in the trusted Base. Authorization changes are separate, manually reviewed
  ledger updates.
- Exhausting the shared budget leaves the direction `stopped`. Restart requires a
  new authorized method and available budget; changing only the Issue number is
  invalid.

Run the gate directly with:

```bash
npm run contracts:check
```

`npm run harness:check` also validates the current ledger snapshot. This is a
structural check, not a trusted Base-to-candidate approval.

## Two-stage trust and the Bootstrap boundary

Validator code supplied by a pull request cannot be trusted to approve that
same pull request. The gate therefore has two stages:

1. The one-time Bootstrap PR adds the validator, ledger, and trusted workflow.
   Because the protected Base does not yet contain those files,
   `candidate:evidence` emits identity with
   `gate.status=bootstrap-review-required`,
   `authoritative=false`, and exits with status `2`. It must not report an
   append-only-valid transition. Bootstrap approval is an independent manual
   exact-HEAD review.
2. After the Bootstrap is merged, `.github/workflows/trusted-pr-ledger.yml`
   runs on `pull_request_target`. It checks out the PR Base SHA, uses the
   validator committed in that Base, fetches only the candidate Git objects,
   and reads candidate ledger data with `git show`. It does not check out,
   install, or execute candidate code.

The workflow is only a trustworthy execution surface after it exists on the
default branch. Repository administrators must separately configure the
resulting check as required; this repository change does not claim that a
Ruleset or Branch Protection setting already exists.

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
requires `--base` to match it exactly. When that Base contains the validator and
ledger, the command extracts and executes the validator from the Base commit,
never from the candidate checkout. During Bootstrap it uses the frozen
independently reviewed ledger anchor only to report provenance; it does not
claim an authoritative transition.

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

It emits Base, HEAD, Tree and a SHA-256 over a fixed patch serialization. The
command disables external diff and textconv, fixes binary/full-index output,
prefixes, rename detection, diff algorithm, and color, and includes the full
command array in `patchCommand`. Local Git diff configuration must not change
the digest.

For a post-Bootstrap candidate, trusted approval comes from the Base-owned
`Trusted PR Ledger` check. Local `candidate:evidence` remains useful for
identity, clean-worktree, remote round-trip, and diagnostic validation, but a
candidate-controlled script output is not itself a trust root.

## Required failure tests

The harness tests use real temporary Git repositories and bare remotes. They
must continue to prove that candidate validator replacement, snapshot-only
validation, self-authorization, zero-cost restarts, exhausted-active state,
successor ordering errors, replacement ledger paths, rewritten Issue/history,
decreased rework counts, stopped-method reactivation, silent budget expansion,
forged/disconnected anchors, dirty worktrees, wrong or missing branches, and
unpushed commits are rejected. They also prove that patch identity is stable
under hostile local diff configuration.
