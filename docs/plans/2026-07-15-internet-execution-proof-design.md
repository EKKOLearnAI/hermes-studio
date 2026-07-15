# Internet Execution Proof Design

Date: 2026-07-15
Owner: User + Codex
Status: Approved

## Goal

Phase 6 proves that one semantic internet capability can execute through either MCP or a persistent browser boundary while Action Fabric remains the only authority for policy, durable workflow state, replay, verification, audit, and takeover.

The initial proof uses read-only Bilibili discovery because it exercises a real external system without introducing account mutation, publishing, or payment risk:

```text
Entertainment Assistant intent
  -> exact Bilibili semantic capability and target
  -> Action Fabric policy and durable workflow
  -> configured MCP executor, or bounded browser fallback after fresh policy resolution
  -> normalized video identities and source evidence
  -> second-read or browser-state verification
  -> durable receipt, audit, and Personal Twin event
```

## Decisions

- Add first-class `mcp` and `browser` Action Fabric executor types. They remain fail-closed external executors and are disabled by level-three emergency stop.
- Reuse the selected Hermes profile's existing MCP runtime and browser toolchain. Do not create a second credential store or copy MCP headers, environment values, cookies, or browser profiles into Action Fabric.
- The Agent Bridge gains server-internal, bounded MCP and browser call actions. They are not exposed as generic authenticated HTTP tool-call endpoints.
- Action intents never contain raw MCP server names, tool names, browser refs, clicks, scripts, cookies, or arbitrary URLs. Server-owned semantic bindings translate an allowlisted capability into provider calls.
- Phase 6 registers read-only `bilibili.video.search` and `bilibili.video.inspect`. Publishing, commenting, liking, favoriting, account changes, and all commerce remain denied until a later domain contract supplies exact write semantics and verification.
- MCP is the preferred production executor. The browser executor begins as a bounded read-only sandbox fallback. A change of executor or environment creates a fresh policy snapshot; it never silently reuses an earlier approval.
- Browser automation is limited to public HTTPS navigation and accessibility snapshots for this phase. Private networks, local files, credentials in URLs, arbitrary JavaScript, downloads, uploads, and raw coordinate interaction are rejected.
- A browser process is not the workflow source of truth. Stable task identity improves session continuity, while durable receipts let a restarted workflow safely reopen a read-only URL and verify the same semantic identity.
- Read-only external calls may be replayed after an uncertain transport result. Future MCP or browser writes must use stronger provider receipts and lookup-before-retry contracts.

## Action Fabric Contract

Initial semantic capabilities:

- `bilibili.video.search`
- `bilibili.video.inspect`

Exact targets include the profile and public origin:

```text
internet:profile:<profile-name>
internet:origin:www.bilibili.com
internet:provider:bilibili
```

The Entertainment Assistant receives only these capabilities and exact target atoms. Search and inspect are risk `none`, side-effect free, and available without spending authority. Raw MCP and browser primitives are never added to role capability scope.

## MCP Boundary

The existing Hermes MCP runtime owns transports, reconnection, tool discovery, and secret handling. The bridge call boundary requires:

- exact configured profile, server, and registered tool;
- the profile's include/exclude filter to permit the tool;
- a plain bounded JSON argument object;
- a bounded timeout and response size;
- normalized success/error output with credential-shaped material removed;
- no server configuration, headers, environment, or raw exception details in normal evidence.

The generic MCP executor receives a server-owned semantic binding. For Bilibili, the default conventional binding is `bilibili/search_videos` and `bilibili/get_video_info`; profile configuration may override tool names without changing capability semantics.

## Persistent Browser Boundary

The browser bridge permits only `browser_navigate` and `browser_snapshot` in Phase 6. It binds the Hermes browser `task_id` to the stable Action Fabric workflow ID and the browser profile to the captured Hermes profile.

Navigation accepts only normalized public Bilibili HTTPS URLs. Verification takes a fresh accessibility snapshot, extracts stable BVID identities, and compares them with the executed result. If a session disappeared after restart, the adapter safely navigates again before verification. CAPTCHA, login, consent, or other human challenge markers move the workflow to `waiting_user`; they are never bypassed.

## Durable Internet Receipts

Adapter receipts live in `<HERMES_HOME>/personal/internet-execution.db`, separate from credentials and browser state. A receipt is keyed by workflow ID and binds:

- executor and capability identity;
- material contract digest;
- profile and semantic provider binding;
- sanitized request and target origin;
- execution stage and stable result digest;
- normalized result, verification evidence, and timestamps.

Replay with changed material is rejected. A completed or verified receipt is returned without another provider call. Browser substeps checkpoint navigation and capture so restart recovery can continue from the safest read-only point.

## Verification And Audit

MCP verification repeats the safe read and requires stable BVID overlap or an exact inspected BVID. Browser verification reads a fresh snapshot and applies the same identity rule. Empty, malformed, oversized, origin-mismatched, or challenge-bearing responses are unverifiable and fail closed.

Action Fabric audit stores semantic capability, executor, normalized target, receipt ID, result digest, BVIDs, and stable error codes. Raw cookies, headers, tokens, browser profile paths, complete page content, and unbounded MCP payloads never enter workflow evidence.

Successful results emit a Personal Twin event and outbox record so later entertainment projections can consume the observation without treating chat history as truth.

## Studio Surface

The Internet Execution proof surface shows:

- MCP and browser executor health without configuration secrets;
- exact profile, provider, and semantic capability availability;
- a bounded Bilibili search/inspect form;
- selected executor, workflow state, replay/verification status, and takeover reason;
- normalized result cards and receipt evidence;
- emergency-stop and credential-revocation state.

It does not expose raw MCP calls, browser refs, cookies, headers, local profile paths, or arbitrary URL controls.

## Acceptance Criteria

- Action Fabric persists and validates `mcp` and `browser` executors through schema upgrade and reopen.
- A configured Bilibili MCP search executes once, normalizes bounded video identities, verifies through a safe second read, and appears in the hash-chained audit.
- Process restart or effect-before-checkpoint replay does not duplicate an irreversible action and safely repeats only read-only provider calls.
- A disconnected MCP server fails closed; enabling the browser fallback requires a newly resolved executor/policy snapshot.
- The browser uses a stable workflow task identity, can recover by reopening the public URL, and verifies from a fresh snapshot.
- Private/local URLs, raw tools, mutation tools, injected browser actions, oversized output, and credential material are rejected.
- CAPTCHA, login, or other human verification produces takeover instead of attempted bypass.
- Credential revocation or emergency stop disables new internet executor work.
- The browser surface completes the mocked MCP/browser workflow without exposing secrets or local paths.

## External References

- Hermes Agent MCP client implementation: https://github.com/NousResearch/hermes-agent/blob/main/tools/mcp_tool.py
- Hermes Agent browser behavior: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/browser.md

