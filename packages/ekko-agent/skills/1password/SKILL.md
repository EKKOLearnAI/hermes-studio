---
name: 1password
description: Set up and use 1Password CLI for authentication, secret references, command injection, and safe configuration templating.
metadata:
  keywords:
    - op cli
    - secret injection
    - secret reference
---

# 1Password CLI

Use the official `op` CLI for secrets consumed by commands or configuration. Prefer workflows in which the secret never appears in model context, terminal output, logs, chat, shell history, or a committed file.

## References

- Read `references/get-started.md` for prerequisites, authentication modes, and platform notes.
- Read `references/cli-examples.md` for safe command patterns.

## Workflow

1. Check the operating system and shell.
2. Verify the CLI without installing anything: `op --version`.
3. Identify the configured authentication mode:
   - `OP_SERVICE_ACCOUNT_TOKEN` is present: service account, usually for CI or headless use.
   - 1Password desktop integration is enabled: use the running, unlocked desktop app.
   - Neither applies: standalone interactive sign-in is required.
4. Verify access with `op whoami` before a secret-consuming operation.
5. If more than one account exists, use `--account` or the already-configured `OP_ACCOUNT` value.
6. Prefer `op run` or `op inject`; use `op read` only when its output can be consumed without being exposed.

If `op` is absent or authentication is not configured, explain the exact prerequisite and point to the official 1Password CLI documentation. Do not silently install the CLI, ask the user to paste a password or token into chat, invent credentials, or place a secret in tool arguments.

## Authentication modes

### Service account

The user must configure `OP_SERVICE_ACCOUNT_TOKEN` outside the conversation and agent command history. Do not print or inspect its value.

```bash
op whoami
op vault list
```

Service-account access is limited to its allowed vaults and does not require the desktop app.

### Desktop app integration

Run `op` directly so it can reach the per-user desktop integration channel:

```bash
op vault list
op whoami
```

The first call may request Touch ID, Windows Hello, or system authentication. If the CLI cannot connect, ask the user to open and unlock 1Password and confirm CLI integration is enabled. Do not move this mode into tmux as a workaround.

### Standalone interactive sign-in

An interactive sign-in creates a session environment variable that must stay in the same shell. On macOS or Linux, use a private tmux session only when desktop integration and service-account authentication are unavailable. Read the bundled `tmux` Skill first.

```bash
SOCKET_DIR="${EKKO_TMUX_SOCKET_DIR:-${TMPDIR:-/tmp}/ekko-tmux-sockets}"
mkdir -p "$SOCKET_DIR"
chmod 700 "$SOCKET_DIR"
SOCKET="$SOCKET_DIR/ekko-op.sock"
SESSION="op-auth-$(date +%Y%m%d-%H%M%S)"

tmux -S "$SOCKET" new -d -s "$SESSION" -n shell /bin/sh
tmux -S "$SOCKET" send-keys -t "$SESSION":0.0 -- 'eval "$(op signin --account my.1password.com)"' Enter
tmux -S "$SOCKET" capture-pane -t "$SESSION":0.0 -p -S - | tail -40
```

Do not queue later commands while sign-in is prompting. If a password, MFA challenge, or account choice is required, pause and ask the user to complete it locally by attaching to the named socket and session. Never request the password or one-time code in chat. After the prompt returns, send `op whoami` into that same pane and reuse the same `SOCKET` and `SESSION` for subsequent commands.

On Windows, prefer desktop integration or a service account. Do not translate the POSIX tmux flow into PowerShell without an explicitly provided persistent-session mechanism.

## Guardrails

- Never relay secret values through chat or include them in a summary.
- Never use a command whose purpose is to print a secret merely to prove access; use `op whoami` and metadata-only listing commands.
- Prefer `op run` for process environment variables and `op inject` for templates.
- Writing an injected file or `op read --out-file` persists secret material. Do it only when explicitly requested, restrict permissions, keep it out of version control, and explain cleanup.
- Do not pass `--no-masking` unless the user explicitly requires unmasked output and the destination is known to be safe.
- If authentication expires, fix the active mode rather than switching modes without the user's knowledge.
