# Hermes Studio

Electron desktop distribution for Hermes Studio.

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
