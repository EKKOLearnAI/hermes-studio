---
date: 2026-08-21
pr: 2655
feature: Chat model multimodal history compatibility
impact: Ekko Agent remembers Chat targets that reject image_url and strips image parts on later runs while preserving image-capable Chat requests.
---

The first explicit image-format rejection for a provider, endpoint, and model is
retried once without image parts. That text-only decision is held in bounded
process memory, shared by newly created clients, and is intentionally reset by a
server restart.
