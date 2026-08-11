---
date: 2026-08-07
pr: pending
feature: Compatible client UUID generation
impact: Invite-only group chat and other browser flows continue working when crypto.randomUUID is unavailable.
---

The remote Agent handoff introduced request IDs that called
`crypto.randomUUID` directly. Client UUID generation now checks that the API is
callable before using it. Browsers that expose Web Crypto without `randomUUID`
fall back to a standards-compatible version 4 UUID generated with
`crypto.getRandomValues`.

The shared group-chat invite page uses the compatible generator for Agent-link
state and request IDs, and generated avatar seeds.
