---
date: 2026-08-06
pr: 2389
feature: Chat tool panel expansion transition
impact: Single-chat and Group Chat tool panels now expand and collapse like resizable sidebars while the native desktop browser viewport stays hidden until the opening transition completes.
---

Desktop tool drawers animate their width together with the chat surface, while
mobile drawers retain a full-width directional slide and reduced-motion users
receive an effectively immediate transition. Pointer interactions are disabled
during the transition so resize geometry cannot be changed mid-animation.

The Electron browser viewport remains hidden while its containing drawer is
animating and resynchronizes after visibility changes, avoiding native-view
content appearing outside the expanding panel.

RTL mobile transitions use the transitioning panel's inherited direction
instead of a scoped global root selector. This keeps the slide direction
mirrored without applying the transition transform to the document root.
