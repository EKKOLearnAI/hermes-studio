# Validation Guide

Run the smallest relevant checks while iterating. Escalate to the broad checks
when touching shared behavior, release automation, auth, persistence, or chat.

## Always Run For PRs

```bash
npm run harness:check
```

For broad or shared changes, also run:

```bash
npm run test:coverage
npm run test:e2e
npm run build
```

## Change-Type Matrix

| Change | Minimum local validation |
| --- | --- |
| Docs only | `npm run harness:check` |
| Client component/store/API | focused `npm run test -- <pattern>`, then `npm run build` |
| User-visible browser flow | focused Vitest plus `npm run test:e2e` |
| Server controller/service/db | focused `npm run test -- tests/server/<file>` |
| Server module move or dependency change | focused server boundary tests, then `npm run harness:check` |
| Auth, profile, or credential behavior | focused server tests plus relevant e2e auth tests |
| Chat, Socket.IO, group chat | focused server tests plus relevant e2e chat tests |
| Chat session chain, Agent Bridge, compression, or Group Chat | `npm run harness:check` plus focused chat/bridge/group-chat tests |
| Desktop packaging | `npm run harness:check`, `npm run build`, and a platform-specific desktop build when practical |
| GitHub workflow | `npm run harness:check` and `actionlint` when available |
| Package manifests | `npm ci --ignore-scripts` and lockfile workflow expectations |

## Managed MCP launch environment

Every MCP definition injected by Studio (Hermes, Ekko, or Coding Agent) must
include `ELECTRON_RUN_AS_NODE: '1'` in that MCP subprocess's `env`. Independent
Node ignores the flag; the Electron executable fallback requires it to execute
the MCP script instead of opening another desktop instance. External Gateway
processes may not inherit the desktop server's environment.

`npm run harness:check` inspects all three configuration factories. New managed
MCP injection paths must be added to that check. Keep configuration comparison
and migration aware of the flag so previously injected entries are repaired;
do not overwrite user-owned MCP definitions or globally enable Node mode for
the desktop app. Validate changes with the MCP injection and launch tests.

Long-running external Gateways may keep older MCP definitions in memory. The
packaged entrypoint must route the exact bundled MCP script invocation before
loading GUI or updater code, even when Node mode is absent. Test the real package:

```bash
node scripts/verify-desktop-mcp.mjs '<packaged executable>' '<resources directory>'
```

This checks all four toolsets with Node mode deliberately removed, validates the
JSON-RPC initialize response, and checks clean exit on stdin EOF. It uses temporary
state and does not require a running Gateway.

## CI Mapping

- Build workflow: installs dependencies, runs coverage, and builds production
  assets on pushes and pull requests.
- Playwright workflow: runs browser e2e tests.
- NPM lockfile workflow: verifies `package-lock.json` is synchronized.
- Desktop release and manual desktop build workflows build and upload
  platform-specific desktop artifacts.
- Docker workflow: builds and publishes release images.

## Release Workflow Guardrail

Published GitHub Releases should still trigger Web UI artifact packaging and
Docker image publishing, but those workflows must keep the GitHub Release out
of latest.

Full desktop packaging is manually dispatched through
`.github/workflows/desktop-release.yml`; published GitHub Releases must not
automatically start desktop packaging. After a full desktop release finishes,
the workflow must mark the target GitHub Release as latest.

Desktop release jobs must upload only the artifacts that their matrix target can
produce. Keep artifact globs in matrix data and keep `fail_on_unmatched_files:
true` so missing expected files still fail.

Expected desktop release outputs:

| Target | Required release globs |
| --- | --- |
| macOS | `*.dmg`, `*.dmg.blockmap`, `*.zip`, `*.zip.blockmap`, `latest*.yml` |
| Windows | `*.exe`, `*.exe.blockmap`, `latest*.yml` |
| Linux x64 | `*.AppImage`, `*.deb`, `latest*.yml` |
| Linux arm64 | `*.AppImage`, `latest*.yml` |

## Failure Handling

When a command fails:

1. Read the first actionable error, not just the final stack trace.
2. Check whether the failure indicates missing context, missing test coverage,
   or a missing mechanical rule.
3. Fix the product bug when there is one.
4. Update docs or `scripts/harness-check.mjs` when the same class of mistake
   should be prevented next time.
