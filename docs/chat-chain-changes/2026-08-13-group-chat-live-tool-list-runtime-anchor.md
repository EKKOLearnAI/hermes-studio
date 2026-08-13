---
date: 2026-08-13
pr: 2530
feature: Group Chat live Tool list runtime normalization
impact: Real runtime streaming anchors now keep the active Agent/Run card live so completed Tool calls remain in the bounded panel until the run finishes.
---

The client keeps an empty message only while its runtime stream is active. Once the
Agent reports ready, the transient anchor is removed and the persisted Tool trace is
shown once in the normal audit transcript.
