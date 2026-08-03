# Group Chat mixed-runtime refactor handoff

> Status: **research / refactor handoff — do not merge the current implementation as-is**
>
> This document transfers the validated product behavior, test assets, security boundaries, and independently reproduced failure cases from PR #2226 to the upstream maintainer who will own the rewrite.

## 1. Why this handoff exists

PR #2226 explored mixed-runtime Group Chat participants across Hermes Profiles, Codex, and Claude Code. The branch now contains useful behavior specifications and a broad regression suite, but the implementation grew to **199 changed paths** and independent exact-head reviews found unresolved lifecycle and authorization blockers.

The recommended path is therefore:

1. start from the latest clean upstream `main` in a maintainer-owned branch;
2. treat this PR as a read-only source of requirements, tests, adversarial probes, and UI behavior;
3. reimplement in bounded vertical slices instead of merging or incrementally extending the current branch;
4. keep unrelated Chat, Coding Agent, Bridge, authentication, and Workflow behavior unchanged unless a slice explicitly requires a shared contract change.

Do **not** cherry-pick the two broad hardening commits wholesale. They are useful as an audit trail, not as an approved architecture.

## 2. Frozen review identity

The final independently reviewed implementation before handoff was:

- PR: `#2226`
- reviewed HEAD: `76e2ac7ecf0fff2d86f3d11de59bfd379327eb59`
- reviewed tree: `9fcd87951b6c598694622fcedf8f410ed66ba7ab`
- merge-base: `d2b892a39546fc2bda61aad83a23744e204ca282`
- review base: `f30881b3b30dfedc2f2adc1523cca124b366c2de`
- full-index binary diff: `1,997,857` bytes
- full-index binary diff SHA256: `ff7e4427b06d51579a1f6357d07cc60491f9483dfa64e5c953230ac2e148a380`
- changed paths: `199`
- review snapshot status: clean before and after review

Any later documentation-only handoff commit does not invalidate the blocker evidence above; the findings are bound to this exact source identity.

## 3. Product behavior worth preserving

### 3.1 Participant model

- A Room participant has a stable `participantId`; display names are presentation only and must never be the routing authority.
- Hermes Profile, Codex, and Claude Code participants share a common participant contract while keeping separate runtime adapters and native session provenance.
- Participant runtime identity includes Profile/runtime kind, provider/model, API mode, reasoning effort, workspace, and native session identity where applicable.
- Client participant updates must not be able to switch protected identity fields such as Profile, runtime, or Coding Agent binding.

### 3.2 Mention and chain semantics

- Structured Mention metadata, not rendered `@name` text, is the dispatch authority.
- Ordinary multiple Mentions remain parallel fan-out.
- A fixed relay chain preserves exact ordered participant IDs and supports repeated participants, including adjacent repeats.
- Chain interruption is fenced by `chainId`; it must not stop another concurrent chain targeting the same participant.
- Malformed, stale, cross-Room, empty, overlong, or unknown participant metadata fails closed.

### 3.3 Runtime configuration semantics

- Configuration changes affect the next admitted run; an already admitted job uses an immutable runtime snapshot.
- Live authorization remains independently revalidated for Room membership, actor, Profile assignment, Session generation, job lease, and revocation state.
- API mode has three distinct states: omitted for legacy behavior, empty string to clear an override, and non-empty string for an explicit override.
- Session reuse identity must include every runtime-affecting field; a cached worker may switch only when idle, otherwise the switch is deferred.
- Rapid UI updates should coalesce to at most one request in flight plus the latest desired state, with rollback to the last confirmed state on failure.

### 3.4 Authorization boundaries

The following are separate authorities and must not imply one another:

- Room read/write/manage;
- participant invocation;
- Profile assignment and Profile credential use;
- Coding Agent sandbox/process execution;
- approval resolution;
- managed MCP/browser/devices/workflow operations;
- Room/participant/session destructive lifecycle operations.

Model-visible tool filtering is not authorization. Every side-effecting dispatcher must perform a final fail-closed check against the exact operation and current authority.

### 3.5 Durable execution and evidence

- A handoff job needs durable admission, claim, lease, heartbeat, retry, ordering, and terminalization.
- Same-target FIFO must not be bypassed when an older job is in retry backoff.
- Runtime configuration snapshot and authorization revision are distinct concepts.
- Late results cannot persist after Room, actor, participant, Session generation, lease, or authorization fences no longer match.
- Workspace evidence belongs to the admitted Room/job/lease and must be durably persisted before successful terminal state is published.
- Shutdown first quiesces new dispatch, then waits for in-flight handoffs and runtime containment cleanup.

### 3.6 UI behavior

- Participant avatars provide one direct, keyboard-accessible quick-settings surface for model, API mode, reasoning effort, and structured Mention insertion.
- Read-only members may insert an allowed structured Mention but must not see or invoke management controls.
- The Activity Dock shows one primary active state by default; warnings and failures receive stronger prominence.
- “Stop current reply”, “hide notice”, and “stop entire handoff chain” are different actions and must remain visibly and behaviorally distinct.
- Disconnect/reconnect and terminal access denial clear stale typing, streaming, activity, context, and approval UI state.

