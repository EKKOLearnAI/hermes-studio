# Life and Entertainment Orchestration Design

Date: 2026-07-15  
Owner: User + Codex  
Status: Approved for implementation

## Executive Decision

Phase 9 adds a provider-neutral Life and Entertainment Orchestration domain. Its source of truth covers commitments, contact aliases, travel options, media/game options, subscriptions, constraint snapshots, and immutable leisure-plan revisions.

The domain does not replace systems already completed in earlier phases:

- Bilibili discovery and execution remain owned by Internet Execution; Phase 9 consumes its minimized Personal Twin projections.
- Purchases and bookings remain Commerce intents. A leisure plan can create a handoff but cannot claim a purchase succeeded.
- Playback and app interaction remain semantic Internet or Android capabilities. Phase 9 never emits raw URLs, clicks, selectors, screen coordinates, or accessibility primitives.
- Health remains owned by the Health closed loop. Phase 9 consumes bounded readiness and recovery facts through the Personal Twin.
- Action Fabric remains the only policy, approval, workflow, retry, audit, budget, takeover, and emergency-stop authority.

The selected autonomy model is constraint-first planning: the system may automatically observe and rank options, but every plan is bound to a frozen snapshot of commitments, health, budget, and preferences. External writes are limited to exact calendar holds and exact subscription cancellation requests.

## Goals

- Normalize calendar, contacts, travel, music, games, and subscriptions without exposing provider credentials.
- Combine those sources with existing Bilibili Twin entities.
- Produce deterministic leisure plans that cannot overlap hard commitments or exceed time, health, screen-time, or spending constraints.
- Explain every selected and rejected option with stable reason codes.
- Reserve an exact accepted leisure session in a calendar through a durable, verified workflow.
- Cancel an exact subscription through lookup-before-retry and verified provider evidence.
- Project observed life facts, plan revisions, and verified outcomes into the Personal Twin exactly once.
- Give the user one command center for today, sources, plan revisions, subscriptions, workflows, and takeovers.

## Non-Goals

- Building a general CRM or storing raw phone numbers, email addresses, chat histories, passports, loyalty credentials, or contact-provider payloads.
- Booking travel, buying media/games, or paying subscriptions outside Commerce.
- Reimplementing Bilibili search, browser execution, Android control, or music playback.
- Allowing an LLM to invent availability, health readiness, budget, preference, or completion evidence.
- Automatically cancelling a subscription or writing a calendar event without Action Fabric policy and exact material binding.
- Treating recommendations, provider search results, or chat memory as committed plans.

## Ownership Boundaries

| Concern | Canonical owner | Phase 9 usage |
| --- | --- | --- |
| Health/readiness | Health + Personal Twin | Read bounded constraint facts |
| Calendar commitments | Life Orchestration | Normalize, conflict-check, reserve exact holds |
| Contact details | External provider | Store aliases and relationship/availability tags only |
| Bilibili discovery | Internet Execution | Consume minimized entertainment Twin entities |
| Music/game options | Life source adapters | Observe metadata; playback remains external semantic capability |
| Travel options | Life source adapters | Shortlist only; booking hands off to Commerce |
| Subscription state | Life Orchestration | Observe renewals and cancel exact subscriptions |
| Purchase/payment | Commerce Autonomy | Receive explicit handoff only |
| Workflow/policy/audit | Action Fabric | Exclusive authority |

## Domain Model

### Source Account

A source account binds one source kind to one execution mode and one server-owned adapter:

- `calendar`
- `contacts`
- `travel`
- `music`
- `games`
- `subscriptions`

Accounts use `observe`, `shadow`, and `live` modes. Observe permits bounded reads only. Shadow permits deterministic virtual writes. Live requires a healthy external adapter, a recent successful shadow receipt for the same operation family, explicit target limits, and super-admin activation.

Credentials remain inside server adapter closures. Database records, API DTOs, logs, evidence, and Twin projections never contain cookies, OAuth tokens, API keys, raw contact channels, or provider payloads.

### Normalized Facts

- `LifeCommitment`: immutable source identity, bounded label/category, start/end, busy state, all-day flag, location class, participant alias IDs, observation interval, and source digest.
- `LifeContactAlias`: alias, relationship tags, availability tags, source identity, and source digest. It contains no direct contact channel.
- `LifeOption`: `travel`, `video`, `music`, or `game`; title, category tags, duration, optional schedule/location, optional integer-minor cost, availability, expiry, and source digest.
- `LifeSubscription`: service/plan label, renewal timestamp, exact recurring cost, status, cancellation deadline, and source digest.

Provider identities remain internal. Public DTOs expose stable normalized IDs and minimized display fields.

### Constraint Snapshot

A constraint snapshot freezes all planning material:

- planning horizon and timezone;
- hard commitments and free windows;
- readiness band, recovery band, sleep-debt band, and screen-time usage;
- leisure time limit and exact integer-minor budget;
- quiet hours, travel-radius limit, excluded categories, and preferred categories;
- IDs and digests of every Personal Twin fact, preference, constraint, and source record used.

