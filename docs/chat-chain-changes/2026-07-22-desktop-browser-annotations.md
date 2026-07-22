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

Completed notes remain visible as numbered callouts outside their selection
rectangles. The desktop main process stores those callouts in a closed shadow
tree. DOM callouts follow their live element bounds, region callouts follow page
coordinates, and both are refreshed immediately before adding the screenshot to
the composer, so scrolling cannot detach visible labels from their page targets.

The annotation editor always uses a light input surface so its text remains
readable in either application theme. Active browser tabs now use the shared
theme background and text tokens. Because an Electron `WebContentsView` renders
above Web UI DOM, the browser view is temporarily hidden when an intersecting
modal, drawer, menu, or other supported overlay opens, then restored when that
overlay closes.
