# Aurora OS v0.1 Legacy Regression Checklist

Date: 2026-05-29
Scope: Manual Hermes Web UI regression pass before final Aurora OS v0.1 tag.

## Purpose

Aurora OS is a wrapper layer over Hermes Web UI, not a replacement for the Hermes engine. This checklist verifies that the legacy workbench still works after Aurora shell, App Mode, governance, widgets, and Vibe Coding have been added.

Run this checklist after the local automated gates pass and before creating the final `v0.1` tag.

## Preconditions

- Local server is running at `http://localhost:5173/`.
- User can log in through the normal Hermes auth flow.
- Aurora default route opens `/hermes/chat`.
- Advanced Console starts closed in Aurora mode.
- The final RC branch has already passed:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
npm run test:aurora
npm run build
```

## Sign-Off Summary

| Area | Status | Notes |
| --- | --- | --- |
| Auth and session | Not run |  |
| Chat stream | Not run |  |
| Advanced Console | Not run |  |
| Files | Not run |  |
| Settings and profiles | Not run |  |
| Gateways and models | Not run |  |
| Terminal safety | Not run |  |
| Kanban and tasks | Not run |  |
| Memory | Not run |  |
| Quant Lab | Not run |  |
| MiroFish Arena | Not run |  |
| LifeOS | Not run |  |
| Logs, usage, jobs | Not run |  |

## 1. Auth and Session

- [ ] Open `/#/`.
- [ ] Log in with the expected password or access token flow.
- [ ] Confirm successful redirect to `/#/hermes/chat`.
- [ ] Refresh the page.
- [ ] Confirm the session persists or fails gracefully according to the configured auth mode.
- [ ] Log out from the user menu or legacy console.
- [ ] Confirm the login screen appears again.

Expected result: login/logout behavior remains unchanged by Aurora.

## 2. Core Chat Stream

- [ ] Open `/#/hermes/chat`.
- [ ] Keep Advanced Console closed.
- [ ] Send a normal prompt that should not match Aurora tools.
- [ ] Confirm it falls back to the standard Hermes chat stream.
- [ ] Confirm streaming text appears incrementally and the input does not lock permanently.
- [ ] Refresh after the response.
- [ ] Confirm recent session/history remains recoverable.

Expected result: normal Hermes Socket.IO/API chat remains the fallback path.

## 3. Advanced Console

- [ ] Click the Aurora Advanced Console toggle.
- [ ] Confirm the legacy Hermes sidebar appears.
- [ ] Navigate between Dialogues, History, Search, Tasks, Kanban, Skills, Plugins, Memory, Models, Logs, Usage, Settings, and Gateways where available.
- [ ] Close Advanced Console.
- [ ] Confirm Aurora returns to the clean shell without losing the active chat session.
- [ ] Refresh while Advanced Console is closed.
- [ ] Confirm it stays closed.

Expected result: legacy navigation remains available but does not leak into the default Aurora shell.

## 4. Files

- [ ] Open the legacy Files surface through Advanced Console.
- [ ] Browse a safe workspace directory.
- [ ] Open a text file.
- [ ] Confirm markdown/code rendering still works.
- [ ] Test file context menu visibility.
- [ ] Avoid destructive write/delete checks unless the RC owner explicitly approves a test fixture.

Expected result: Files UI remains usable and does not conflict with Aurora overlays.

## 5. Settings and Profiles

- [ ] Open Settings.
- [ ] Open Profiles if enabled.
- [ ] Confirm settings render without blank panels or console errors.
- [ ] Change only a reversible non-critical setting.
- [ ] Refresh and confirm the UI remains stable.

Expected result: legacy settings and profiles remain reachable and stable.

## 6. Gateways and Models

- [ ] Open Models.
- [ ] Confirm active model is visible.
- [ ] Open Gateways.
- [ ] Confirm configured gateway list/status renders.
- [ ] Return to Aurora top bar.
- [ ] Confirm the top bar model/status display still matches the active configuration.

