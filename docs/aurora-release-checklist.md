# Aurora OS Release Checklist

Date: 2026-05-28
Scope: v0.1 release readiness for Aurora OS on top of Hermes Web UI.

## Release Goal

Ship Aurora OS as a stable, intent-first operating layer while preserving Hermes Web UI as the underlying engine. A release is acceptable only when Aurora routes, widgets, App Mode, governance, Vibe Coding, and legacy fallback can all be verified from documented commands.

## Preflight

- [ ] Working branch is intentional and named for the Aurora release or integration slice.
- [ ] `git status --short` has been reviewed; unrelated user changes are not reverted or mixed into the release commit.
- [ ] `package.json` scripts include `test:aurora:unit` and `test:aurora`.
- [ ] `.github/workflows/aurora-smoke.yml` is present.
- [ ] `.github/workflows/aurora-release-gate.yml` is present for manual release validation.
- [ ] `.github/pull_request_template.md` includes Aurora validation and legacy protection checks.

## Required Commands

Run these from the repository root:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
npm run test:aurora
npm run build
```

Expected result:

- [ ] Aurora unit tests pass.
- [ ] Aurora Playwright smoke passes.
- [ ] TypeScript check passes.
- [ ] Production build passes.
- [ ] Any remaining Vite large chunk warning is acknowledged as known release risk, not a functional failure.

## Aurora Functional Gates

- [ ] Idle shell opens with Advanced Console closed.
- [ ] Reload keeps Advanced Console closed.
- [ ] OmniBar fallback sends unknown prompts to the normal Hermes chat stream.
- [ ] Cmd/Ctrl+K history palette works.
- [ ] `@` agent summon and `/` skill/plugin summon work.
- [ ] ResultOverlay renders Tasks and Memory as widgets, not raw JSON.
- [ ] Quant Lab opens in App Mode.
- [ ] MiroFish risk simulation opens in Debate Arena App Mode with Quant Lab Risk Bridge entrypoints from Top 10 candidates, Top picks batch sandbox runs with Markdown/CSV export, a four-lens Scenario Comparison Matrix with Bull/Bear/Macro drilldowns, scenario presets, Intent Audit replay, evidence archive timeline, replay cards, Current vs Archive comparison, decision audit trail records, in-arena Decision Timeline, pinned decision baselines, audit-enriched baseline drift alerts with severity scoring plus drilldown explanations, user-triggered Audit Snapshot Export to Markdown, and a read-only Audit Snapshot Gallery with portable state import/export, local hide/restore retention controls, direct snapshot Replay source tags, replay delta badges, persistent pinned snapshot baseline, remembered gallery state, keyboard navigation, compare mode, compare Markdown export, indexed compare reports, search/category/action/drift/date filters, indexed batch exports, and sortable inline CSV table preview.
- [ ] LifeOS opens in App Mode.
- [ ] Closing App Mode returns to the clean Aurora launcher.
- [ ] Hub/Proxy remains Advanced Console only.

## Governance Gates

- [ ] L3 tools trigger Governance approval.
- [ ] L4 terminal/bash/file-write actions trigger locked approval.
- [ ] Rejected tools inject `System: Tool execution rejected by user.` back into context.
- [ ] Memory proposals enter Memory Review Queue and do not silently write long-term memory.
- [ ] Intent Audit records fallback, completion, approval, rejection, App Mode launch, generated widget load, and memory proposal flows.

## Vibe Coding Gates

- [ ] Build Mode calls `/api/aurora/vibe-build`.
- [ ] Security findings block before Step 8 approval.
- [ ] Generated component paths are restricted to `packages/client/src/components/generated/{WidgetName}.vue`.
- [ ] Step 8 cannot advance without explicit approve or reject.
- [ ] Approve calls `/api/aurora/vibe-apply`.
- [ ] Reject injects the rejection system message and does not call apply.
- [ ] Broken or missing generated widgets render a clean failure card.

## Legacy Preservation Gates

- [ ] No Hermes backend API route was deleted or disabled.
- [ ] No Socket.IO chat streaming path was replaced.
- [ ] Advanced Console can still reveal legacy Hermes workbench.
- [ ] Legacy Kanban, Memory, Models, Files, Jobs, Logs, Usage, Settings, and Gateways remain reachable through Advanced Console or App Mode.
- [ ] Existing login/auth flow still works.
- [ ] Manual legacy regression pass in `docs/aurora-legacy-regression-checklist.md` is completed or skipped items have owners.

## Release Artifacts

- [ ] PR description uses `.github/pull_request_template.md`.
- [ ] `docs/aurora-release-runbook.md` has been followed from preflight through release gate.
- [ ] `docs/aurora-v0.1-rc-pr.md` is updated as the release-candidate PR draft.
- [ ] `docs/aurora-commit-plan.md` has been used to split the dirty worktree into intentional commit groups.
- [ ] `.github/workflows/aurora-release-gate.yml` has passed with `acknowledge_large_chunks=true`.
- [ ] Playwright report is attached or available from CI for release candidate review.
- [ ] Build output artifact is available from the release gate workflow.
- [ ] `docs/aurora-v0.1-release-notes.md` is updated for the release candidate.
- [ ] `docs/aurora-release-readiness-audit.md` is updated with the latest go/no-go decision.
- [ ] `docs/aurora-legacy-regression-checklist.md` is updated with final manual sign-off status.
- [ ] `docs/aurora-known-risks-and-followups.md` is linked from the release PR and P1 items have owners.
- [ ] Release notes mention newly wrapped Aurora surfaces.
- [ ] Release notes explicitly mention preserved Hermes legacy routes and backend behavior.
- [ ] Known large chunk warnings are listed with follow-up ownership.

## Go / No-Go

Go only if:

- [ ] Required commands pass.
- [ ] Functional, governance, Vibe Coding, and legacy preservation gates are checked.
- [ ] Any skipped item has a written owner and follow-up issue.

No-Go if:

- [ ] Aurora can expose raw terminal/bash execution without approval.
- [ ] Memory can be silently written without review.
- [ ] App Mode opens the legacy sidebar unexpectedly.
- [ ] Unknown prompts fail instead of falling back to Hermes chat.
- [ ] Vibe Coding can write outside `packages/client/src/components/generated/`.
