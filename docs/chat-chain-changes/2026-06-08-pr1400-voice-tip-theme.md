---
date: 2026-06-08
pr: 1400
feature: Voice input transcript tip theme colors
impact: Voice input listening/transcript tip now follows Web UI theme variables; no chat run, message persistence, or playback behavior changes.
---

The floating voice transcript overlay uses `--bg-input`, `--text-primary`, and `--border-color` instead of Naive popover variables, so light mode renders a light tip and dark mode renders a dark tip. The tip does not render a shadow.
