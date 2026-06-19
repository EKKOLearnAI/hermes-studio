# Studio Baseline

- Date: 2026-06-19
- Branch: `codex/hermes-studio-replacement`
- Node requirement: `>=23.0.0`
- Observed Node: compatible with dependency installation and build

## Dependency Install

`npm install` completed. The command exceeded the 120 second tool timeout, but the background npm process finished afterward. `npm ls --depth=0` completed successfully.

`package-lock.json` changed during local install and was restored because the change was local npm metadata noise unrelated to the migration.

## Tests

The full `npm test` run exceeded the 180 second tool timeout in this environment. A representative baseline subset passed:

```powershell
npx vitest run tests/server/health-controller.test.ts tests/server/config.test.ts tests/client/api.test.ts tests/client/app-store.test.ts tests/desktop/runtime-paths.test.ts --reporter=dot
```

Result:

- Test files: 5 passed
- Tests: 65 passed

## Build

`npm run build` passed. It ran OpenAPI generation, `vue-tsc -b`, client build, server `tsc --noEmit`, and server bundling.

Observed warnings:

- Some client chunks are larger than 1000 kB after minification.
- ESP32-C3 firmware was not found and `dist/mcu/firmware.bin` was skipped.

`docs/openapi.json` changed during build and was restored because the generated diff was unrelated to the migration baseline.

## Personal Data Backup Residual Risks

The validated full backup is `D:\code\hermes-data-backups\20260619-171540-full-hermes`.

Residual risks:

- The backup was taken while the Hermes home may have had live writers.
- Robocopy reported no failed files, but 3 skipped files and a 4-item post-copy count difference were observed.
- SQLite integrity checks passed for the main databases after the backup.
- `HERMES_HOME` was unset in this shell; if another process uses a different Hermes home, that path is not covered by this baseline.
