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
- Memory write policy belongs to the host integration. `automatic` preserves
  Ekko's normal direct-write behavior; `explicit-only` allows retrieval while
  accepting writes only for an explicit remember, correction, or forget
  request.
- The generic runtime does not know about rooms, participants, products, or
  application workflows. Those provenance decisions stay in the host adapter.
- Hosts may stamp opaque origin metadata and declare any combination of the
  generic `profile`, `context`, and `session` scopes. Direct write tools choose only
  from the declared writable set, while recall is limited to the declared read
  set. With no declaration, Ekko defaults to profile scope for compatibility.
- Durable mutation tools run in the foreground. `memory_write.operations`
  validates every requested create, update, expiration, or exact deletion and
  commits the complete batch in one transaction; `memory_forget` applies
  multi-target and broad deletions with the same all-or-nothing guarantee.
- Explicit remember, correction, update, and forget requests expose the matching
  direct mutation path without forcing a tool choice or creating background jobs.
- A list-all request enumerates every active memory in the authorized scopes;
  it is not treated as a relevance query.
- A failed `memory_write` or `memory_forget` rolls back the complete mutation
  batch and returns the real tool error, so a later model turn cannot claim that
  a partial write succeeded.
- There is no memory approval queue, background review, or Session-summary model
  pass. Run completion only records trusted conversation evidence.
- Tool payloads and system messages are excluded from the memory transcript.
- Development and production retain their existing database isolation; the
  harness never relocates or deletes user memory data.

When adding a new host integration, add a regression case that proves its
model-only envelope cannot appear in `MemoryService.listMessages()` or a saved
memory card, and that a context-scoped card cannot be recalled from a different
host context.
