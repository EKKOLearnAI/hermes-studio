---
date: 2026-06-20
pr: 1684
feature: Session conversation message null guard
impact: Session detail loading now tolerates missing messages arrays instead of throwing a 500, which keeps conversation history pages resilient to incomplete payloads.
---
