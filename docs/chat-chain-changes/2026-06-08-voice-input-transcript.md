---
date: 2026-06-08
pr: pending
feature: Editable voice input transcript
impact: Adds microphone capture controls that place transcribed speech into the chat composer so users can review or edit before sending.
---

The chat input now owns voice capture state, transcript overlay display, and insertion of the final transcript into the existing composer draft.

Voice capture labels, overlay diagnostics, and browser/microphone errors now use locale strings. The transcript overlay is fixed within the mobile viewport so it does not overflow narrow screens.

The transcript overlay background and text colors now follow theme variables so light mode does not render the tip as a dark block.
