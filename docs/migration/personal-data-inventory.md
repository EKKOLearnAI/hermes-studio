# Personal Data Inventory

- Migration date: 2026-06-19
- Hermes home candidates:
  - Agent canonical home: `C:\Users\Administrator\.hermes`
  - Desktop/Studio Windows home: `C:\Users\Administrator\AppData\Local\hermes`
- Environment `HERMES_HOME`: not set in this shell
- Full Hermes home backup path: `D:\code\hermes-data-backups\20260619-171540-full-hermes`
- Agent canonical home backup path: `D:\code\hermes-data-backups\20260619-174833-userprofile-hermes`
- Selective personal data backup path: `D:\code\hermes-data-backups\20260619-170725-personal-data`
- Earlier full recursive backup attempt: `D:\code\hermes-data-backups\20260619-170417` timed out before completion because the Hermes home includes large runtime/debug directories. Treat this directory as incomplete and do not use it for rollback.

## Backed Up Data

The validated full backups copied both Hermes home candidates with `robocopy /E /XJ /R:1 /W:1 /MT:16`.

- Personal State database: `personal_state.db`
- Core runtime databases: `state.db`, `response_store.db`, `kanban.db`
- SQLite sidecars present at backup time: `state.db-shm`, `state.db-wal`, `response_store.db-shm`, `response_store.db-wal`
- Profile directories: `profiles`
- Session and memory directories: `sessions`, `memories`
- User-managed Hermes assets/config: `skills`, `cron`, `kanban`, `scripts`, `desktop`, `gateway`, `weixin`, `state-snapshots`, `logs`, `hooks`, `pairing`
- Top-level settings and model cache files: `config.yaml`, `desktop.json`, `models.json`, `models_dev_cache.json`, `provider_models_cache.json`, `ollama_cloud_models_cache.json`
- Auth and environment files were copied into the local backup only. Secret values were not printed or copied into this document.

## Skipped From Selective Backup

These entries were skipped only by the earlier selective backup. They are included in the validated full Hermes home backup unless the source changed while the backup was running.

- `hermes-agent`: local runtime/source checkout with many dependency files. The source fork is maintained separately at `D:\code\hermes-agent`.
- `hermes-office`: large runtime/application directory, not required for the first Studio replacement pass.
- `debug`: large debug extraction directory with many dependency files.
- `cache`, `audio_cache`, `image_cache`, `bootstrap-cache`, `lsp`, `sandboxes`, `gateway-service`: cache/runtime/generated directories that can be recreated or inspected later if a specific migration need appears.

## Migration Notes

The preferred Studio migration strategy is in-place reuse of `C:\Users\Administrator\.hermes` for canonical Hermes Agent data. Hermes Agent defaults to `~\.hermes` when `HERMES_HOME` is unset, so Studio must run with `HERMES_HOME=C:\Users\Administrator\.hermes` or otherwise be configured to read that same root for Personal State.

Use `D:\code\hermes-data-backups\20260619-174833-userprofile-hermes` as the primary rollback backup for Agent-owned Personal State. Use `D:\code\hermes-data-backups\20260619-171540-full-hermes` for the Windows desktop/studio home. Use `D:\code\hermes-data-backups\20260619-170725-personal-data` as a smaller convenience backup for inspecting user-facing data.

Upload/artifact search did not find a dedicated top-level user upload or artifact directory. Matches were inside runtime source, dependencies, debug extraction, or package files, and are covered by the full backup.

SQLite integrity checks passed for `C:\Users\Administrator\.hermes\personal_state.db`, `state.db`, and `kanban.db`. SQLite integrity checks also passed for `%LOCALAPPDATA%\hermes\personal_state.db`, `state.db`, `response_store.db`, and `kanban.db`.
