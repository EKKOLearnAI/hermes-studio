# Aurora OS v0.1 RC PR Draft

## Summary

This PR promotes Aurora OS v0.1 to release-candidate review on top of the existing Hermes Web UI engine.

Aurora OS adds an intent-first operating layer while preserving Hermes as the underlying workbench, backend, socket runtime, and legacy feature surface. The default user experience becomes the Aurora shell, OmniBar, governance overlays, widgets, and App Mode. The legacy Hermes sidebar remains available only through Advanced Console.

## What Changed

- Added the Aurora OS shell with idle launcher, centered OmniBar, trust rail, top bar, and minimal app launcher.
- Added Advanced Console hiding so legacy Hermes remains available without dominating the default UI.
- Added ToolRegistry and Commander routing for Aurora intents with fallback to normal Hermes chat.
- Added ResultOverlay presenters for structured legacy outputs such as Tasks, Memory, Quant Lab, LifeOS, generated widgets, and fallback JSON.
- Added immersive App Mode wrappers for heavy Hermes surfaces without showing the legacy sidebar.
- Added MiroFish Debate Arena App Mode for Macro, Bull, Bear, and Hermes Synthesizer visualization.
- Added governance and approval flows for L3/L4 actions, including terminal/bash rejection context.
- Added Memory Review Queue so long-term memories are proposed before approval.
- Added Vibe Coding build/apply flow with backend security scanning and generated component path restrictions.
- Added dynamic generated-widget loading through Vite-scoped async imports.
- Added Aurora unit tests, Playwright smoke, CI smoke workflow, manual release gate workflow, and release documentation.

## Validation

- [x] `npm run test:aurora:unit`
  - Result: pass, 75 tests.
- [x] `npx vue-tsc -b --pretty false`
  - Result: pass.
- [x] `npm run test:aurora`
  - Result: pass, 75 unit tests and 28 Playwright E2E tests.
- [x] `npm run build`
  - Result: pass with known Vite/Rolldown large chunk warnings.

## Aurora OS Integration Checklist

- [x] Aurora-facing capabilities are registered in `capability-manifest.ts` when they should appear in the coverage matrix.
- [x] Tool definitions use L1-L4 security levels.
- [x] Natural-language routing is isolated in `intent-parsers.ts` and covered by parser tests.
- [x] Structured legacy output renders through ResultOverlay presenters or App Mode, not raw JSON.
- [x] Heavy legacy apps open through App Mode without revealing the Advanced Console.
- [x] Hub/Proxy remains excluded from Aurora App Mode.
- [x] L3/L4 actions require approval and cannot bypass Governance or Approval Gateway.
- [x] Unknown Aurora prompts fall back to the standard Hermes chat stream.
- [x] Legacy Hermes routes, backend APIs, and Socket.IO streaming remain intact.

## Release Gate Before Tagging

Before creating the final `v0.1` tag:

- [ ] Follow `docs/aurora-release-runbook.md`.
- [ ] Run `.github/workflows/aurora-release-gate.yml`.
- [ ] Set `acknowledge_large_chunks=true`.
- [ ] Complete `docs/aurora-legacy-regression-checklist.md` or assign owners for skipped items.
- [ ] Confirm `docs/aurora-known-risks-and-followups.md` has no active P0 risks and P1 follow-ups have owners.
- [ ] Attach or link the Playwright report artifact.
- [ ] Attach or link the build artifact.
- [ ] Confirm any skipped checklist item has an owner and follow-up issue.

## Known Risks

- Large production chunks remain, especially Monaco, Mermaid, and other heavyweight vendor bundles.
- Some legacy views still carry their original dense UI when opened inside App Mode.
- Generated widgets are safely loadable, but signed manifests, rollback, and gallery lifecycle management remain future work.
- Aurora routing is parser/keyword based and needs continued fixture coverage as new commands are added.

## Legacy Preservation Notes

- No Hermes backend API route is intentionally removed or disabled.
- No core Socket.IO chat streaming path is replaced.
- Advanced Console remains the escape hatch for full Hermes Web UI.
- Hub/Proxy remains Advanced Console only.
- Existing auth/login remains outside the Aurora shell refactor.

## Supporting Docs

- `docs/aurora-release-runbook.md`
- `docs/aurora-release-readiness-audit.md`
- `docs/aurora-commit-plan.md`
- `docs/aurora-legacy-regression-checklist.md`
- `docs/aurora-known-risks-and-followups.md`
- `docs/aurora-release-checklist.md`
- `docs/aurora-v0.1-release-notes.md`
- `docs/aurora-validation.md`
- `docs/aurora-roadmap.md`
