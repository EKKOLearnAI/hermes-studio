---
date: 2026-07-10
pr: 2026
feature: Session export filenames
impact: Session exports now continue downloading when the response filename contains a raw percent sign instead of failing with a malformed URI error.
---

The client still decodes valid percent-encoded `Content-Disposition` filenames,
but falls back to the raw filename when decoding encounters a malformed percent
escape. This keeps export responses such as `filename="100% ready.json"` from
throwing before the browser download begins.
