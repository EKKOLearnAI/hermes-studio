---
date: 2026-08-08
pr: pending
feature: Group Chat Agent upload messages
impact: Successful remote Agent binary uploads now publish durable image/file attachment messages to the Room using the same content-block format as composer uploads; JSON workspace writes remain silent.
---

- Keep returning the shared-workspace path and checksum from the binary upload API, and also return the generated attachment block and persisted Group Chat message ID.
- Copy each uploaded artifact into the Room's private attachment storage before publishing it so later workspace edits cannot change message history.
- Attribute, persist, and broadcast the attachment as the uploading Agent, with the workspace-relative path as the message body; render Assistant attachment blocks without exposing their storage JSON in the bubble.
- Document the automatic message behavior in both the remote Agent run instructions and generated OpenAPI endpoint description.
