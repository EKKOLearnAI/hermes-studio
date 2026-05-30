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
| Auth, profile, or credential behavior | focused server tests plus relevant e2e auth tests |
| Chat, Socket.IO, group chat | focused server tests plus relevant e2e chat tests |
| Desktop packaging | `npm run harness:check`, `npm run build`, and a platform-specific desktop build when practical |
| GitHub workflow | `npm run harness:check` and `actionlint` when available |
| Package manifests | `npm ci --ignore-scripts` and lockfile workflow expectations |

## CI Mapping

- Build workflow: installs dependencies, runs coverage, builds production assets,
  then runs a Linux desktop smoke test on pull requests.
- Playwright workflow: runs browser e2e tests.
- NPM lockfile workflow: verifies `package-lock.json` is synchronized.
- Desktop release workflow: builds and uploads platform-specific desktop artifacts
  for release tags.
- Docker workflow: builds and publishes release images.

## Release Workflow Guardrail

Desktop release jobs must upload only the artifacts that their matrix target can
produce. Keep artifact globs in matrix data and keep `fail_on_unmatched_files:
true` so missing expected files still fail.

Expected desktop release outputs:

| Target | Required release globs |
| --- | --- |
| macOS | `*.dmg`, `*.dmg.blockmap`, `latest*.yml` |
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
