---
date: 2026-08-12
pr: TBD
feature: Group Chat effective-utterance rolling summaries
impact: Prevent tool-window starvation and cursor gaps while counting public human and Agent messages
---

## Summary

Rolling Room summaries now count each public natural-language message from a human or Agent as one effective utterance. Tool calls/results, reasoning-only records, streaming/status rows, workspace diffs, empty content, and serialized Tool traces remain excluded.

The summary storage path reads the oldest eligible messages after the persisted summary anchor instead of taking a newest raw-row tail. Bounded batches advance the anchor only after the summary model successfully processes that contiguous prefix.

## Impact

- Prevents Tool-heavy runs, including legacy serialized Tool traces with ECMAScript Unicode whitespace before the speaker marker or between the speaker prefix and Tool marker, from hiding pending public conversation behind the raw scan/window limits. Serialized markers require the same ASCII word boundary as the runtime cleaner, so legitimate public phrases such as `[Calling toolbar…]` and `[Tool resultant…]` remain eligible.
- Prevents a summary anchor from skipping older eligible messages that were not sent to the model.
- Makes the configured threshold eligible on the Nth public utterance, including public Agent replies and handoffs.
- Continues oldest-first across bounded batches, persists the accepted frozen cutoff as a drain entitlement, and drains it exactly once even if ownership moves to another service after a partial commit or a later model batch fails and is retried without a new Room message. A completed old drain does not authorize a newer below-threshold cutoff. When more than three batches remain, work continues in yielded slices, and the configured maximum threshold remains supported.
- Fails closed without calling the model or moving the anchor when one eligible message would make the final prompt exceed the 80,000-token budget.
- Moves the model request outside the short per-Room mutation lock, rejects stale results after a concurrent summary edit, and makes a second service wait for an active persisted lease before rechecking its later cutoff so cross-instance triggers do not require another message. A waiter re-enters through the normal threshold gate instead of inheriting the active owner's frozen-cutoff drain authority, so a later cutoff with too few new utterances is not summarized early.
- Keeps internal summary generation, run-token, lease-expiry, and run-generation concurrency fields out of serialized Room API payloads.
- Updates Room summary terminology from human-only turns to effective public utterances.

## Compatibility

The existing `summaryEveryTurns` and `summarizedTurnCount` storage/API fields remain for compatibility, but their UI semantics are now effective public utterances. Existing summary text and anchors are preserved; this change does not fabricate coverage for legacy summaries that may already contain cursor gaps.

## Validation

Regression coverage includes Tool-flood starvation, human plus Agent counting, Nth-message eligibility, failure preservation, stale-result rejection, multi-batch continuity, maximum configured threshold, and unchanged shared-context window behavior.