Expected result: Aurora top bar reflects Hermes state without breaking legacy model/gateway management.

## 7. Terminal Safety

- [ ] Trigger or inspect a terminal/bash-style action from the chat surface.
- [ ] Confirm L4 approval modal appears before execution.
- [ ] Reject the action.
- [ ] Confirm the chat context receives `System: Tool execution rejected by user.`
- [ ] Confirm no raw command output or raw JSON leaks into the visible chat bubble.

Expected result: terminal and bash paths remain governed by Approval Gateway.

## 8. Kanban and Tasks

- [ ] Open Kanban through Advanced Console.
- [ ] Confirm board/task data loads.
- [ ] From Aurora OmniBar, ask for today's tasks.
- [ ] Confirm the result renders as an Aurora task widget instead of raw JSON.
- [ ] Dismiss the widget and reopen Advanced Console.
- [ ] Confirm Kanban still renders.

Expected result: Kanban remains a legacy app and also works through Aurora widgetization.

## 9. Memory

- [ ] Open Memory through Advanced Console.
- [ ] Confirm existing memory/search UI renders.
- [ ] From Aurora OmniBar, run a memory search intent.
- [ ] Confirm Memory result renders as an Aurora memory widget.
- [ ] Trigger a memory proposal flow.
- [ ] Confirm it enters Memory Review Queue instead of silently saving.
- [ ] Test Approve, Edit, and Discard on a non-sensitive candidate.

Expected result: memory reads still work, and writes require human review.

## 10. Quant Lab

- [ ] From Aurora OmniBar, type a Quant Lab intent such as `Quant Lab today top 10`.
- [ ] Confirm Quant Lab opens in App Mode, not Advanced Console.
- [ ] Close App Mode.
- [ ] Confirm Aurora returns to the clean launcher.
- [ ] Open Quant Lab through Advanced Console if available.
- [ ] Confirm the legacy Quant Lab view still renders.

Expected result: Quant Lab works as both an Aurora App Mode surface and a preserved legacy view.

## 11. MiroFish Arena

