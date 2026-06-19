# Personal Data Backup Report

- Backup date: 2026-06-19
- Source Hermes homes:
  - `C:\Users\Administrator\.hermes`
  - `C:\Users\Administrator\AppData\Local\hermes`
- Full backup path: `D:\code\hermes-data-backups\20260619-171540-full-hermes`
- Agent canonical home backup path: `D:\code\hermes-data-backups\20260619-174833-userprofile-hermes`
- Selective backup path: `D:\code\hermes-data-backups\20260619-170725-personal-data`
- Backup mode: full Hermes home backup plus selective personal data convenience backup
- Status: completed

## Result

The first full recursive backup attempt timed out after 120 seconds. Investigation showed the Hermes home contains large runtime and debug directories, especially `hermes-agent`, `hermes-office`, and `debug`.

A selective backup completed successfully first to protect the obvious user-facing data. A later full backup with `robocopy /E /XJ /R:1 /W:1 /MT:16` completed successfully:

- Robocopy log: `D:\code\hermes-data-backups\20260619-171540-full-hermes\robocopy-full-backup.log`
- Robocopy exit code: `1`
- Robocopy failed files: `0`
- Robocopy copied bytes: `3.460 g`
- Source item count observed after backup: `168286`
- Backup item count observed after backup: `168282`
- Source bytes observed after backup: `3715627108`
- Backup bytes observed after backup: `3715627108`

The small item-count difference is recorded for transparency. Robocopy reported no failed files, and source/backup byte totals matched when measured after the copy.

Hermes Agent was then verified to use `C:\Users\Administrator\.hermes` by default. A second full backup captured that canonical Agent home:

- Robocopy log: `D:\code\hermes-data-backups\20260619-174833-userprofile-hermes\robocopy-userprofile-hermes.log`
- Robocopy exit code: `1`
- Robocopy failed files: `0`
- Robocopy copied files: `609`
- Robocopy copied bytes: `9.16 m`

## Captured Data Categories

- Personal State: captured
- Profiles: captured
- Sessions: captured
- Memories: captured
- Settings/configuration: captured
- Provider/model cache metadata: captured
- Runtime state databases: captured
- Kanban data: captured
- Skills/scripts/cron data: captured
- Auth/environment files: copied to backup only; secret values were not printed or documented
- Upload/artifact paths: no dedicated top-level user upload or artifact directory was found. Search matches were inside runtime source/dependencies/debug extraction and are covered by the full backup.

## SQLite Integrity Checks

- `personal_state.db`: ok
- `state.db`: ok
- `response_store.db`: ok
- `kanban.db`: ok

For `C:\Users\Administrator\.hermes`:

- `personal_state.db`: ok
- `state.db`: ok
- `kanban.db`: ok

## Not Captured In This Pass

The validated full backup captured the complete Hermes home. The selective backup intentionally did not capture large runtime/source directories, cache directories, or debug extraction directories.

## Rollback

If Studio migration fails, keep using `D:\code\hermes-desktop` and `D:\code\hermes-agent` with the current Hermes home.

Operational rollback steps:

1. Stop Hermes Studio, Hermes Desktop, and any running Hermes Agent process before restoring SQLite files.
2. Copy the current Hermes home aside, for example to `C:\Users\Administrator\AppData\Local\hermes-before-rollback-<timestamp>`.
3. Prefer restoring Agent-owned Personal State from `D:\code\hermes-data-backups\20260619-174833-userprofile-hermes\.hermes`. Use `D:\code\hermes-data-backups\20260619-171540-full-hermes\hermes` for the Windows desktop/studio home. Use the selective backup only when you intentionally want to restore a smaller set of user-facing files.
4. Restore personal data directories as needed: `profiles`, `sessions`, `memories`, `skills`, `cron`, `kanban`, `scripts`, `desktop`, `gateway`, `weixin`, `state-snapshots`, `logs`, `hooks`, and `pairing`.
5. Restore SQLite databases together with their sidecar files when present: `personal_state.db`, `state.db`, `state.db-shm`, `state.db-wal`, `response_store.db`, `response_store.db-shm`, `response_store.db-wal`, and `kanban.db`.
6. Restore top-level config files as needed: `config.yaml`, `desktop.json`, `models.json`, `provider_models_cache.json`, `ollama_cloud_models_cache.json`, `SOUL.md`, `auth.json`, and `.env`.
7. Validate the rollback by starting the prior Hermes UI and confirming profiles, sessions, and Personal State proposals/tasks are visible.

Do not use `D:\code\hermes-data-backups\20260619-170417` for rollback. That directory came from the timed-out full recursive copy and may be incomplete.

For Studio replacement, run Studio with `HERMES_HOME=C:\Users\Administrator\.hermes` until path detection is intentionally changed. This keeps Studio and Hermes Agent on the same `personal_state.db`.

## Continuity Verification

Verification date: 2026-06-19

- Hermes Agent created proposal: `proposal-b10e2dc6f507`
- Agent write path: `C:\Users\Administrator\.hermes\personal_state.db`
- Studio service was run with `HERMES_HOME=C:\Users\Administrator\.hermes`
- Studio saw the pending proposal: yes
- Studio approved the proposal: yes
- Studio-created task title: `Confirm Studio reads Personal State`
- Hermes Agent saw the approved task afterward: yes

This confirms the Personal State loop works when Studio and Hermes Agent share `HERMES_HOME=C:\Users\Administrator\.hermes`.
