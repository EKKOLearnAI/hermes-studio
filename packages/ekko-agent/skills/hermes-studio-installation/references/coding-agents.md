# Claude Code, Codex, Pi, and Grok installation

Use the Studio Agents page for cross-platform installation. It detects the same executable that chat launches, handles npm prefixes, installs Pi's required adapter, refreshes status, and reports the resolved path.

## Prerequisites

All four coding agents require Node.js and npm. Hermes Studio itself requires Node.js 23 or newer for npm/source installations.

Before installing, inspect:

```bash
node --version
npm --version
npm prefix -g
```

If Node or npm is unavailable, stop and install/fix Node first. Do not report an Agent installation problem as an Agent package failure when the actual problem is the Node environment.

## Packages and commands

Studio installs these global npm packages:

| Agent | Executable | Package |
| --- | --- | --- |
| Claude Code | `claude` | `@anthropic-ai/claude-code` |
| Codex | `codex` | `@openai/codex` |
| Pi | `pi` | Studio-pinned `@earendil-works/pi-coding-agent` |
| Grok | `grok` | `@xai-official/grok` |

At this Studio revision, Pi is pinned to `0.84.1`. Its installation is incomplete without Studio's separately pinned `pi-mcp-adapter` `2.24.0`, installed below:

```text
<HERMES_WEB_UI_HOME>/coding-agent/pi-mcp-adapter
```

The Agents page install action effectively performs the following. The Pi adapter example is POSIX shell syntax; use the Agents page on Windows so Studio resolves its home directory correctly.

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
npm install -g @earendil-works/pi-coding-agent@0.84.1
npm install -g @xai-official/grok --registry=https://registry.npmjs.org
studio_home="${HERMES_WEB_UI_HOME:-$HOME/.hermes-web-ui}"
npm install --prefix "$studio_home/coding-agent/pi-mcp-adapter" --save-exact pi-mcp-adapter@2.24.0
```

Run only the line for the requested Agent. For Pi, run both Pi lines, or use the Agents page so Studio chooses the revision's current pins automatically.

## Success criteria

Studio calls each executable with `--version` using an 8-second timeout. Validate manually as needed:

```bash
claude --version
codex --version
pi --version
grok --version
```

On macOS/Linux inspect executable resolution with `command -v claude`, `command -v codex`, `command -v pi`, or `command -v grok`; on Windows use `where`.

Installation is successful only when:

1. npm completed successfully;
2. the executable resolves in the PATH visible to Studio;
3. `<agent> --version` exits successfully;
4. the Agents page reports the Agent installed after a refresh;
5. for Pi, `<HERMES_WEB_UI_HOME>/coding-agent/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts` exists.

Pi deliberately reports **not installed** when its CLI exists but that adapter entry is missing. Reinstall Pi from the Agents page to repair both pieces.

## Check and apply updates

The Agents page **Check update** action behaves as follows:

- Claude Code: compares the detected version with `npm view @anthropic-ai/claude-code version`.
- Codex: compares the detected version with `npm view @openai/codex version`.
- Pi: compares the detected version with Studio's pinned Pi version; it does not chase npm latest independently.
- Grok: compares the detected version with `npm view @xai-official/grok version --registry=https://registry.npmjs.org`.

Studio uses the official npm Registry only for Grok installation and update
checks. This avoids stale third-party mirror metadata selecting a
platform-incompatible historical release. It does not modify the user's npm
configuration or the registry used for other coding Agents.

When an update is available, the update action reruns the same install operation. Revalidate the executable path and version afterward. For Pi, revalidate the adapter too.

## Remove an Agent

Use the Agents page delete action. Studio identifies the npm prefixes that own the command and uninstalls the package from each applicable prefix. Pi removal also uninstalls `pi-mcp-adapter` from the Studio adapter directory and stops matching running Agent processes.

Removal does not authorize deleting native user configuration, authentication, conversation data, or unrelated npm prefixes. After removal, verify that the Agents page reports not installed. If a command is still found, inspect all `command -v`/`where` results and npm prefixes; another user-owned installation may remain.

## PATH diagnosis

Studio builds its command PATH from its current Node directory, npm's global bin location, common NVM paths, the login shell PATH, and common Desktop binary locations. If terminal validation succeeds but Studio still reports not installed:

1. refresh the Agents page to force a new probe;
2. compare `npm prefix -g` with the prefix used during installation;
3. inspect all copies of the executable;
4. fully restart Hermes Studio so it inherits the updated login-shell PATH;
5. reinstall only if the resolved executable or package is genuinely absent.

Do not create Agent model or credential configuration during this installation workflow. Authentication is a separate task after installation succeeds.
