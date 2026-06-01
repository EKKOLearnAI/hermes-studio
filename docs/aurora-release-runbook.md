# Aurora OS v0.1 Release Runbook

Date: 2026-05-29
Scope: Operational runbook from current integration state to final Aurora OS v0.1 tag.

## Goal

Move Aurora OS v0.1 from local integration to a reviewed release candidate, then to a final `v0.1` tag only after automated gates, manual Hermes regression, and release artifacts are complete.

## Release Principle

Aurora OS is the intent-first operating layer. Hermes Web UI remains the engine. A release is valid only if Aurora improves the default experience without deleting, disabling, or destabilizing legacy Hermes routes, backend APIs, auth, files, settings, gateways, or chat streaming.

## Phase 0: Preflight

Purpose: Confirm the worktree is understood before any commit or release operation.

Run:

```bash
git status --short
npm run test:aurora:unit
npx vue-tsc -b --pretty false
```

Check:

- [ ] Worktree status has been reviewed.
- [ ] `.runtime/`, `build/`, `data/`, `dist/`, and other generated artifacts are not blindly staged.
- [ ] The Aurora unit suite passes.
- [ ] TypeScript project check passes.

Stop if:

- There are unknown generated files that may contain secrets or local runtime state.
- Unit tests or TypeScript fail.

## Phase 1: Create the RC Branch

Purpose: isolate release work from the current integration branch.

Suggested branch:

```bash
git switch -c release/aurora-v0.1-rc
```

Check:

- [ ] Branch name clearly identifies Aurora v0.1 RC work.
- [ ] No unrelated user changes are reverted.

## Phase 2: Commit in Reviewable Groups

Purpose: convert the dirty worktree into intentional commits.

Use:

- `docs/aurora-commit-plan.md`

Suggested order:

1. Aurora Shell and UI Composition.
2. Commander, Tool Registry, and Intent Routing.
3. Governance, Approval, and Memory Review.
4. Result Widgets and Immersive App Mode.
5. Vibe Coding and Generated Widget Runtime.
6. Legacy Backend Bridges and Operational Helpers.
7. Hermes Compatibility Fixes.
8. Tests, CI, and Release Documentation.

Rules:

- [ ] Use precise `git add <path>` commands.
- [ ] Do not use `git add .`.
- [ ] Run the validation command listed for each commit group.
- [ ] Keep unrelated fixes separate from Aurora runtime changes.

Stop if:

- A commit group cannot pass its listed validation.
- A path looks unrelated to Aurora or legacy compatibility and has no clear owner.

## Phase 3: Full Local RC Validation

Purpose: confirm the complete branch is release-candidate ready.

Run:

```bash
npm run test:aurora:unit
npx vue-tsc -b --pretty false
npm run test:aurora
npm run build
```

Expected:

- [ ] 75 Aurora unit tests pass.
- [ ] 28 Aurora Playwright E2E tests pass.
- [ ] TypeScript project check passes.
- [ ] Production build passes.
- [ ] Vite/Rolldown large chunk warning is recorded as known risk.

Stop if:

- Aurora prompts no longer fall back to Hermes chat.
- App Mode opens Advanced Console unexpectedly.
- Terminal/bash execution bypasses approval.
- Memory can be silently saved without review.
- Vibe Coding can write outside `packages/client/src/components/generated/`.

## Phase 4: Open the RC PR

Purpose: start reviewed release-candidate evaluation.

Use:

- `.github/pull_request_template.md`
- `docs/aurora-v0.1-rc-pr.md`
- `docs/aurora-release-readiness-audit.md`
- `docs/aurora-release-checklist.md`

Check:

- [ ] PR summary explains Aurora as a wrapper layer over Hermes.
- [ ] Validation results are copied into the PR body.
- [ ] Known large chunk warnings are listed.
- [ ] Legacy preservation notes are explicit.
- [ ] Screenshots or recordings are attached for visible UI changes where practical.

## Phase 5: Run GitHub Release Gate

Purpose: produce release artifacts from CI.

Workflow:

- `.github/workflows/aurora-release-gate.yml`

Required input:

- `acknowledge_large_chunks=true`

Check:

- [ ] Release gate passes.
- [ ] Playwright report artifact is available.
- [ ] Build artifact is available.
- [ ] Any failure has an owner and follow-up issue.

Stop if:

- Release gate fails.
- Artifacts are missing.
- Large chunk risk is not acknowledged.

## Phase 6: Manual Hermes Legacy Regression

Purpose: verify Hermes Web UI still works as the underlying engine.

Use:

- `docs/aurora-legacy-regression-checklist.md`

Required areas:

- [ ] Auth and session.
- [ ] Core chat stream.
- [ ] Advanced Console.
- [ ] Files.
- [ ] Settings and profiles.
- [ ] Gateways and models.
- [ ] Terminal safety.
- [ ] Kanban and tasks.
- [ ] Memory.
- [ ] Quant Lab.
- [ ] LifeOS.
- [ ] Logs, usage, and jobs.
- [ ] Hub/Proxy boundary.

Stop if:

- Existing login/auth flow breaks.
- Socket streaming fails.
- Advanced Console cannot expose legacy Hermes.
- Hub/Proxy opens in Aurora App Mode.
- Terminal approval or memory governance can be bypassed.

## Phase 7: Final Go/No-Go

Purpose: decide whether the release can be tagged.

Use:

- `docs/aurora-release-checklist.md`
- `docs/aurora-release-readiness-audit.md`
- `docs/aurora-v0.1-release-notes.md`
- `docs/aurora-known-risks-and-followups.md`

Go only if:

- [ ] Local validation passes.
- [ ] GitHub release gate passes.
- [ ] Manual legacy regression is complete or skipped items have owners.
- [ ] Known large chunk warning is accepted for v0.1.
- [ ] P0 risks in `docs/aurora-known-risks-and-followups.md` are clean.
- [ ] P1 follow-ups have owners or are explicitly accepted.
- [ ] Release notes are updated.
- [ ] PR has been reviewed and approved.

No-Go if:

- [ ] Raw terminal/bash execution can bypass approval.
- [ ] Memory can be silently written without review.
- [ ] Unknown Aurora prompts fail instead of falling back to Hermes chat.
- [ ] App Mode reveals the legacy sidebar unexpectedly.
- [ ] Vibe Coding can write outside `packages/client/src/components/generated/`.

## Phase 8: Tag and Release

Purpose: create the final v0.1 release after all gates pass.

Suggested commands:

```bash
git tag v0.1
git push origin v0.1
```

Check:

- [ ] Tag points to the approved release commit.
- [ ] Release notes include known risks and preserved Hermes behavior.
- [ ] Playwright and build artifacts are linked from the release or PR.
- [ ] Follow-up work is tracked for bundle splitting and generated-widget lifecycle.

## Post-Release Follow-Up

Track after v0.1:

- Split Monaco, Mermaid, and heavy vendor chunks.
- Add signed generated-widget manifest and rollback controls.
- Expand App Mode bridge briefs for more legacy apps.
- Continue converting stable legacy JSON responses into Aurora widgets.
- Add more parser fixtures for natural-language intent routing.
- Maintain `docs/aurora-known-risks-and-followups.md` as the post-release risk tracker.
