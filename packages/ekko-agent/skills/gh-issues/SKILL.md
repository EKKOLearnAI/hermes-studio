---
name: gh-issues
description: Triage GitHub issues, select safe candidates, implement focused fixes, open pull requests, and address actionable review feedback.
metadata:
  keywords:
    - github issues
    - issue to pr
    - gh issues
    - issue triage
---

# GitHub issues to pull requests

Use this workflow for issue-to-PR work. Use `gh` for GitHub data and mutations, `git` for the local checkout, and `delegate_task` only when an isolated subtask is genuinely useful.

Read the bundled `github` Skill before executing this workflow. GitHub writes, commits, pushes, PR creation, and review replies must stay within the outcome the user requested.

## Inputs

- Repository: accept `owner/repo` or infer it from `git remote get-url origin`.
- Optional filters: label, milestone, assignee, state, and limit.
- Optional fork: push a branch to a named fork and open the PR against the source repository.
- Dry run: list candidates and planned actions without changing local or remote state.
- Reviews only: skip issue selection and process explicitly scoped PR feedback.

If the user asked only to inspect, triage, or plan, stop before changing files, branches, issues, or PRs.

## 1. Resolve and verify the repository

```bash
git remote get-url origin
git status --short
gh auth status
gh repo view OWNER/REPO --json nameWithOwner,defaultBranchRef
```

Derive and keep explicit:

- `SOURCE_REPO`: repository containing the issue.
- `PUSH_REPO`: fork when explicitly requested, otherwise the source.
- `BASE_BRANCH`: source default branch unless the user named another.
- `PUSH_REMOTE`: configured fork remote or `origin`.

Stop if GitHub authentication is unavailable. Never search local configuration files for tokens, print `gh auth token`, or ask the user to paste a token into chat.

Do not mix issue work with unrelated uncommitted changes. If the checkout is dirty, preserve those changes and either ask the user how to proceed or create a dedicated git worktree after confirming the repository and base branch.

In fork mode, show the exact source, fork, base branch, and remote before adding or changing a git remote.

## 2. Fetch candidates

```bash
gh issue list --repo "$SOURCE_REPO" --state open --limit 10 \
  --json number,title,labels,url,body,assignees,milestone
```

Add only the filters the user requested. `gh issue list` excludes pull requests. If there are no matches, report that and stop. For a dry run, show a compact candidate list with issue number, title, labels, and URL, then stop.

## 3. Avoid duplicate work

For each candidate, look for an existing fix before selecting it:

```bash
gh pr list --repo "$SOURCE_REPO" --search "$SOURCE_REPO#<n>" --state open \
  --json number,url,title,headRefName
gh pr list --repo "$SOURCE_REPO" --head "fix/issue-<n>" --state open \
  --json number,url
gh api "repos/$PUSH_REPO/branches/fix/issue-<n>" >/dev/null
```

Skip an issue that already has an open PR or branch unless the user asked to continue that work. Read the issue body and relevant code before deciding it is actionable. Prefer small, reproducible issues with a clear acceptance condition; flag ambiguous or security-sensitive issues for clarification.

When several issues match and the user did not already select them, present the candidates and ask which issue numbers to fix.

## 4. Isolate the work

Default to one issue at a time. Ekko subagents share the workspace, so never let concurrent workers checkout different branches in the same working tree.

For one issue, either implement locally or call `delegate_task` in foreground mode with a self-contained goal and all required context. For independent parallel work, first create one dedicated git worktree per issue and give each background subagent its exact worktree path. Use background mode only when enabled and useful; progress is visible to the user, but the parent must not pretend it synchronously collected a result.

The task context must include:

- issue URL, title, body, labels, and acceptance conditions;
- source and push repositories, base branch, push remote, and fork mode;
- isolated working directory and target branch `fix/issue-<n>`;
- required tests and proof;
- the authorized mutation boundary, including whether commit, push, and PR creation were requested.

Delegated subagents cannot ask the user questions or delegate recursively. Resolve ambiguity before delegation.

## 5. Implement and prove the fix

For each selected issue:

1. Create `fix/issue-<n>` from the verified `BASE_BRANCH` in its isolated working tree.
2. Reproduce or locate the problem.
3. Implement the smallest coherent fix; avoid unrelated refactors.
4. Add or update focused tests when appropriate.
5. Run the relevant tests, type checks, and build steps.
6. Review the diff for unrelated files, generated artifacts, secrets, and accidental user changes.
7. If authorized, commit with a clear conventional message and push without force.
8. If authorized, open a PR against `SOURCE_REPO` and `BASE_BRANCH`.

Use a PR body file rather than shell interpolation. Include:

- the problem solved;
- why the change was made;
- user impact;
- test evidence;
- `Fixes SOURCE_REPO#<n>` when automatic closure is intended.

Never mark a test as passing unless it actually ran. If a failure is environmental, separate it from product failures and include the exact evidence.

## Review feedback

Discover scoped PRs and comments:

```bash
gh pr view <n> --repo "$SOURCE_REPO" \
  --json url,headRefName,comments,reviews,reviewDecision
gh api "repos/$SOURCE_REPO/pulls/<n>/comments"
gh api "repos/$SOURCE_REPO/issues/<n>/comments"
```

Process only PRs the user named or PRs created by this workflow within the current task. Group actionable comments by PR. Ignore praise, status-only notes, duplicates, and comments already addressed.

For each PR, checkout its branch in one isolated working tree, make the smallest requested change, run relevant tests, commit, and push normally. Never force-push unless the user explicitly requested it. Reply to review comments only when that external write is part of the request, and reference the actual fix and evidence.

## Report

Return a compact result per issue or PR:

- number and title;
- status: planned, skipped, fixed locally, PR opened, failed, or blocked;
- branch and PR URL when present;
- tests run and their outcome;
- a precise reason for skips, failures, or remaining review comments.
