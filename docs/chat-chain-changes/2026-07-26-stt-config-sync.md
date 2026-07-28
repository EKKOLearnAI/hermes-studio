---
date: 2026-07-26
pr: pending
feature: Mirror Web UI STT provider into the Hermes Agent profile config
impact: Saving a Groq STT provider in Settings -> Voice now also configures Hermes Agent, so gateway platforms transcribe voice messages with the same provider instead of falling back to local.
---

Saving an STT provider whose base URL maps unambiguously to a Hermes Agent
provider now mirrors two values into the profile: the credential is written to
the profile `.env` under the env var Hermes reads, and `stt.enabled` /
`stt.provider` are written to the profile `config.yaml`. Only Groq is mapped for
now, so a generic OpenAI-compatible endpoint is never silently relabelled.

The mirror never fails the request: a write error is logged and the settings
response is unchanged. Web UI transcription keeps using the Web UI settings
store, so browser behaviour is unchanged.

Chat text, session persistence, and message ordering are unchanged.
