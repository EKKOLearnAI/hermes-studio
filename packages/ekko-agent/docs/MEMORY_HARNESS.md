# Memory Quality Harness

Ekko's memory harness verifies behavior, not only storage CRUD. Run it with:

```bash
npm run harness:memory
```

The harness keeps these boundaries executable:

- Model context and memory evidence are separate inputs. A host that augments a
  turn with derived summaries, retrieved context, routing text, or quoted
  material passes only trusted conversation evidence through
  `memoryInput.messages`.
- Memory review policy belongs to the host integration. `automatic` preserves
  Ekko's normal memory behavior; `explicit-only` allows retrieval while
  accepting writes only for an explicit remember, correction, or forget
  request.
- The generic runtime does not know about rooms, participants, products, or
  application workflows. Those provenance decisions stay in the host adapter.
- Hosts may stamp opaque origin metadata and declare any combination of the
  generic `profile`, `context`, and `session` scopes. The curator chooses only
  from the declared writable set, while recall is limited to the declared read
  set. With no declaration, Ekko defaults to profile scope for compatibility.
- Durable mutation tools are absent from the foreground agent. The isolated
  curator owns writes and sees only host-selected evidence plus its origin and
  authorized scopes.
- Explicit remember, correction, update, and forget requests force a visible
  foreground `memory_review` tool call. It only signals immediate review and
  cannot submit or mutate memory content itself.
- Human-readable memory cards, audit reasons, and rolling-summary fields follow
  the latest trusted user message's language. Wrong-language model output is
  rejected or repaired before persistence.
- Ordinary one-to-one turns are reviewed in batches of eight by default.
  High-signal durable statements and explicit memory requests are still
  reviewed immediately.
- Tool payloads and system messages are excluded from the memory transcript.
- Development and production retain their existing database isolation; the
  harness never relocates or deletes user memory data.

When adding a new host integration, add a regression case that proves its
model-only envelope cannot appear in `MemoryService.listMessages()` or a saved
memory card, and that a context-scoped card cannot be recalled from a different
host context.
