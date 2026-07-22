---
date: 2026-07-22
pr: 2182
feature: Desktop browser annotations
impact: Numbered element and region annotations are added to the current composer as one screenshot with hidden structured context, while annotation notes stay out of the visible text input.
---

The desktop browser supports multiple annotations in one page-level session.
Each note is linked to its highlighted DOM element or region by a numeric marker.
Clicking the browser panel's Send button adds one image attachment to the active
composer, with the JSON available through a collapsed disclosure. The model
input receives the same JSON in a tagged context block, while `display_input`
keeps it out of the visible message body. Ordinary Web UI and existing
attachment flows are unchanged.
