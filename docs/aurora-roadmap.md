# Aurora OS Roadmap

Date: 2026-05-28
Scope: Progressive fusion of Hermes Web UI into Aurora OS without deleting legacy capabilities.

## North Star

Aurora OS is the intent-first operating layer. Hermes remains the powerful engine underneath it. The migration is successful when users can reach Hermes capabilities through a clean Aurora launcher, native widgets, App Mode, and governed tool execution while legacy routes and backend APIs remain intact.

## Current Baseline

- Aurora idle shell, OmniBar, top bar, trust rail, and floating navigation are in place.
- Advanced Console hides the legacy Hermes sidebar by default.
- Commander, ToolRegistry, capability manifest, result presenters, and intent parsers are separated.
- L3/L4 approval and Memory Governance prevent silent high-risk actions.
- Quant Lab, MiroFish Arena, LifeOS, Kanban, Models, Group Chat, Channels, Memory, and generated widgets have Aurora-facing paths.
- `npm run test:aurora:unit`, `npm run test:aurora`, and `.github/workflows/aurora-smoke.yml` provide validation coverage.

## Phase 1: Core Shell Hardening

Goal: Make Aurora feel like the default product surface, with Hermes available only when explicitly opened.

Tasks:

- Keep Advanced Console closed by default across reloads and App Mode transitions.
- Preserve active chat sessions, socket streams, model selection, and memory queues while toggling shell states.
- Keep Hub/Proxy strictly in Advanced Console.
- Continue reducing shell-level layout edge cases on small screens.

Acceptance:

- `tests/e2e/aurora-os.spec.ts` covers idle, active chat, Advanced Console, top bar, command palettes, and fallback chat.
- Reload and App Mode close cycles keep Advanced Console closed and do not reveal the legacy sidebar.
- No legacy sidebar appears during Aurora idle, ResultOverlay, or App Mode flows.

## Phase 2: Legacy Widgetization

Goal: Replace raw legacy JSON/text outputs with Aurora-native cards.

Tasks:

- Keep Tasks and Memory as lightweight ResultOverlay widgets.
- Add more presenter templates only when a legacy output has stable structured data.
- Prefer compact widgets for quick answers and App Mode for deep work.
- Add parser and presenter regression tests for every new widget route.

Acceptance:

- `tests/client/aurora-result-presenters.test.ts` covers Tasks, Memory, Quant, LifeOS, generated widgets, app launches, and unknown-tool fallback behavior.
- Known structured outputs never render as raw JSON in the normal chat stream.
- Unknown outputs still degrade gracefully to Hermes chat or a clean Aurora error card.

## Phase 3: Immersive App Mode

Goal: Treat heavy Hermes modules as full-screen Aurora apps instead of sidebar destinations.

Tasks:

- Keep Quant Lab and LifeOS in App Mode.
- Keep MiroFish multi-agent simulations in a dedicated Debate Arena App Mode with Quant Lab Risk Bridge entrypoints from Top 10 candidates, Top picks batch sandbox runs with Markdown/CSV export, a four-lens Scenario Comparison Matrix with Bull/Bear/Macro drilldowns, scenario presets, Intent Audit replay, evidence archive timeline, replay cards, Current vs Archive comparison, decision audit trail records, in-arena Decision Timeline, pinned decision baselines, audit-enriched baseline drift alerts with severity scoring plus drilldown explanations, user-triggered Audit Snapshot Export to Markdown, and a read-only Audit Snapshot Gallery with portable state import/export, local hide/restore retention controls, direct snapshot Replay source tags, replay delta badges, persistent pinned snapshot baseline, remembered gallery state, keyboard navigation, two-snapshot compare mode, compare Markdown export, indexed compare reports, search/category/action/drift/date filters, indexed batch Markdown/CSV exports, and sortable inline CSV table preview.
- Move Kanban, Models, Group Chat, Channels, Memory, System Status, and Code Intelligence into the same App Mode pattern where useful.
- Add app-specific bridge briefs so users understand what opened without exposing raw legacy UI noise first.
- Keep close/minimize behavior returning to the pristine launcher.

Acceptance:

- `tests/client/aurora-app-mode-contract.test.ts` verifies App Mode registry metadata, component loaders, launcher entries, intent routing, and Advanced Console isolation.
- Opening heavy apps never flips `isAdvancedConsoleOpen` to true.
- App Mode wrappers preserve each legacy component's existing data flow and backend routes.

## Phase 4: Governance And Safety

Goal: Make Aurora safe by construction, not by convention.

Tasks:

- Keep terminal/bash/file-write actions behind L4 approval.
- Keep create/update legacy actions at L3 unless proven harmless.
- Keep read-only adapters at L1.
- Expand audit events for approvals, rejections, App Mode launches, generated widget loads, and memory proposals.
- Ensure rejected tools write an explicit system result back to the agent context.

Acceptance:

- `tests/client/aurora-audit-events.test.ts` covers fallback, App Mode launches, generated widget loads, memory proposals, approval lifecycle, rejection audit, and rejected-tool context injection.
- No raw terminal or bash execution can happen from Aurora without a visible approval path.
- Memory writes remain candidate-first unless a user explicitly approves them.

## Phase 5: Vibe Coding Loop

Goal: Turn Build Mode into a safe local development assistant.

Tasks:

- Keep generated files restricted to `packages/client/src/components/generated/`.
- Keep code scanning before apply.
- Improve generated widget discovery, naming, previews, and rollback affordances.
- Add a lightweight generated-widget gallery in Aurora.
- Consider a signed manifest for generated widgets before allowing richer runtime behavior.

Acceptance:

- `tests/client/aurora-vibe-coding-store.test.ts` covers generated path isolation, security scan blocking, L4 approval, safe apply payloads, and rejection context injection.
- Unsafe generated code is rejected before write.
- Broken generated widgets render a clean failure card instead of crashing Aurora.

## Phase 6: Release And Operations

Goal: Make Aurora changes shippable and reviewable.

Tasks:

- Use `docs/aurora-validation.md` for every integration PR.
- Use `docs/aurora-release-checklist.md` before v0.1 release candidates.
- Keep `.github/pull_request_template.md` aligned with the validation flow.
- Run `.github/workflows/aurora-release-gate.yml` before v0.1 release candidates.
- Run full Aurora browser smoke before tagging v0.1 milestones.
- Track large bundle warnings and split heavyweight modules where it improves startup.
- Keep release notes explicit about preserved Hermes routes and newly wrapped Aurora surfaces.

Acceptance:

- Aurora PRs include machine validation and human checklist evidence.
- v0.1 release gates are captured in `docs/aurora-release-checklist.md`.
- Manual release gate workflow captures full Aurora smoke, production build, Playwright report, and dist artifact.
- v0.1 release candidates can be reproduced with documented commands.

## Execution Rule

When choosing the next task, prefer the earliest phase with an incomplete acceptance criterion. If multiple tasks are equally urgent, choose the one that reduces security risk or regression risk first.
