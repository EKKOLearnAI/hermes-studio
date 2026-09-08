# OpenCode Free

Studio includes the native Hermes `opencode-free` provider without credentials
or a custom-provider entry. It is listed on startup, including on installations
that already have other provider catalog caches. The free catalog is public and
shared across profiles; model visibility and aliases continue to use the existing
Studio settings.

Startup does not modify Hermes `config.yaml`, `.env`, or the default model. Only
an explicit default-model selection writes `model.provider: opencode-free` and
the selected model ID. Chat requests retain the native provider ID, allowing
Hermes to choose the transport and anonymous authentication behavior.

Initialization runs in the background:

- Probe the selected Hermes Python's provider registry with a 5-second timeout.
  Command lookup also runs asynchronously with a 2-second timeout.
- Fetch the public OpenCode catalog without an Authorization header and with an
  8-second timeout. Match Hermes' `-free` catalog filter, excluding the known
  Go-only `ox-alpha-free` model.
- Use the existing Studio catalog cache immediately. With no cache, show a
  loading entry instead of blocking other providers or guessing model IDs.
- Keep a last-good catalog after failures or empty responses. Retry after one
  minute; refresh successful initialization after five minutes. Deduplicate
  initialization and unref retry timers so they cannot keep the server alive.
- If the runtime does not support this provider, keep its entry visible with an
  update message and no selectable models. No automatic Hermes upgrade occurs.

The model settings page and new-chat drawer poll initialization in the background while it is
loading or retrying and stops polling when the page is unmounted. This does not
show a page-wide loading overlay or change the selected model.

These are remote free-tier models. A model appearing in the catalog does not
guarantee successful inference: rate limits and provider outages still apply.

Focused checks:

```sh
npx vitest run tests/server/opencode-free*.test.ts tests/server/provider-create-controller.test.ts tests/server/provider-model-refresh.test.ts
npx playwright test tests/e2e/provider-models.spec.ts
```

Scoped Coding Agents (Claude Code, Codex, Pi, Grok, and OpenCode) also support
this provider without an upstream key. Their generated configurations retain
Studio's local proxy token; the proxy strips stale supplied credentials, fixes
the upstream to OpenCode Zen, and omits upstream Authorization / x-api-key
headers. Existing Codex and Pi proxy restoration supports empty upstream
credentials. Other providers retain credential requirements. Ekko resolves the
same anonymous runtime directly. Global Coding Agent mode continues to use the
agent's own configuration.

API mode follows Hermes' Zen routing: GPT/Grok/Muse Spark use Responses,
Claude/Qwen use Messages, and other free models use Chat Completions. The
new-chat form selects this mode automatically and does not ask for an API key.
