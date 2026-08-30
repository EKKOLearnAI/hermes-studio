# Hermes Studio

Electron desktop distribution for Hermes Studio.

## Install

Download the latest macOS, Windows, or Linux installer for your CPU
architecture from the project
[GitHub Releases](https://github.com/EKKOLearnAI/hermes-studio/releases/latest).

The desktop app bundles the Web UI runtime and launches it locally from the
native shell app.

## Command shims

After the packaged desktop app starts, it installs managed command shims:

| Command | Description |
| --- | --- |
| `hermes-studio` | Open the Hermes Studio desktop app |
| `hermes-studio cli ...` | Run the bundled Hermes Agent CLI |
| `hermes-studio web ...` | Run the bundled `hermes-web-ui` command |
| `hermes-studio -h` | Show wrapper help |
| `hermes-studio-mcp` | Run the managed Web UI MCP bridge |

Use `hermes-studio cli -h` for Hermes Agent CLI help and
`hermes-studio web -h` for Web UI CLI help.

## Data directories

Hermes Agent data is stored in the same platform-specific location as native
Hermes installs:

- Windows: `%LOCALAPPDATA%\hermes` (falls back to `%APPDATA%\hermes`)
- macOS/Linux: `~/.hermes`

The desktop wrapper's own Web UI state is stored separately in
`~/.hermes-web-ui` unless `HERMES_WEB_UI_HOME` is set.

## China mirror environment

These mirrors are optional and are not required in CI:

```sh
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

If GitHub release downloads are slow, `fetch-python.mjs` can also use a compatible
python-build-standalone release mirror:

```sh
export PBS_BASE_URL=https://github.com/astral-sh/python-build-standalone/releases/download
```
