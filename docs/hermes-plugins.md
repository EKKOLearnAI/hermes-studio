# Hermes Web UI Plugins

Hermes Web UI can discover Hermes Agent plugin manifests and manage user-installed plugins from the Plugins page.

## What The Page Manages

- Bundled plugins are discoverable and can be enabled or disabled when the Hermes Agent allows it.
- User plugins live in `~/.hermes/plugins/<plugin-name>` and can be installed, enabled, disabled, updated, or removed.
- Project plugins live in `.hermes/plugins/<plugin-name>` and are scanned only when `HERMES_ENABLE_PROJECT_PLUGINS=1`.
- Plugin metadata is read from `plugin.yaml` / `plugin.yml` without importing plugin code during discovery.
- Enable, disable, install, and remove changes take effect in new Hermes sessions.

## Install Sources

The install box accepts:

- A full Git URL, for example `https://github.com/example/hermes-plugin.git`
- GitHub shorthand, for example `example/hermes-plugin`

The repository should contain a `plugin.yaml` and an `__init__.py` with a `register(ctx)` function.

## Minimal Plugin Shape

```text
my-plugin/
  plugin.yaml
  __init__.py
```

```yaml
name: my-plugin
version: 0.1.0
description: Minimal Hermes plugin.
author: kk
kind: standalone
provides_tools: []
provides_hooks: []
```

```python
def register(ctx):
    def hello(raw_args: str = "") -> str:
        name = (raw_args or "").strip() or "Hermes"
        return f"Hello, {name}."

    ctx.register_command(
        "hello-local",
        hello,
        description="Check that a local plugin is loaded.",
        args_hint="[name]",
    )
```

See `examples/hermes-plugin-hello/` for a copyable sample.

## API Surface

The Web UI calls these local BFF endpoints:

- `GET /api/hermes/plugins`
- `POST /api/hermes/plugins/install`
- `POST /api/hermes/plugins/actions/enable`
- `POST /api/hermes/plugins/actions/disable`
- `POST /api/hermes/plugins/actions/update`
- `POST /api/hermes/plugins/actions/remove`

All mutation endpoints return a JSON result with `ok`, optional `error`, and operation-specific fields such as `missing_env`, `warnings`, `enabled`, or `unchanged`.
