---
date: 2026-08-07
pr: pending
feature: Remote Agent workspace file transfer
impact: Approved remote group-chat Agents can upload and download binary files during a run.
---

The short-lived remote workspace grant now authorizes bounded binary transfers
in addition to the existing JSON file operations. Agents can stream downloads
and uploads of up to 20 MiB while path confinement, sensitive-file blocking,
symbolic-link rejection, and per-run request limits remain enforced.

Downloads return a SHA-256 digest. Replacing an existing file requires the
matching digest so concurrent user or Agent edits cannot be overwritten
silently.