- [ ] From Aurora OmniBar, type a MiroFish intent such as `風險推演 NVDA`.
- [ ] Confirm MiroFish Arena opens in App Mode, not Advanced Console.
- [ ] Confirm Macro, Bull, Bear, and Final Verdict panels render.
- [ ] From Quant Lab Top 10, confirm the batch Risk Bridge opens MiroFish Arena and runs the top candidates with `submitBackend: false`.
- [ ] Confirm completed batch Risk Bridge results can export both Markdown and CSV into `trading-journal` without submitting real trades.
- [ ] Confirm scenario presets can run Base, Bull Shock, Bear Shock, and Macro Stress with `submitBackend: false`.
- [ ] Confirm Scenario Matrix cards open Bull/Bear/Macro drilldowns without sending another backend request.
- [ ] Confirm Evidence Archive timeline loads prior MiroFish runs and can switch selected archive.
- [ ] Confirm selected archives render Macro Replay, Bull Replay, Bear Replay, and Synthesizer Replay cards.
- [ ] Confirm Current vs Archive comparison shows action, confidence, risk multiplier, and top signal deltas.
- [ ] Confirm Intent Audit records the MiroFish decision delta and exposes the comparison payload.
- [ ] Confirm Intent Audit Detail can replay the MiroFish record back into Arena App Mode.
- [ ] Confirm Decision Timeline shows recent MiroFish audit records inside the Arena.
- [ ] Confirm a Decision Timeline record can be pinned as the baseline and compared against the current simulation.
- [ ] Confirm Baseline Drift Alerts report either drift signals or an aligned baseline state with a 0-100 severity score, per-factor drilldown, and matching Intent Audit payload.
- [ ] Confirm Replay Arena can export a user-triggered Markdown Audit Snapshot with frontmatter, current decision, baseline drift, drift contributions, scenario matrix, and raw audit payload.
- [ ] Confirm Audit Snapshot Gallery loads exported `mirofish-audit-*.md` notes from `trading-journal`, previews the Markdown replay, and refreshes without submitting a new MiroFish run.
- [ ] Confirm Audit Snapshot Gallery can replay a selected `mirofish-audit-*.md` note directly into the Arena Audit Replay card without submitting a new MiroFish run.
- [ ] Confirm replayed Audit Snapshot cards show source tags and delta badges for the restored snapshot/report context.
- [ ] Confirm Audit Snapshot Gallery indexes `mirofish-batch-*.md` and `mirofish-batch-*.csv` exports, classifies them as Batch entries, renders CSV exports as a sortable inline table, and can search/preview them without enabling compare or pin controls.
- [ ] Confirm Audit Snapshot Gallery advanced filters can narrow entries by action, drift severity, and date without submitting a new MiroFish run.
- [ ] Confirm Audit Snapshot Gallery compare mode can select two exported snapshots and compare signal, action, confidence, risk, drift, and summary without submitting a new MiroFish run.
- [ ] Confirm Audit Snapshot Gallery compare mode can export a Markdown compare report to `trading-journal` without submitting a new MiroFish run.
- [ ] Confirm Audit Snapshot Gallery indexes exported `mirofish-compare-*.md` reports as Compare entries for search and preview, without exposing Replay, Pin, or Compare controls on those report entries.
- [ ] Confirm Audit Snapshot Gallery can locally hide and restore entries without deleting files from `trading-journal`.
- [ ] Confirm Audit Snapshot Gallery can export/import portable state JSON for search, filters, hidden entries, selected preview, and pinned snapshot without backend writes.
- [ ] Confirm Audit Snapshot Gallery supports keyboard navigation for preview selection and can close with `Esc`.
- [ ] Confirm Audit Snapshot Gallery remembers search, filters, and selected preview across Arena reopen/reload cycles.
- [ ] Confirm an Audit Snapshot can be pinned as the persistent baseline, survives local UI state reloads, and automatically becomes the compare target when another snapshot is selected.
- [ ] Confirm the app uses sandbox mode and does not execute real trades.
- [ ] Close App Mode.
- [ ] Confirm Aurora returns to the clean launcher.

Expected result: MiroFish inference output is visualized as an Aurora Debate Arena without exposing raw JSON.

## 12. LifeOS

- [ ] From Aurora OmniBar, type a LifeOS intent such as `打開 LifeOS`.
- [ ] Confirm LifeOS opens in App Mode, not Advanced Console.
- [ ] Close App Mode.
- [ ] Confirm Aurora returns to the clean launcher.
- [ ] Open LifeOS through Advanced Console if available.
- [ ] Confirm the legacy LifeOS view/state remains readable.

Expected result: LifeOS is launched through Hermes-backed commands and wrappers, not a separate `LifeOS.app`.

## 13. Logs, Usage, and Jobs

- [ ] Open Logs through Advanced Console.
- [ ] Confirm recent entries render.
- [ ] Open Usage.
- [ ] Confirm counters or usage panels render.
- [ ] Open Jobs/Tasks if enabled.
- [ ] Confirm no blank screen or route crash.

Expected result: operational legacy surfaces remain available for diagnosis.

## 14. Hub/Proxy Boundary

- [ ] Search for Hub/Proxy or `中轉站` from Aurora OmniBar.
- [ ] Confirm it does not open in Aurora App Mode.
- [ ] Open Advanced Console.
- [ ] Confirm Hub/Proxy remains legacy-console only if present.

Expected result: Hub/Proxy stays outside the Aurora default UI.

## Final Manual Decision

Mark RC as ready for final tag only if:

- [ ] All critical legacy areas above pass or have a written owner.
- [ ] Any skipped destructive operation is explicitly marked as skipped.
- [ ] Any failure has a linked follow-up issue.
- [ ] The GitHub release gate has passed with `acknowledge_large_chunks=true`.
