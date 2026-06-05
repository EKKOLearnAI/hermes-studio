# Chat Chain Change Fragments

Add one Markdown fragment per PR when a change touches the Chat session chain,
Agent Bridge, compression, or Group Chat runtime paths documented in
`docs/cli-chat-sessions.md`.

Do not append new rows to `docs/cli-chat-sessions.md`. Keeping one fragment per
PR avoids merge conflicts when multiple branches change the chat chain at the
same time.

Use this shape:

```md
---
date: YYYY-MM-DD
pr: 1234
feature: Short feature name
impact: One-sentence behavior impact
---

Optional extra notes.
```

If the PR number is not known yet, use `pr: pending` while the branch is local,
then update that same fragment after the PR is opened.
