---
date: 2026-08-18
feature: chat-auto-direction-remaining-surfaces
pr: 2614
impact: The chat header title, search result title and snippet, subagent goal, and outline entries take their direction from their own text. Interface labels are unchanged, as is message rendering.
---

# Direction on the remaining chat surfaces

Message bodies already choose their own direction per block, and the sidebar session item carries `dir="auto"`. Five surfaces showing the same authored text were left without it, so an Arabic session read correctly in the sidebar and came out reordered in the header above it.

Marked now: the header session title in `ChatPanel`, the result title and snippet in `SessionSearchModal`, the subagent goal in `SubagentStreamPanel`, and both the question and heading text in `OutlinePanel`.

Deliberately not marked: `search-title`, `outline-title` and the approval headings. Those are `t()` strings the interface owns, and they must follow the interface locale rather than whatever language the conversation happens to be in.

No change to how messages are rendered, stored, searched or navigated; this is presentation only.
