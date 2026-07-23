---
date: 2026-07-23
pr: pending
feature: Preserve literal quote characters in chat Markdown
impact: User and assistant prose keeps ASCII single and double quotes while existing non-quote typographic replacements remain enabled.
---

The shared chat Markdown renderer now disables only markdown-it's smart-quote
rule. Literal apostrophes and quotation marks therefore remain byte-faithful in
the rendered message instead of changing to curly Unicode characters.

Other typographer behavior, including dash, ellipsis, and copyright-symbol
replacement, remains unchanged. The focused renderer regression test covers
both quote preservation and that non-quote behavior.
