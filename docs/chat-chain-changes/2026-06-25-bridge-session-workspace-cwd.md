---
date: 2026-06-25
pr: 1796
feature: Bridge session workspace cwd
impact: Hermes chat runs now pass the selected workspace into Agent Bridge session cwd handling instead of injecting it into model instructions.
---

Workspace paths are forwarded to chat runs and context estimates so Hermes Agent tools resolve relative paths from the session workspace.
