---
date: 2026-08-25
pr: 2732
feature: Attachment content blocks and group attachment previews
impact: Browser and workflow files retain file content blocks, stored group-chat documents preview through their authenticated attachment URL, user-sent videos play inline in single and group messages, and App group attachments can upload in progress-reporting chunks.
---

Inline video rendering is intentionally limited to user messages; Agent video
attachments keep their existing file behavior. Workspace-originated group
attachments continue to use workspace preview and editing behavior.

App group attachments now open one room-scoped upload session, append ordered
256 KiB chunks, and complete into the same private room attachment store used by
the multipart route. The existing per-room upload count and attachment quotas
still apply; chunks do not consume separate room upload slots.

App relay download failures now retain a stable error code and structured
session diagnostics, including the last confirmed byte and chunk counts. Source
stream failures are reported as `download_source_read_failed`, while expired or
missing sessions remain distinguishable as `download_not_found`.
Downloads with a declared content length now complete as soon as every declared
byte has arrived, avoiding a redundant EOF read that could misclassify a closing
HTTP stream as a failed final chunk.

App media upload and download requests now allow five minutes. Cloud and LAN
relay timeout caps, download-session idle expiry, and single/group chunked-upload
session expiry use the same five-minute window; ordinary HTTP and bridged Socket
requests keep their existing shorter defaults.
