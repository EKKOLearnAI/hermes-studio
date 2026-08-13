---
date: 2026-08-13
pr: 2533
feature: Group Chat completed Tool panel continuity
impact: Agent/Run Tool traces stay in the same bounded newest-first panel during streaming, after completion, and after history reload.
---

The Tool panel remains a view over the existing persisted run messages. Tool entries
are removed from the ordinary transcript so each audit record renders exactly once,
without changing the group-chat runtime protocol or persistence model.
