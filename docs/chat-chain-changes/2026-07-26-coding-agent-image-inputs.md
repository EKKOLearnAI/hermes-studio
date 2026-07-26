---
date: 2026-07-26
pr: 2222
feature: Coding Agent image inputs
impact: Codex and Claude Code chat sessions now receive uploaded images as native multimodal input instead of serialized attachment JSON.
---

Codex turns pass uploaded image paths through the CLI `--image` option, including resumed native sessions, and generated Codex model catalogs advertise both text and image input so the CLI does not reject its image tools. Claude Code turns with images use stream-json input with base64 image blocks. Scoped protocol adapters preserve initial and tool-result image blocks when translating between Responses, Chat Completions, and Anthropic Messages providers; Chat tool results use a short tool receipt followed by a native user image block so base64 payloads are never tokenized as tool text. Provider capability errors remain visible to the caller without model-name heuristics or silent text-only fallback.
