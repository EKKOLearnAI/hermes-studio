# Aurora OS v0.1 Commit Plan

Date: 2026-05-29
Scope: Suggested commit slicing for the Aurora OS v0.1 release-candidate PR.

## Goal

Split the current Aurora OS integration into reviewable commits that preserve Hermes Web UI as the underlying engine. The plan prioritizes clear ownership, isolated rollback points, and validation after each functional layer.

## Ground Rules

- Do not stage the entire worktree with `git add .`.
- Review `git status --short` before every commit.
- Keep generated or runtime directories out of the release commit unless they are explicitly intended artifacts.
- Do not mix unrelated Hermes legacy fixes with Aurora shell changes unless a dependency requires it.
- Run the validation command listed for each group before moving to the next group.

Potentially risky paths to inspect before staging:

- `.runtime/`
- `build/`
- `data/`
- `dist/`
- ad hoc generated files outside `packages/client/src/components/generated/`

## Proposed Commit Groups

### 1. Aurora Shell and UI Composition

Purpose: Introduce the Aurora skin without deleting Hermes UI.

Candidate paths:

- `packages/client/src/App.vue`
- `packages/client/src/views/hermes/ChatView.vue`
- `packages/client/src/components/layout/AppSidebar.vue`
- `packages/client/src/components/hermes/chat/ChatInput.vue`
- `packages/client/src/components/hermes/chat/ChatPanel.vue`
- `packages/client/src/components/hermes/chat/MessageItem.vue`
- `packages/client/src/components/hermes/aurora/`
- `packages/client/src/stores/hermes/app.ts`
- `packages/client/src/i18n/locales/en.ts`
- `packages/client/src/i18n/locales/zh.ts`
- `packages/client/src/i18n/locales/zh-TW.ts`

Validation:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
```

### 2. Commander, Tool Registry, and Intent Routing

Purpose: Add natural-language routing while preserving Hermes chat fallback.

Candidate paths:

- `packages/client/src/services/hermes/aurora/`
- `packages/client/src/stores/hermes/aurora-commander.ts`
- `packages/client/src/stores/hermes/aurora-app-window.ts`
- `packages/client/src/stores/hermes/aurora-intent-audit.ts`
- `packages/client/src/api/hermes/life-os.ts`
- `packages/client/src/api/hermes/quant-lab.ts`
- `packages/client/src/api/hermes/system-status.ts`
- `packages/client/src/api/hermes/nexus.ts`
- `packages/client/src/router/index.ts`
- `packages/client/src/composables/useAuroraAppBrief.ts`

Validation:

```bash
npm run test:aurora:unit
```

### 3. Governance, Approval, and Memory Review

Purpose: Add L1-L4 safety, approval modals, rejection context, and memory review without silent writes.

Candidate paths:

- `packages/client/src/components/hermes/chat/ApprovalModal.vue`
- `packages/client/src/stores/hermes/aurora-governance.ts`
- `packages/client/src/stores/hermes/memory-queue.ts`
- `packages/server/src/services/hermes/approval-gateway.ts`
- `packages/server/src/routes/hermes/terminal.ts`
- `packages/server/src/services/hermes/run-chat/`
- `packages/server/src/services/hermes/agent-bridge/hermes_bridge.py`

Validation:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
```

### 4. Result Widgets and Immersive App Mode

Purpose: Replace raw structured output with Aurora widgets and full-screen App Mode wrappers.

Candidate paths:

- `packages/client/src/components/hermes/aurora/`
- `packages/client/src/views/hermes/LifeOSView.vue`
- `packages/client/src/views/hermes/QuantLabView.vue`
- `packages/client/src/views/hermes/SystemStatusView.vue`
- `packages/client/src/components/hermes/quant-lab/`
- `packages/client/src/composables/useQuantSocket.ts`
- `packages/client/src/utils/preload-heavy-modules.ts`

Validation:

```bash
npm run test:aurora:unit
```

### 5. Vibe Coding and Generated Widget Runtime

Purpose: Commit the real build/apply loop, security scanner, generated component safety, and dynamic loader.

Candidate paths:

- `packages/client/src/api/aurora/`
- `packages/client/src/components/hermes/vibe-coding/`
- `packages/client/src/components/generated/`
- `packages/client/src/stores/hermes/vibe-coding.ts`
- `packages/server/src/routes/aurora/`
- `packages/server/src/services/hermes/dynamic-llm.ts`

