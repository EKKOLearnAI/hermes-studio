# 1Password CLI prerequisites

Use the official 1Password CLI installation instructions for the user's operating system; do not guess an installation command or silently install software.

## Requirements

- The CLI works on macOS, Windows, and Linux.
- Desktop app integration requires a 1Password subscription, the desktop app, and an unlocked signed-in account.
- On macOS, enable **Settings > Developer > Integrate with 1Password CLI**. Touch ID is optional.
- On Windows, enable Windows Hello and then **Settings > Developer > Integrate with 1Password CLI**.
- On Linux, desktop integration requires PolKit and an authentication agent. Enable system authentication under **Settings > Security**, then enable CLI integration under **Settings > Developer**.
- If multiple accounts are configured, select one with `--account` or `OP_ACCOUNT`.
- Standalone authentication may first require `op account add`.

## Connection behavior

Desktop integration uses a per-user IPC channel: XPC on macOS, a Unix-domain socket on Linux, or a named pipe on Windows. Run `op` directly from the agent's terminal environment. A tmux subshell may not inherit access to that channel.

Service accounts use `OP_SERVICE_ACCOUNT_TOKEN` and do not depend on desktop IPC. Standalone interactive sign-in returns an `OP_SESSION_*` export; it remains valid only in the shell that evaluates and retains it.
