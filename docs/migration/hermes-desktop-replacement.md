# Hermes Desktop Replacement

Hermes Studio is now the active UI path for this local fork.

- Runtime: `D:\code\hermes-agent`
- Runtime branch: `codex/personal-state-studio-migration`
- Active UI: `D:\code\hermes-studio`
- Active UI branch: `codex/hermes-studio-replacement`
- Legacy reference: `D:\code\hermes-desktop`
- Personal State home: `C:\Users\Administrator\.hermes`
- Studio launch requirement: set `HERMES_HOME=C:\Users\Administrator\.hermes`

## Backups

- Agent canonical home backup: `D:\code\hermes-data-backups\20260619-174833-userprofile-hermes`
- Windows desktop/studio home backup: `D:\code\hermes-data-backups\20260619-171540-full-hermes`
- Selective personal data backup: `D:\code\hermes-data-backups\20260619-170725-personal-data`

## Verified

- Hermes Agent `personal_state` store writes to `C:\Users\Administrator\.hermes\personal_state.db`.
- Hermes Studio backend reads the same Personal State database when launched with `HERMES_HOME=C:\Users\Administrator\.hermes`.
- Studio approved proposal `proposal-b10e2dc6f507`.
- Hermes Agent saw the resulting task `Confirm Studio reads Personal State`.
- Studio backend Personal State tests passed.
- Studio frontend PersonalOS tests passed.
- Studio server typecheck and Vue typecheck passed during migration.

## Remaining Follow-Ups

- Decide whether to change Studio's default Windows Hermes home detection or keep using explicit `HERMES_HOME`.
- Expand PersonalOS beyond the first review/task loop with wardrobe, household assets, health, and plan surfaces from the old desktop prototype.
- Run a full test suite outside the tool timeout window.
- Keep `D:\code\hermes-desktop` until Studio has been used as the primary UI for a few sessions.
