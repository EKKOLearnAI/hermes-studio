---
date: 2026-07-13
pr: pending
feature: Remove Gemini CLI OAuth inference
impact: Hermes Web UI and Ekko Agent no longer expose or call the retired Gemini CLI OAuth provider; Gemini API-key usage remains available.
---

Hermes Agent removed its third-party Gemini CLI OAuth inference provider after
upstream reported a risk of Google account enforcement. Hermes Web UI now
matches that provider surface: the OAuth login routes and modal, Cloud Code
model catalog, stored-auth hooks, and provider preset are removed.

Ekko Agent also does not read Gemini OAuth credentials or call the Code Assist
backend. The regular `gemini` provider remains available through
`GOOGLE_API_KEY` or `GEMINI_API_KEY`.
