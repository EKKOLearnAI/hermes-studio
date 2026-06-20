---
date: 2026-06-18
pr: 1640
feature: Token counting (context compressor)
impact: countTokens/countTokensForModel now short-circuit to the cheap CJK-aware heuristic when the input contains a contiguous letter/CJK run longer than 2000 characters, instead of calling the O(n^2) js-tiktoken BPE merge. This prevents the server event loop from hanging at 100% CPU on sessions with long unspaced CJK text. Normal and long space-separated text still use the exact tiktoken path, so token estimates for the common case are unchanged.
---
