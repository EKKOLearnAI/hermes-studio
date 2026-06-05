# OpenClaw -> Hermes Migration Report

- Timestamp: 20260515T162805
- Mode: execute
- Source: `C:\Users\DELL\.openclaw`
- Target: `C:\Users\DELL\AppData\Local\hermes`

## Summary

- migrated: 17
- archived: 1
- skipped: 34
- conflict: 0
- error: 0

## What Was Not Fully Brought Over

- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\SOUL.md`: No OpenClaw SOUL.md found
- `workspace/AGENTS.md` -> `(n/a)`: Source file not found
- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\memories\MEMORY.md`: Source file not found
- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\memories\USER.md`: Source file not found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No Hermes-compatible messaging settings found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No allowlisted Hermes-compatible secrets found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No Discord settings found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No Slack settings found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No WhatsApp settings found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No Signal settings found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\.env`: No provider API keys found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\config.yaml`: No default model found in OpenClaw config
- `C:\Users\DELL\.openclaw\openclaw.json` -> `C:\Users\DELL\AppData\Local\hermes\config.yaml`: No TTS configuration found in OpenClaw config
- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\config.yaml`: No OpenClaw exec approvals file found
- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\skills\openclaw-imports`: No OpenClaw skills directory found
- `C:\Users\DELL\.openclaw\skills` -> `C:\Users\DELL\AppData\Local\hermes\skills\openclaw-imports`: No skills with SKILL.md found in managed skills
- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\memories\MEMORY.md`: No workspace/memory/ directory found
- `(n/a)` -> `C:\Users\DELL\AppData\Local\hermes\tts`: Source directory not found
- `C:\Users\DELL\.openclaw\openclaw.json` -> `(n/a)`: Selected Hermes-compatible values were extracted; raw OpenClaw config was not copied.
- `C:\Users\DELL\.openclaw\identity` -> `(n/a)`: Contains secrets, binary state, or product-specific runtime data
- `(n/a)` -> `(n/a)`: No MCP servers found in OpenClaw config
- `(n/a)` -> `(n/a)`: No plugins configuration found
- `(n/a)` -> `(n/a)`: No cron configuration found
- `(n/a)` -> `(n/a)`: No hooks configuration found
- `(n/a)` -> `(n/a)`: No session configuration found
- `(n/a)` -> `(n/a)`: No model providers found
- `(n/a)` -> `(n/a)`: No channel configuration found
- `(n/a)` -> `(n/a)`: No browser configuration found
- `(n/a)` -> `(n/a)`: No tools configuration found
- `(n/a)` -> `(n/a)`: No approvals configuration found
- `(n/a)` -> `(n/a)`: No memory backend configuration found
- `(n/a)` -> `(n/a)`: No skills registry configuration found
- `(n/a)` -> `(n/a)`: No UI/identity configuration found
- `(n/a)` -> `(n/a)`: No logging/diagnostics configuration found

## Next Steps

- Review the migration report at C:\Users\DELL\AppData\Local\hermes\migration\openclaw\20260515T162805/summary.md
- Start a new Hermes session (or /reset) to pick up the imported config.
