# npm Release Runbook

This document describes how to publish and operate the public npm package for Hermes Web UI.

## Package

- npm package: `@quanthermes/hermes-web-ui`
- install command: `npm install -g @quanthermes/hermes-web-ui`
- runtime command: `hermes-web-ui start`
- release workflow: `.github/workflows/npm-publish.yml`

## Required Secrets

- `NPM_TOKEN`: npm automation token with publish access to `@quanthermes`

## Release Steps

1. Make sure the working tree only contains release-related changes.
2. Update the version in `package.json`.
3. Keep `package-lock.json` in sync with the package version and package name.
4. Run the focused validation commands:
   - `npm test -- tests/server/update-controller.test.ts tests/server/health-controller.test.ts tests/client/app-store.test.ts`
   - `npx tsc --noEmit -p packages/server/tsconfig.json`
5. Run `npm run build`.
6. Commit the release changes with a Conventional Commit message such as `chore: release v0.6.11`.
7. Push the branch and create or update the release PR.
8. After merge, create and push a git tag such as `v0.6.11`.
9. Verify that GitHub Actions runs `.github/workflows/npm-publish.yml` successfully.
10. Verify the published package:
    - `npm view @quanthermes/hermes-web-ui version`
    - `npm install -g @quanthermes/hermes-web-ui`
    - `hermes-web-ui start`

## Self-Update Configuration

Set these environment variables on deployed Web UI hosts:

```env
WEBUI_UPDATE_ENABLED=true
WEBUI_UPDATE_PACKAGE=@quanthermes/hermes-web-ui
WEBUI_UPDATE_REGISTRY=https://registry.npmjs.org
WEBUI_UPDATE_SOURCE_LABEL=Quanthermes npm
WEBUI_UPDATE_CLI_BIN=hermes-web-ui.mjs
WEBUI_UPDATE_DIST_TAG=latest
```

## Pre-Release Checklist

- `package.json` name is `@quanthermes/hermes-web-ui`
- `package.json` version matches the intended release tag
- `README.md` and `README_zh.md` install commands match the scoped package
- `NPM_TOKEN` is present in repository secrets
- release notes mention any update-path changes
- production hosts have the update environment variables configured

## Rollback

1. Deprecate or unpublish the bad version according to npm policy.
2. Publish a fixed version with a higher semver.
3. If a deployed host already upgraded, rerun the update process with the fixed version or reinstall a known-good version explicitly:

```bash
npm install -g @quanthermes/hermes-web-ui@<known-good-version>
```

4. Restart the Web UI service and confirm `/health` reports the expected `webui_version`.
