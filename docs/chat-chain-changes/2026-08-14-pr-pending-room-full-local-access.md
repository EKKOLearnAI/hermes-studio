---
date: 2026-08-14
pr: 2538
feature: Group Chat per-room full local access switch
impact: Room owners can grant non-owner-triggered local Agents full local file access by disabling the authorized_workspace constraint injection for that room
---

## Summary

Group Chat rooms gain a per-room `fullLocalAccess` switch (default off, owner-only). When enabled, the room no longer injects the non-owner security context (`authorized_workspace` constraint) into prompts for turns triggered by non-owner members, so local Agents can read/write any path on the host machine just like owner-triggered turns. The switch is persisted on `gc_rooms.fullLocalAccess` (auto-migrated via `addMissingSafeColumns`), is room-scoped, requires an explicit confirmation dialog in the UI when enabling, and rotating the session seed / fencing active Agent sessions on state change.

This feature removes a prompt-level workspace hint, it does not add or remove any OS-level sandbox or tool permission.

## Impact

- New `PUT /api/hermes/group-chat/rooms/:roomId/full-local-access` endpoint (manager-only, boolean body, 404/403/400 handling) mirroring the workspace endpoint semantics: fence + interrupt active room Agent sessions on actual state change.
- Non-owner prompt injection in `agent-clients.ts` is gated by `!room.fullLocalAccess`.
- Room settings UI shows the switch only for managers; enabling requires a confirmation popconfirm; locale keys added for all 11 existing locales.
- Default remains off, so existing behavior is unchanged for all rooms until an owner opts in.

## Notes

- The switch is per room and independent of `allowRemoteWorkspaceAccess`.
- Docs updated: this fragment (chat-chain path touched).