## 4. Independently reproduced merge blockers

The exact-head reviews returned `BLOCK` despite the existing test suite and GitHub CI being green.

### 4.1 Process containment can be escaped

Current POSIX cleanup relies on the original detached process group plus an environment marker. A descendant can call `setsid`, remove `HERMES_CODING_EXECUTION_ID` from its environment, outlive `run.completed`, and continue modifying the workspace.

Relevant implementation areas:

- `packages/server/src/services/agent-runner/coding-agent-run-manager.ts`
- `packages/server/src/services/agent-runner/coding-agent-runtime-ownership.ts`
- `tests/server/coding-agent-process-tree-posix.test.ts`

Rewrite requirement:

- use a Linux containment boundary a child cannot escape, such as a controlled cgroup v2 subtree, and verify the containment is empty before success;
- if the platform/runtime cannot establish a verifiable durable containment boundary, production Coding Agent execution must fail closed;
- PGID plus a removable environment marker is useful diagnostic evidence but is not sufficient containment.

### 4.2 Ownership activation failure leaves a live unmanaged process

Both Claude and Codex paths spawn the child before durable ownership activation. If activation persistence fails, the call throws while the child remains alive and the in-memory run has no active child reference.

Rewrite requirement:

- immediately attach the spawned process to cleanup ownership before any fallible persistence step;
- if activation fails, terminate and await the complete containment, verify it is empty, record a recoverable failure state, and only then return the launch error;
- add SQLite fault-injection tests that reject transition to `running`.

### 4.3 Workspace evidence persistence failure still publishes success

Current code can catch workspace evidence storage failure, emit `run.completed` with no evidence, send the final assistant message, and release the handoff while a durable checkpoint manifest remains.

Rewrite requirement:

- evidence receipt is a prerequisite for successful terminalization;
- on storage failure, keep finalization ownership/lease or enter an explicit recoverable state;
- do not acknowledge or delete the manifest until durable persistence succeeds;
- fault-inject `workspace_run_changes` insertion failures and prove no success event or final Room message is published.

### 4.4 Managed MCP uses a shared Profile token as the final caller identity

A valid managed capability currently resolves a Profile and then reads that Profile's shared `.model-run-token`. Another user's ordinary run can replace this token, so the final side effect can execute as the wrong account even though the capability itself was valid.

Relevant implementation areas:

- `packages/server/src/controllers/hermes/managed-mcp-capability.ts`
- `packages/server/src/services/hermes/managed-mcp-capability.ts`
- `bin/hermes-studio-mcp.mjs`
- `packages/server/src/services/hermes/run-chat/model-run-prompt.ts`
- `tests/server/hermes-web-ui-mcp.test.ts`

Rewrite requirement:

- carry or mint an initiator-bound, short-lived execution credential tied to Room, actor/account, participant, Session, job/lease, Profile, exact operation, and relevant revisions;
- final dispatch must use that verified initiator authority directly;
- managed dispatch must never fall back to a process-global or Profile-shared token and must reject tool arguments that try to override Profile/token.

### 4.5 Capability lifetime expires before a valid long run

The capability expiry is capped by the initial short handoff lease. Heartbeats renew the lease but do not renew the signed capability, while a Coding Agent run may legitimately continue much longer.

Rewrite requirement:

- either support bounded renewal tied to the current claim/lease and revalidate live authority on renewal and dispatch, or issue against a separately bounded admitted-run deadline;
- revocation must take effect even when a credential has not reached its wall-clock expiry;
- test MCP calls before and after multiple lease renewals, plus Room/Profile/actor revocation during the run.

## 5. Existing artifacts that can be reused as specifications

Treat these as inputs to a clean implementation, not proof that the current architecture is mergeable.

### Core behavior and route tests

- `tests/server/group-chat-coding-agent-participant.test.ts`
- `tests/server/group-chat-handoff-outbox.test.ts`
- `tests/server/group-chat-routes-baseline.test.ts`
- `tests/server/group-chat-agent-routing-baseline.test.ts`
- `tests/server/group-chat-member-sync.test.ts`
- `tests/server/group-chat-mention-routing.test.ts`
- `tests/server/group-chat-access-policy.test.ts`
- `tests/server/group-chat-capability-policy.test.ts`

### Lifecycle, recovery, and evidence tests

- `tests/server/coding-agent-process-tree-posix.test.ts`
- `tests/server/coding-agent-runtime-ownership.test.ts`
- `tests/server/hermes-db-process-ownership.test.ts`
- `tests/server/workspace-diff-checkpoint-recovery.test.ts`
- `tests/server/shutdown-background-order.test.ts`

### Bridge and capability tests

