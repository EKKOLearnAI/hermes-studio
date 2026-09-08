---
name: github
description: Use GitHub CLI for repositories, issues, pull requests, reviews, CI runs, releases, and structured GitHub API queries.
metadata:
  keywords:
    - github cli
    - gh cli
    - pull request
    - github actions
---

# GitHub

Use `gh` for GitHub operations and `git` for local branches, commits, pulls, and pushes. Use code-reading tools for deep reviews.

## Prerequisites

Check authentication before making a GitHub request:

```bash
gh auth status
```

If `gh` is missing or unauthenticated, explain what is required. Do not invent credentials or expose tokens.

## Pull requests

```bash
gh pr list --repo owner/repo --json number,title,state,author,url
gh pr view 55 --repo owner/repo --json title,body,author,files,commits,reviews,reviewDecision
gh pr checks 55 --repo owner/repo
gh pr diff 55 --repo owner/repo
gh pr create --repo owner/repo --title "feat: title" --body-file /tmp/pr.md
gh pr merge 55 --repo owner/repo --squash
```

URLs work directly with commands such as `gh pr view`. Treat create, comment, review, merge, close, release, and workflow rerun operations as external mutations: perform them only when the user requested that action. Before submitting, show or verify the exact repository and target.

## Issues

```bash
gh issue list --repo owner/repo --state open --json number,title,labels,url
gh issue view 42 --repo owner/repo --json title,body,comments,labels,state
gh issue create --repo owner/repo --title "Bug: ..." --body-file /tmp/issue.md
gh issue comment 42 --repo owner/repo --body-file /tmp/comment.md
gh issue close 42 --repo owner/repo --comment "Fixed in ..."
```

## CI and runs

```bash
gh run list --repo owner/repo --limit 10
gh run view <run-id> --repo owner/repo --json status,conclusion,headSha,url
gh run view <run-id> --repo owner/repo --log-failed
gh run rerun <run-id> --repo owner/repo --failed
```

## API

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh api repos/owner/repo/labels --jq '.[].name'
gh api --cache 1h repos/owner/repo --jq '{stars: .stargazers_count, forks: .forks_count}'
```

Prefer `--json` with `--jq` for structured output. Use `--body-file` for comments and bodies containing backticks, shell snippets, environment names, or user-provided text.
