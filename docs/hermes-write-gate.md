# Hermes Agent Write Gate Notes

Hermes Agent v0.16.0 adds a write approval gate for persistent self-improvement
writes. The gate covers Hermes Agent memory and skill writes, not ordinary Web
UI state or arbitrary file edits.

## What It Controls

Write Gate protects two long-lived Hermes Agent stores:

- `memory`: entries written to `memories/MEMORY.md` and `memories/USER.md`.
- `skills`: agent-created or agent-edited skills under the active profile's
  skills directories.

These writes affect future agent behavior across sessions. The gate exists so a
user can review what the agent learned or changed before it becomes durable.

## Configuration

The switches live in the active Hermes Agent profile's `config.yaml`.

```yaml
memory:
  write_approval: true

skills:
  write_approval: true
```

The defaults are `false`, which preserves the previous behavior: memory and
skill writes are applied immediately.

Equivalent CLI commands:

```bash
hermes config set memory.write_approval true
hermes config set skills.write_approval true
```

Disable them with:

```bash
hermes config set memory.write_approval false
hermes config set skills.write_approval false
```

For multi-profile installs, the relevant file is the `config.yaml` under the
profile directory selected by `HERMES_HOME`.

## Runtime Behavior

When the gate is disabled, writes proceed normally.

When enabled:

- Foreground interactive CLI memory writes can reuse the dangerous-command
  approval callback inline.
- Gateway, Web UI, script, and background-review memory writes are staged for
  later review.
- Skill writes are always staged, because a skill change can be too large to
  review safely in an inline prompt.

Staged records are stored under the active profile:

```text
<HERMES_HOME>/pending/memory/*.json
<HERMES_HOME>/pending/skills/*.json
```

Each pending record includes an id, subsystem, action, summary, origin, created
timestamp, and replay payload.

## Review Commands

Hermes Agent exposes review commands through its CLI and gateway slash-command
surfaces:

```text
/memory pending
/memory approve <id>
/memory reject <id>

/skills pending
/skills diff <id>
/skills approve <id>
/skills reject <id>
```

`approve` replays the staged payload and then removes the pending record.
`reject` removes the pending record without applying it.

## Web UI Impact

Hermes Web UI already handles dangerous command approvals through
`approval.requested` / `approval.resolved` events and renders an approval bar in
chat and group chat.

Write Gate is different for Web UI sessions. Hermes Agent does not always emit a
browser-visible approval event for memory and skill writes. In gateway-like
contexts, memory writes are staged, and skill writes are always staged. The
review workflow is currently command/pending-store based.

Current practical meaning:

- Users can enable `memory.write_approval` and `skills.write_approval`.
- Agent writes become pending JSON records instead of being applied.
- Reviewing those pending writes currently depends on Hermes Agent's
  `/memory ...` and `/skills ...` command handling or direct pending-store
  inspection.
- A first-class Web UI popup or review panel would require Web UI API/UI work
  to list, diff, approve, and reject pending memory/skill writes.

## Hermes Agent Code References

The upstream implementation is in Hermes Agent:

- `tools/write_approval.py`: config resolution, pending store, gate decisions,
  skill diff helpers.
- `tools/memory_tool.py`: stages gated memory mutations and replays approved
  pending writes.
- `tools/skill_manager_tool.py`: stages gated skill mutations and replays
  approved pending writes.
- `hermes_cli/write_approval_commands.py`: shared `/memory` and `/skills`
  pending/approve/reject/diff command handling.