Validation:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
```

### 6. Legacy Backend Bridges and Operational Helpers

Purpose: Add read-only or wrapper-style Hermes bridge endpoints needed by Aurora without removing legacy APIs.

Candidate paths:

- `packages/server/src/routes/hermes/life-os.ts`
- `packages/server/src/routes/hermes/quant-lab.ts`
- `packages/server/src/routes/hermes/quant-lab-stream.ts`
- `packages/server/src/routes/hermes/system-status.ts`
- `packages/server/src/routes/hermes/nexus.ts`
- `packages/server/src/controllers/hermes/system-status.ts`
- `packages/server/src/services/hermes/quant-lab/`
- `packages/server/src/services/TelegramNotifier.ts`
- `packages/server/src/services/debateService.ts`
- `packages/server/src/services/miroFishService.ts`
- `packages/server/src/services/obsidianService.ts`
- `packages/server/src/services/openClawService.ts`
- `scripts/hermes-lifeos-state`
- `scripts/hermes-quant-health`
- `scripts/hermes-quant-top10`
- `scripts/hermes-webui-api`
- `scripts/hermes-workspace-health`
- `scripts/hermes_memory_sync.sh`
- `scripts/hermes_memory_sync_setup.sh`
- `scripts/hermes_quant_lab_brief.py`
- `scripts/hermes_quant_lab_phase_check.py`
- `scripts/hermes_quant_lab_weekly.py`
- `scripts/macos/`

Validation:

```bash
npx vue-tsc -b --pretty false
npm run build
```

### 7. Hermes Compatibility Fixes

Purpose: Commit any compatibility fixes that were needed to keep old Hermes behavior stable during Aurora integration.

Candidate paths:

- `packages/client/src/api/hermes/download.ts`
- `packages/client/src/api/hermes/profiles.ts`
- `packages/client/src/components/hermes/chat/FilesPanel.vue`
- `packages/client/src/components/hermes/chat/MarkdownRenderer.vue`
- `packages/client/src/components/hermes/chat/TerminalPanel.vue`
- `packages/client/src/components/hermes/files/`
- `packages/client/src/views/hermes/FilesView.vue`
- `packages/client/src/views/hermes/HistoryView.vue`
- `packages/server/src/controllers/hermes/profiles.ts`
- `packages/server/src/controllers/hermes/sessions.ts`
- `packages/server/src/db/hermes/sessions-db.ts`
- `packages/server/src/lib/context-compressor/`
- `packages/server/src/routes/hermes/download.ts`
- `packages/server/src/routes/hermes/profiles.ts`
- `packages/server/src/services/hermes/gateway-manager.ts`
- `packages/server/src/index.ts`
- `packages/server/src/routes/index.ts`

Validation:

```bash
npm run test:aurora:unit
npm run build
```

### 8. Tests, CI, and Release Documentation

Purpose: Commit the release confidence layer separately from runtime code.

Candidate paths:

- `.github/pull_request_template.md`
- `.github/workflows/aurora-smoke.yml`
- `.github/workflows/aurora-release-gate.yml`
- `package.json`
- `tests/client/aurora-*.test.ts`
- `tests/e2e/aurora-os.spec.ts`
- `tests/e2e/fixtures.ts`
- `tests/e2e/chat-streaming.spec.ts`
- `tests/server/context-compressor.test.ts`
- `docs/aurora-*.md`
- `AGENTS.md`

Validation:

```bash
npm run test:aurora
npm run build
```

## Final RC Validation

After all commit groups are staged and committed:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
npm run test:aurora
npm run build
```

Expected result:

- 75 Aurora unit tests pass.
- 28 Aurora Playwright tests pass.
- TypeScript project check passes.
- Production build passes with the known large chunk warning acknowledged.

## Suggested PR Order

1. Open the RC PR with the commits above in order.
2. Use `docs/aurora-v0.1-rc-pr.md` as the PR body source.
3. Run the GitHub Aurora smoke workflow.
4. Run the manual release gate with `acknowledge_large_chunks=true`.
5. Attach or link the Playwright report and build artifact.
6. Tag `v0.1` only after the release gate passes and skipped checklist items have owners.
