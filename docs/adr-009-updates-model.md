# ADR-009 Amendment: Updates UX Model

> Status: accepted for the ADR-009 / PR #1046 branch.
>
> Scope: this note documents the singleton Updates model, preview source rules, repository descriptors, and deploy verification.

## Summary

The Updates surface has two primary cards only:

- Stable
- Preview

The Preview card represents a single candidate build served at `/preview/`.

## Stable vs Preview

### Stable

Stable is the production Web UI served at `/`.
It is the default user-facing environment and the promotion target for a preview.

Stable can show both the package release version and the build metadata that produced the deployed service.
Those two values may differ by design:

- `webui_version` is the package/build version.
- `webui_build_commit`, `webui_build_branch`, `webui_build_source`, and `webui_built_at` describe the actual build provenance.

This prevents a label like `0.6.1` from being mistaken for a clean upstream `0.6.1` source build.

### Preview

Preview is the single candidate build served at `/preview/`.
This iteration is explicitly singleton-only: there is one preview slot, not a list of preview environments.

## Health and build metadata

The `/health` response exposes the fields that the Updates surface relies on:

- `webui_version`
- `webui_build_commit`
- `webui_build_branch`
- `webui_build_source`
- `webui_built_at`
- `webui_latest`
- `webui_update_available`

If build metadata is missing, the UI must show a graceful unknown state, not a broken card.

## Preview source model

### Preview Source

Preview Source is the origin of the singleton preview build.
The default source is Release.
Branch and Commit sources are available only when Dev Mode is enabled.

### Dev Mode

Dev Mode is not a separate page, section, or card.
It is an expansion of the Preview source chooser that reveals Branch and Commit options.

When Dev Mode is off, source options are:

- Release

When Dev Mode is on, source options are:

- Release
- Branch
- Commit

Critical invariant:

- Dev Mode ON adds Branch/Commit.
- Dev Mode ON does not remove or disable Release.
- Release remains available even when the repository is missing or invalid.

## Repository source model

Repository configuration is only needed for Branch/Commit previews.
Supported repository descriptors:

```ts
type PreviewRepository =
  | { type: 'local'; path: string }
  | { type: 'git-url'; url: string }
  | { type: 'github'; owner: string; repo: string }
```

Examples:

```yaml
dev:
  preview_repository:
    type: local
    path: /home/werserk/2-kira/hermes-web-ui-adr009-singleton-updates
```

```yaml
dev:
  preview_repository:
    type: git-url
    url: https://github.com/kira-project-lab/hermes-web-ui.git
```

```yaml
dev:
  preview_repository:
    type: github
    owner: kira-project-lab
    repo: hermes-web-ui
```

For Git URL or GitHub repository sources, Hermes may create an internal cached checkout/worktree under the Hermes profile.
The user should not need to manually choose a local path unless they select Local path.

## Preview source rules

### Release

- Available without Dev Mode.
- Available even when Dev Mode is on.
- Available even if repository configuration is missing or invalid.
- User can select any known release.
- Release list is sorted newest version → oldest version.
- Release preview does not use git branch preview machinery.

### Branch

- Visible/selectable only when Dev Mode is on.
- Requires valid repository configuration.
- Uses clone/fetch/cache/worktree flow.
- Runs install/build scripts and must be super-admin/dev-only.

### Commit

- Visible/selectable only when Dev Mode is on.
- Requires valid repository configuration.
- Requires a commit SHA/ref input.
- Uses clone/fetch/cache/worktree flow.
- Runs install/build scripts and must be super-admin/dev-only.

## Capability matrix

The preview capability response should read like this:

- Release is the baseline capability and stays enabled unless there are no releases at all.
- Branch and Commit are dev-only capabilities.
- Missing or invalid repository state disables only Branch/Commit.
- Dev Mode off hides Branch/Commit even when the repository is valid.
- Dev Mode on shows Branch/Commit and leaves Release available.

This is the user-facing matrix the Updates page should preserve.

## Promotion flow

The promotion action is Preview → Stable.
That is the primary update path for this iteration.

## Release sorting

Release options and release lists are ordered newest → oldest.
The frontend and backend both rely on that ordering so the latest available version can be preselected while still allowing any older release to be chosen.

## Deploy verification checklist

A successful build is not enough by itself.
Before calling a deployment healthy, verify all of the following:

1. The live `/health` response reports the expected `webui_version` and build metadata.
2. `webui_build_commit`, `webui_build_branch`, `webui_build_source`, and `webui_built_at` match the build you just produced.
3. `webui_latest` and `webui_update_available` make sense relative to the deployed package version.
4. The Stable card shows the deployed version plus the build provenance, not just a package number.
5. The Preview card still serves the expected source type and release list ordering.
6. Release stays enabled even if the preview repository is missing or invalid.
7. Preview assets and runtime are fresh: do not trust the new build unless the running service is actually serving the updated artifacts.
8. If the browser or console still shows old assets, white screens, or stale package/runtime behavior, treat the deployment as incomplete until the running service is repointed/restarted and rechecked.

The intent is to catch stale asset/package/runtime confusion early instead of assuming that `pnpm build` alone means the site is live.

## Out of scope for this iteration

- Multi-preview management
- Any `/preview/:name` or similar multi-slot routing model
- Advanced update dashboards
- Recovery dashboards

These ideas may exist as future scale-out options, but they are intentionally not part of the current UX model.

## Product constraint

The Updates page must stay conceptually simple:

- one Stable card
- one Preview card
- Preview Source expands to Branch/Commit only in Dev Mode
- no separate Advanced or Recovery surface in the main flow

This note exists to prevent the UI from drifting back toward the older Stable / Preview / Branch Preview / Advanced / Recovery dashboard split.