Missing health facts produce `unknown`, never an optimistic default. Unknown or stale material can reduce scope or force takeover but cannot silently relax a hard constraint.

### Leisure Plan Revision

Plan revisions are immutable and content-addressed. Each revision contains:

- constraint snapshot ID and digest;
- bounded candidate set;
- deterministic score components;
- selected sessions with exact start/end, option ID, cost, and source;
- stable exclusion and rationale codes;
- total time and cost;
- material digest and supersession state.

Changing a commitment, health fact, budget, preference, option, or time window creates a new revision. An old revision can still be audited but cannot be reserved after its material expires or becomes stale.

## Deterministic Planning Rules

Rules are applied before scoring:

1. Reject unavailable or expired options.
2. Reject sessions that overlap a hard commitment, quiet hours, or another selected session.
3. Reject options whose exact total cost exceeds the remaining leisure budget.
4. Apply health bounds: low recovery forbids high-exertion activities; material sleep debt limits late-night and long-screen sessions; unknown readiness limits automatic selection to low-exertion short sessions.
5. Enforce daily and per-session time limits.
6. Enforce excluded categories and travel radius.
7. Score eligible options by preference match, schedule fit, variety, cost efficiency, recency, and health fit.
8. Use stable code-unit ordering by normalized option ID as the final tie-breaker.

The planner emits reason codes, not free-form model rationales. Language generation may explain the codes but cannot alter eligibility or ordering.

## Action Fabric Capabilities

The closed Phase 9 capability set is:

- `life.source.sync` — bounded read and normalized projection.
- `life.plan.verify` — verify one immutable constraint snapshot and plan revision.
- `life.calendar.hold.create` — create one exact reversible calendar hold.
- `life.calendar.hold.cancel` — cancel one exact hold.
- `life.subscription.cancel` — cancel one exact subscription under a verified eligibility snapshot.

Targets are semantic atoms only:

- `life:account:<id>`
- `life:source:<kind>`
- `life:calendar:<calendar-id>`
- `life:plan:<plan-digest>`
- `life:subscription:<subscription-id>`
- `life:currency:<currency>`

Calendar creation is medium risk and reversible. Subscription cancellation is high risk and always requires per-action approval. All writes use provider request IDs, lookup-before-retry, durable receipts, and read-after-write verification.

## Cross-Domain Handoffs

A plan may create a handoff record containing a semantic destination and frozen material digest:

- Travel purchase -> Commerce quote/order flow.
- Media/game purchase -> Commerce comparison/order flow.
- Bilibili playback -> existing Bilibili capability.
- App playback -> existing Android semantic capability.

Handoffs never copy credentials or grant authority. The receiving domain creates a new Action Fabric intent and re-evaluates its own policy.

## Personal Twin Projection

Phase 9 writes minimized, idempotent records:

- entities: commitments, contact aliases, options, subscriptions, leisure-plan revisions;
- events: source observed, plan proposed, hold created/cancelled, subscription cancelled, activity completed;
- relations: commitment participant aliases, plan includes option, subscription belongs to service;
- observations: free-time minutes, recurring-cost total, planned-leisure minutes, category distribution.

Projection source IDs are derived from immutable domain identities. Replays cannot create duplicate Twin events.

## Privacy and Safety

- No raw contact channel, message content, credential, provider payload, browser state, or device primitive is persisted.
- Calendar labels and provider free text are bounded and redacted if credential-shaped before API/audit projection.
- Exact timestamps and normalized locations may be shown to the authenticated user but audit evidence contains digests and reason codes.
- Provider response amounts, identities, request IDs, and receipts are verified against stored material.
- All arrays and JSON values reject proxies, accessors, sparse arrays, secret-shaped keys, excessive depth, and excessive size.
- Emergency stop disables all live writes while preserving read-only source observation and local plan review.

## Studio Surface

`/hermes/personal-os/life-entertainment` provides:

- Today: commitments, free windows, readiness, budget, and stale-data warnings.
- Sources: account kind, mode, health, last observation, and activation state.
- Planner: horizon, frozen constraints, selected sessions, exclusions, and revision comparison.
- Library: travel/media/music/game options and existing Bilibili discoveries.
- Subscriptions: renewals, recurring cost, cancellation eligibility, and governed action.
- Workflows: active Action Fabric workflows, approvals, takeovers, retries, and verified outcomes.

There is no raw provider URL, token entry, browser selector, Android coordinate, or direct payment control.

## Acceptance Criteria

- Calendar, contacts, travel, music, games, and subscriptions normalize through bounded adapters.
- Existing Bilibili Twin projections participate in planning without duplicate ingestion.
- A hard commitment can never be overlapped by an automatically selected session.
- Low/unknown health readiness, sleep debt, screen-time, budget, and preference constraints change eligibility deterministically.
- Material changes create a new immutable plan revision and invalidate old reservation attempts.
- Calendar holds and subscription cancellations survive restart and never duplicate after uncertain results.
- Travel/media/game purchases are handed to Commerce rather than executed directly.
- Every plan and write explains the exact facts, constraints, policy, and verified outcome used.
- Existing Health, Home, Internet, Android, Commerce, Action Center, and assistant-role behavior remains compatible.

