# Aurora OS v0.1 Release Notes

Date: 2026-05-28
Status: Draft release notes for the Aurora OS v0.1 release candidate.

## Summary

Aurora OS v0.1 introduces an intent-first operating layer on top of Hermes Web UI. The release keeps Hermes as the underlying engine while moving day-to-day interaction into a cleaner Aurora shell with OmniBar routing, native widgets, immersive App Mode, governed approvals, memory review, Vibe Coding, and release validation gates.

## Highlights

- Aurora idle shell with centered OmniBar, glass UI, trust rail, top bar, and minimal app launcher.
- Advanced Console hides the legacy Hermes sidebar by default while preserving access to the full workbench.
- Commander routes natural-language intents through ToolRegistry and falls back to normal Hermes chat when no Aurora tool matches.
- Structured legacy outputs render as Aurora widgets instead of raw JSON:
  - Kanban tasks render as a task widget.
  - Memory search renders as snippets with source and confidence.
  - Quant Lab renders metric widgets and can expand into App Mode.
  - LifeOS renders financial dashboard widgets and can expand into App Mode.
- Immersive App Mode wraps Hermes views without showing the legacy sidebar.
- MiroFish multi-agent sandbox opens as an Aurora Debate Arena with Macro, Bull, Bear, Hermes Synthesizer panels, Quant Lab Risk Bridge entrypoints from Top 10 candidates, Top picks batch sandbox runs with Markdown/CSV export, a four-lens Scenario Comparison Matrix with Bull/Bear/Macro drilldowns, scenario presets, audit replay from Intent Audit, an evidence archive timeline, archive replay cards, Current vs Archive comparison, decision audit trail records, an in-arena Decision Timeline view, pinned decision baselines, audit-enriched baseline drift alerts with severity scoring plus drilldown explanations, explicit Audit Snapshot Export to Markdown, and a read-only Audit Snapshot Gallery with portable state import/export, local hide/restore retention controls, direct snapshot Replay source tags, replay delta badges, persistent pinned baseline, remembered gallery state, keyboard navigation, compare mode, compare Markdown export, indexed compare reports, search/category/action/drift/date filters, indexed batch Markdown/CSV exports, and sortable inline CSV table preview.
- Memory Governance queues candidate memories for approve/edit/discard instead of silently writing long-term memory.
- L3/L4 Governance and Approval flows pause risky actions, record audit events, and inject rejection context back to the chat.
- Vibe Coding Build Mode uses real build/apply endpoints, blocks unsafe code, and writes only to `packages/client/src/components/generated/`.
- Generated widget loader renders safe generated Vue widgets and shows clean failure cards for missing or broken widgets.
- Aurora validation scripts, CI smoke workflow, PR checklist, release checklist, and release gate workflow are in place.

## Preserved Hermes Behavior

- No legacy Hermes backend API route is intentionally removed or disabled.
- Core Socket.IO chat streaming remains the fallback path for normal Hermes chat.
- Advanced Console still exposes legacy Hermes workbench surfaces.
- Kanban, Memory, Files, Jobs, History, Models, Profiles, Channels, Group Chat, Gateways, Logs, Usage, Skills, Plugins, Code Intelligence, System Status, and Settings remain reachable through Advanced Console or App Mode.
- Hub/Proxy stays excluded from Aurora App Mode and remains Advanced Console only.
- Existing auth/login flow remains outside the Aurora shell refactor.

## Validation

Required local release commands:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
npm run test:aurora
npm run build
```

Current expected baseline:

- Aurora unit smoke: 77 tests.
- Aurora Playwright smoke: 29 tests.
- Production build: passes.
- Known warning: Vite/Rolldown large chunk warning remains and must be acknowledged before release.

GitHub workflows:

- `.github/workflows/aurora-smoke.yml` runs focused Aurora validation for PRs, schedules, and manual smoke.
- `.github/workflows/aurora-release-gate.yml` runs manual release validation and uploads Playwright/build artifacts.

Readiness audit:

- `docs/aurora-release-runbook.md` describes the full operational path from local integration to final tag.
- `docs/aurora-release-readiness-audit.md` records the RC go/no-go decision, gate assessment, and remaining artifact requirements.
- `docs/aurora-v0.1-rc-pr.md` provides a release-candidate PR draft aligned with the validation and release gate requirements.
- `docs/aurora-legacy-regression-checklist.md` tracks the manual Hermes legacy regression pass required before final tag.
- `docs/aurora-known-risks-and-followups.md` tracks accepted v0.1 risks and post-release owners.

## Known Risks

- Large production chunks remain, especially Monaco, Mermaid, and other heavyweight vendor bundles.
- Vibe Coding generated widgets are safely written and loadable, but richer lifecycle management such as rollback, signing, and versioned gallery metadata is not complete.
- Some legacy views are wrapped in App Mode but still visually carry legacy UI density inside the window.
- Aurora command routing is keyword/parser based and should continue gaining parser fixtures as new natural-language routes are added.
- The full risk register and post-v0.1 follow-up list is tracked in `docs/aurora-known-risks-and-followups.md`.

## Next Version Candidates

- Split heavyweight chunks and lazy-load more deep-work modules.
- Add signed generated-widget manifest and rollback affordances.
- Expand App Mode bridge briefs for remaining legacy apps.
- Add richer release artifact summaries from CI.
- Continue migrating stable legacy JSON responses into native Aurora presenters.

## Release Gate

Before tagging v0.1:

- Follow `docs/aurora-release-runbook.md`.
- Complete `docs/aurora-release-checklist.md`.
- Complete `docs/aurora-legacy-regression-checklist.md` or assign owners for skipped items.
- Confirm `docs/aurora-known-risks-and-followups.md` has no active P0 items and P1 items have owners.
- Run `.github/workflows/aurora-release-gate.yml` with `acknowledge_large_chunks=true`.
- Attach or link the Playwright report and build artifact.
- Confirm any skipped checklist item has an owner and follow-up issue.