- `tests/server/group-chat-agent-workspace.test.ts`
- `tests/server/agent-bridge-profile-env.test.ts`
- `tests/server/agent-bridge-python-concurrency.test.ts`
- `tests/server/managed-mcp-capability.test.ts`
- `tests/server/hermes-web-ui-mcp.test.ts`

### Client behavior tests

- `tests/client/group-chat-avatar-controls.test.ts`
- `tests/client/group-chat-activity-dock.test.ts`
- `tests/client/group-chat-store-streaming.test.ts`
- `tests/client/group-chat-panel-approval.test.ts`
- `tests/client/group-chat-mention-entities.test.ts`

Before reuse, review each test for implementation coupling. Preserve externally observable behavior and adversarial invariants; rewrite assertions that merely encode current internal structure.

## 6. Suggested clean rewrite slices

Each slice should begin with a failing behavioral or adversarial test, remain independently reviewable, and avoid unrelated paths.

1. **Participant domain contract** — stable identity, adapter interface, public DTO, persistence, legacy read compatibility.
2. **Structured Mention and routing** — fan-out versus ordered chain, malformed-input fail-closed behavior.
3. **Authorization model** — Room actions, Profile assignment, participant invoke, approval, and destructive mutation as explicit separate decisions.
4. **Durable handoff state machine** — admission, immutable runtime snapshot, claim/lease/heartbeat, FIFO, retry, fences, terminal outbox.
5. **Runtime containment and evidence** — cgroup-backed ownership, crash recovery, activation rollback, tree-empty proof, evidence-first terminalization.
6. **Managed capability execution** — initiator-bound credential, exact-operation dispatch, renewal/revocation, no shared-token fallback.
7. **Bridge/runtime adapters** — Profile/Codex/Claude adapters, Session reuse identity, API mode tri-state, approval transport.
8. **UI** — participant controls, Activity Dock, reconnect reconciliation, distinct stop semantics, accessibility and localization.

Do not start with the current 199-file diff as the target shape. The desired result is the smallest coherent set of shared contracts plus isolated runtime adapters.

## 7. Acceptance matrix for the rewrite

A mergeable replacement should demonstrate at least:

- ordinary single Mention and parallel multi-Mention;
- ordered chain with repeated and adjacent repeated participants;
- concurrent chains targeting the same participant, with chain-scoped stop;
- disconnect/reconnect without duplicate or stale terminal UI;
- next-run config update while a current run remains on its admitted snapshot;
- Profile reassignment, actor role change, Room removal, and Session generation change during execution;
- managed MCP exact-tool allow/deny and caller identity across capability renewal;
- no token/Profile override through model-generated arguments;
- child `setsid` plus environment removal cannot escape containment;
- ownership activation persistence fault leaves no live process;
- evidence persistence fault cannot produce success or release the job;
- crash/restart recovery reaches exactly one terminal result and retains auditable evidence;
- shutdown refuses clean success until all owned runtime containment and evidence finalization complete;
- clean TypeScript, focused tests, full tests, Harness, production build, and real browser acceptance.

Process-tree adversarial suites must run in an isolated PID namespace or equivalent disposable environment, never in the namespace hosting the active Hermes Studio service.

## 8. Evidence already collected

For the reviewed HEAD:

- full isolated Vitest: `437/437` files, `3700 passed / 2 skipped / 0 failed`;
- coverage command: exit `0`;
- Client/Server TypeScript: pass;
- Harness: pass;
- production build: pass;
- GitHub `build` and `e2e`: pass;
- isolated production browser smoke path: login, Group Chat navigation, Room creation, and Room entry passed.

A latest-main composition was also built and passed `443/443` files with `3734 passed / 2 skipped / 0 failed` plus TypeScript, Harness, and production build.

These results prove broad regression coverage but **do not override the five independently reproduced blockers**. Green CI is not a merge decision here.

## 9. Release and artifact status

- No merge was performed.
- No Git tag or GitHub Release was created.
- No candidate package was installed as part of this handoff.
- A candidate image was pushed and one test LPK was copied to the delivery directory before the terminal `BLOCK` reviews arrived. Both are now **revoked/stale test artifacts**: they must not be installed, reused, promoted, or treated as acceptance evidence.
- The currently installed runtime was not changed by that delivery action.
- A future test image and package must be rebuilt under new immutable identities from the maintainer-owned rewritten exact HEAD after review passes.

## 10. Maintainer decision points

The upstream owner should explicitly choose:

1. the Linux containment mechanism and supported-platform fail-closed policy;
2. the initiator-bound credential format and renewal/revocation model;
3. the durable handoff/evidence transaction boundary;
4. which participant/runtime fields belong in shared core contracts versus adapter-specific storage;
5. whether to preserve this PR as a design archive or supersede it with a smaller clean PR.

Until those decisions are implemented and the adversarial acceptance matrix passes, PR #2226 should be treated as a handoff archive rather than a merge candidate.
