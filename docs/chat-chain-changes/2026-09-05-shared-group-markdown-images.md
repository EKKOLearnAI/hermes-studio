# Shared group Markdown images

- Area: group attachment reads and group message image rendering.
- Problem: composer images use room attachments, but local Agents can return Markdown with an absolute image path. Invite viewers tried the protected filesystem API, while the room attachment fallback only recognized structured image blocks.
- Change: group Markdown images use room/invite attachment URLs. The server recognizes image tokens in a saved local Agent assistant message and uses the existing bounded room attachment materialization. Historical messages are supported without rewriting the database. Images load after the final message is saved so a streaming render cannot cache an early 404.
- Access boundary: only image destinations in the requesting room's messages grant access. Human text, code samples, HTML and ordinary file links do not. A remote Agent's path belongs to its own machine and does not authorize reading the room host's filesystem; that Agent must publish the artifact through its existing transfer flow. Existing attachment size/type/quota limits remain in force.
- Clients: Studio share pages require this change. App remote groups also need the companion image-resource routing change; local App groups and single chat keep their existing routing. The cloud already forwards room attachment downloads and needs no change.
- Validation: focused server/renderer tests, an invite-view browser regression, ordinary chat/group browser tests, and a read-only probe using the affected room's actual historical message and image bytes.
