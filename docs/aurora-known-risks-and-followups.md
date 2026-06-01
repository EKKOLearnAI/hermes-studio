# Aurora OS v0.1 Known Risks and Follow-Ups

Date: 2026-05-29
Scope: Post-v0.1 risk tracker for Aurora OS on top of Hermes Web UI.

## Purpose

This document keeps v0.1 known risks visible after the release candidate. These items are not current v0.1 functional blockers if the release gate and manual regression pass, but they should be tracked before expanding Aurora OS to broader usage.

## Release Risk Policy

- P0 issues block the final v0.1 tag.
- P1 issues may ship only with a named owner and follow-up target.
- P2 issues are accepted polish or hardening work after v0.1.
- Any issue that weakens L3/L4 approvals, memory review, Hermes chat fallback, or generated-file path safety must be escalated to P0.

## Follow-Up Register

| Priority | Area | Risk | v0.1 Decision | Suggested Owner | Acceptance |
| --- | --- | --- | --- | --- | --- |
| P1 | Bundle size | Monaco, Mermaid, workers, videos, and vendor chunks remain large. | Ship if release gate passes with `acknowledge_large_chunks=true`. | Frontend platform | Largest startup path is code-split or lazy-loaded without breaking App Mode or editor flows. |
| P1 | Generated widgets | Generated widgets can be written and loaded safely, but rollback, signing, version metadata, and gallery lifecycle are incomplete. | Ship because writes are path-restricted and broken widgets fail cleanly. | Vibe Coding | Generated widgets have manifest metadata, rollback, delete/archive controls, and versioned audit trail. |
| P1 | Manual legacy regression | Automated Aurora smoke is strong, but full manual regression of every legacy Hermes surface still needs sign-off before final tag. | Do not final tag until `docs/aurora-legacy-regression-checklist.md` is complete or skipped items have owners. | Release owner | Checklist summary is updated with pass/skipped/fail status and linked follow-ups. |
| P2 | Legacy UI density | Some legacy views remain visually dense inside App Mode. | Ship as preserved behavior. | Design/frontend | Priority legacy apps receive Aurora bridge briefs, cleaner empty states, and less visual friction inside App Mode. |
| P2 | Intent routing | Aurora command routing is parser/keyword based and may miss natural phrasing. | Ship because no-match fallback returns to Hermes chat. | Commander/tooling | Add parser fixtures for real user utterances and confidence scoring for ambiguous routes. |
| P2 | App Mode coverage | More Hermes surfaces can be wrapped, but not every legacy app has native App Mode polish. | Ship with Advanced Console as fallback. | Frontend platform | Remaining high-value legacy apps have registry entries, bridge briefs, and E2E open/close checks. |
| P2 | Result presenters | Only stable structured outputs should become widgets; unstable data may still fall back to text or raw-safe cards. | Ship with current presenter coverage. | Frontend/data adapters | New presenters have fixture tests and never leak raw JSON into normal chat for known structured outputs. |
| P2 | CI artifact summaries | Release gate uploads artifacts, but richer summaries of build sizes and E2E screenshots are not yet automated. | Ship with artifacts attached. | DevEx | Workflow comments or artifacts summarize large chunks, Playwright status, and App Mode screenshots. |
| P2 | Local model/runtime variation | Different local LLM or Hermes runtime states may affect manual demos. | Ship with documented validation commands. | Release owner | Demo scripts and fixtures reduce dependency on local runtime state where possible. |

## P0 Escalation Triggers

Treat any of these as release blockers:

- Terminal, bash, or file-write execution can bypass Approval Gateway.
- Memory can be silently written without entering the review queue.
- Vibe Coding can write outside `packages/client/src/components/generated/`.
- Unknown Aurora prompts fail instead of falling back to Hermes chat.
- App Mode opens the legacy sidebar unexpectedly.
- Existing login/auth flow breaks.
- Core Hermes Socket.IO/API chat streaming breaks.

## Suggested Post-v0.1 Milestones

### v0.1.1: Release Hardening

- Complete bundle-size triage and split the highest-impact chunks.
- Add release-gate artifact summary notes.
- Convert manual legacy regression outcomes into tracked follow-up issues.

### v0.2: Generated Widget Governance

- Add signed generated-widget manifest.
- Add rollback/archive/delete affordances.
- Add generated-widget gallery metadata and audit trail.

### v0.3: Aurora App Expansion

- Expand App Mode coverage to more stable Hermes surfaces.
- Add bridge briefs and native Aurora empty states for dense legacy views.
- Expand intent parser fixtures based on real prompts.

## Tracking Notes

Before final v0.1 tag:

- Link this file from the release PR.
- Confirm P0 list is clean.
- Confirm all P1 items have owners or are explicitly accepted in the release notes.
