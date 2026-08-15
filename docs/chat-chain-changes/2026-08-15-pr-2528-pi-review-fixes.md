---
date: 2026-08-15
feature: pr-2528-pi-review-fixes
impact: Pi group-chat runs now stream text across tool loops, route interactive extension prompts through Studio, and abort before disposal when an Agent is disconnected; Ekko is displayed consistently and can run as a Workflow node; single-chat messages use runtime Agent avatars, Claude has a shorter display name, and Agent avatars use a one-pixel outline without internal white padding.
pr: 2528
---

# PR #2528 Pi review fixes

Pi RPC text deltas are forwarded as they arrive, with authoritative message-end
snapshots used only to append missing suffixes. This preserves assistant text
emitted both before and after tool calls without duplicating it.

Pi extension `confirm` requests use Studio approvals with `once` and `deny`.
`select`, `input`, and `editor` requests use Studio clarifications; unsupported
request/response methods fail closed or are ignored when they are notification-
only operations.

Disconnecting a local group Agent now awaits run abort before session disposal
and transport cleanup. Remote Agent descriptors and pairing codes use protocol
version 2 (`HGC2`) so older peers do not silently accept the new Pi descriptor.

The client now displays the built-in runtime as `Ekko`, with Ekko placed directly
after Hermes in every Agent selector. Workflow nodes persist the stable
`ekko-agent` runtime ID, execute through the existing scoped Ekko path, retain
server-managed provider support, and disable background delegation for the
one-shot Workflow run.

Single-chat live and historical messages derive Assistant avatars from the
session runtime instead of its profile. Client-visible `Claude Code` labels are
shortened to `Claude` while stable runtime IDs stay unchanged. Agent avatars in
single-chat messages, the session list, group messages, the group empty state,
and the group participant rail fill their frame and use a one-pixel white
outline without a padded white background.

On Windows, Pi keeps both long user input and long dynamic system instructions
out of the `cmd.exe` command line: user input is sent over RPC stdin and dynamic
instructions are read from the isolated per-run prompt file.

Pi can now use Global mode in both the Coding Agents terminal and Studio single
chat. Native launches use the user's existing `~/.pi/agent` configuration as-is;
Studio chat adds only a per-session RPC extension and dynamic prompt file, while
leaving provider, model, credentials, and native session storage under the
global Pi configuration. Global Pi children inherit the user environment, while
scoped Pi children continue to receive only the isolated runtime environment.

Scoped Pi keeps using the shared local Responses proxy and the protocol selected
in Studio for its upstream request. Chat Completions reasoning is now emitted as
a standard Responses `reasoning` output item with summary deltas and a terminal
item event. The normalizer accepts common `reasoning_content`, `reasoning`, and
`reasoning_text` deltas as well as cumulative `reasoning_details` text used by
some compatible providers. This keeps the existing upstream protocol routing
unchanged while making the converted stream consumable by Pi as well as Codex.
