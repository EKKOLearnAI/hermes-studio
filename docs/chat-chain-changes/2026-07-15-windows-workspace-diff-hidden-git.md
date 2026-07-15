---
date: 2026-07-15
pr: pending
feature: Hidden Windows workspace-diff Git processes
impact: Starting and completing a chat run no longer flashes console windows while Studio snapshots Git workspace changes on Windows.
---

All Git child processes used by the chat workspace-diff tracker now opt into hidden Windows process creation. This keeps the existing run-change capture behavior while preventing `git.exe` console windows from appearing around normal conversation turns.
