---
date: 2026-08-08
pr: pending
feature: MCU Agent runtime selector
impact: MCU users can select Ekko or Hermes from the device page without sharing sessions between runtimes.
---

The ESP32-C3 v1 and v2 device pages now expose an Agent selector. Ekko remains
the default for new devices and for older firmware events that do not carry an
Agent choice. The selected runtime is stored in MCU preferences and included as
`agentRuntime` in voice, interrupt, clear, ready, and status events.

The local Global Agent path and the outbound relay fallback both normalize the
runtime selection. Ekko turns dispatch through `coding_agent` with
`coding_agent_id=ekko-agent`; Hermes turns dispatch through the existing
`global_agent` Agent Bridge path. Both runtimes receive the MCU voice system
instructions.

MCU session IDs now include the runtime suffix (`-ekko` or `-hermes`). This
intentionally prevents history, workspace, in-memory run state, background
tasks, interrupts, and clear operations from being reused across the two Agent
runtimes. Existing unsuffixed MCU sessions remain stored but are not reused.
