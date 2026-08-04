---
date: 2026-08-04
pr: 2354
feature: Coding-agent stdin delivery
impact: Codex and Claude Code turns now receive multiline and long user input through stdin on every platform, avoiding Windows command-line corruption and truncation.
---

This applies to shared hidden coding-agent runs used by single chat, Group Chat,
and workflows. Fixed CLI flags and paths remain in the process argument list,
while user-provided text uses the same stdin transport on Windows, macOS, and
Linux. On Windows, the text no longer passes through the npm `.cmd` shim or the
`cmd.exe` command-length limit.
