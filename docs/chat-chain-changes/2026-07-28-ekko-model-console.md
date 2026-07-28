---
date: 2026-07-28
pr: 2246
feature: Ekko model console logging
impact: Ekko model payloads are no longer printed to the process console or sent with internal request metadata.
---

The Web UI model-client adapter no longer prints model request, response,
failure, or protocol-fallback payloads through `console`. Provider-specific
request normalization and automatic protocol fallback remain unchanged, and
the existing structured Ekko run logs continue to provide operational
diagnostics without duplicating model content in the process output.

Internal request metadata remains available to the Ekko runtime for session,
profile, delegation, and memory identity. Provider serializers now omit it
from every outbound HTTP payload instead of applying provider-name-specific
exceptions.
