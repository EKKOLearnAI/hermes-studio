# Aurora OS v0.1 RC

Date: 2026-05-28
Status: Release-candidate checklist installed in the frontend codebase.

## MVP Surface

- Aurora OS Shell: intent-first chat surface with the legacy workbench hidden behind Advanced Console.
- Advanced Console: toggle preserves Hermes sessions, sockets, sidebars, and legacy routes.
- Security Gateway: L4 terminal approvals render above all Aurora overlays and rejection is written back to chat context.
- Memory Governance: proposed memories enter a review queue and do not write to the legacy memory API.
- Vibe Coding Pipeline: Build mode halts at Step 08 until explicit approve or reject.
- Legacy Bridge: Aurora Commander routes matching intents to ToolRegistry adapters and falls back to normal Hermes chat when no tool matches.
- Aurora Control Panel: v0.1 system status and demo path controls are available from the top-left status icon.

## Demo Path

1. Open `/hermes/chat`.
2. Keep Advanced Console closed for the clean Aurora launcher.
3. Open Aurora System Status.
4. Run an ordinary prompt to verify Hermes fallback.
5. Run a memory proposal prompt and review the candidate in Memory Governance.
6. Switch OmniBar to Build and run a build intent.
7. Reject or approve the Step 08 L4 modal.
8. Open Advanced Console and confirm legacy Jobs, Kanban, Memory, Models, and Settings remain accessible.

## Smoke Coverage

The Aurora e2e smoke suite is in `tests/e2e/aurora-os.spec.ts`.
The repeatable validation flow is documented in `docs/aurora-validation.md`.
The post-RC migration plan is tracked in `docs/aurora-roadmap.md`.
The release go/no-go checklist is documented in `docs/aurora-release-checklist.md`.
The draft release notes are documented in `docs/aurora-v0.1-release-notes.md`.
The release readiness audit is documented in `docs/aurora-release-readiness-audit.md`.
The release-candidate PR draft is documented in `docs/aurora-v0.1-rc-pr.md`.
The release-candidate commit slicing plan is documented in `docs/aurora-commit-plan.md`.
The final legacy regression pass is documented in `docs/aurora-legacy-regression-checklist.md`.
The final release operation runbook is documented in `docs/aurora-release-runbook.md`.
The accepted risk and follow-up register is documented in `docs/aurora-known-risks-and-followups.md`.

- Advanced Console toggles legacy Hermes without losing the Aurora chat surface.
- No-match OmniBar input falls back to the standard Hermes chat stream.
- L4 terminal approvals render above the shell and write rejection back to context.
- Vibe Build mode halts at Step 08 until explicit approval or rejection.
- Memory Governance queues proposed memories without writing the legacy memory API.

## Release Notes

- No legacy Hermes backend API route was removed or disabled.
- No core Socket.IO streaming logic was replaced.
- New frontend state is additive and scoped to Aurora shell, status, governance, and overlays.
- The git branch/tag should be created only after committing the current dirty worktree intentionally.
