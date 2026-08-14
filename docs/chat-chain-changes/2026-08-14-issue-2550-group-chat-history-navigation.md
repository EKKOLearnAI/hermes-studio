---
date: 2026-08-14
pr: pending
feature: Group Chat history loading and complete archive
impact: Live rooms load older messages with retry and viewport anchoring, then link to a read-only complete room transcript after the 600-message live display cap.
---

Group Chat keeps the existing 150-message page size and 600-message live
display boundary. Older-page failures now remain local to history loading and
offer an explicit retry without disrupting the active room.

The complete-history route uses the same authenticated room API and message
presentation, but loads every available room page into a read-only transcript.
It does not connect the realtime room or expose message input and management
actions.
