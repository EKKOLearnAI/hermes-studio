# Aurora OS Validation Flow

Date: 2026-05-28
Scope: Hermes Web UI gradually wrapped by the Aurora OS operating layer.

## Purpose

This document defines the repeatable validation flow for every Hermes-to-Aurora integration step. Use it before and after changing Aurora intent routing, security governance, ResultOverlay widgets, App Mode wrappers, generated widgets, or legacy adapters.

The implementation sequence is tracked in `docs/aurora-roadmap.md`.
Release readiness is tracked in `docs/aurora-release-checklist.md`.

## Command Order

1. Fast Aurora unit validation:

   ```bash
   npm run test:aurora:unit
   ```

   Covers intent parsing, capability registration, and memory governance store behavior.

2. Full Aurora browser smoke:

   ```bash
   npm run test:aurora
   ```

   Runs the Aurora unit set first, then the Playwright Aurora OS suite.

3. Type and production build validation:

   ```bash
   npx vue-tsc -b --pretty false
   npm run build
   ```

   Use this before tagging, committing, or handing off a production-ready MVP checkpoint.

## CI Coverage

Aurora has a focused GitHub Actions workflow in `.github/workflows/aurora-smoke.yml`.

- Pull requests run `npm run test:aurora:unit` and `npx vue-tsc -b --pretty false` when Aurora, client, server, package, or validation docs change.
- Manual workflow runs can set `full_e2e` to `true` to run `tests/e2e/aurora-os.spec.ts`.
- The scheduled daily run executes the full Aurora browser smoke and uploads the Playwright report.

Pull requests also use `.github/pull_request_template.md` to require the matching human review checklist.

## Integration Checklist

For every new Aurora-facing capability, confirm these points in order:

1. Capability is listed in `capability-manifest.ts` if it should appear in the command coverage matrix.
2. Tool is registered in `tool-definitions.ts` with the correct security level.
3. Natural-language matching is isolated in `intent-parsers.ts` and covered by `aurora-intent-parsers.test.ts`.
4. Structured output has a presenter in `result-presenters.ts` or a deliberate App Mode route.
5. Heavy legacy views open through `AppWindowOverlay.vue`, not the Advanced Console.
6. Hub/Proxy remains excluded from Aurora App Mode.
7. L3/L4 actions cannot bypass Approval Gateway or Governance confirmation.
8. No raw terminal, bash, or JSON payload leaks into the normal user chat stream.
9. Closing overlays returns to the clean Aurora launcher with `isAdvancedConsoleOpen === false`.
10. Unknown prompts fall back to the standard Hermes chat stream.

## Manual UI Acceptance

Open `/hermes/chat` and confirm:

- Idle screen shows only the Aurora left pill nav, centered OmniBar, tools panel, trust rail, and top bar.
- Legacy Hermes sidebar is hidden until Advanced Console is explicitly opened.
- Cmd+K opens chat history from the OmniBar.
- `@` opens agent summon and `/` opens skill/plugin summon.
- Opening Quant Lab or LifeOS uses App Mode and never reveals the legacy sidebar.
- Closing App Mode returns to the pristine Aurora launcher.
- Memory proposals enter the Memory Review Queue instead of writing directly to legacy memory.
- Rejected tools write a visible rejection result back into context.

## Failure Triage

- Intent parser failure: adjust `intent-parsers.ts` and add a regression case in `aurora-intent-parsers.test.ts`.
- Capability manifest failure: register the app/tool/presenter consistently before touching UI.
- Approval or governance failure: check `aurora-governance.ts`, `ApprovalModal.vue`, and related E2E expectations first.
- App Mode failure: check `aurora-app-window.ts`, `AppWindowOverlay.vue`, and `app-window-registry.ts`.
- Widget rendering failure: check `ResultOverlay.vue`, `WidgetRenderer.vue`, and the presenter type returned by Commander.
- Hermes fallback failure: check `aurora-commander.ts` before changing legacy chat or Socket.IO code.

## Done Criteria

A Hermes feature is considered safely fused into Aurora OS when:

- It is accessible through intent-first Aurora UI.
- It preserves the legacy route or backend implementation.
- It has unit or E2E coverage in the Aurora validation flow.
- It does not expose raw tool payloads to the user.
- It can fail gracefully back to Hermes chat or a clean Aurora error card.
