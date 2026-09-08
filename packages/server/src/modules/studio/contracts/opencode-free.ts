export const OPENCODE_FREE_PROVIDER = 'opencode-free'
export const OPENCODE_FREE_BASE_URL = 'https://opencode.ai/zen/v1'

// Match Hermes' anonymous catalog, excluding the Go-only twin despite its suffix.
export function isOpenCodeFreeModel(model: string): boolean {
  return model.endsWith('-free') && model !== 'ox-alpha-free'
}

/** OpenCode Free shares Zen's per-model API surfaces, as resolved by Hermes. */
export function openCodeFreeRuntime(model: string): {
  baseUrl: string
  apiKey: string
  apiMode: 'chat_completions' | 'anthropic_messages' | 'codex_responses'
} {
  if (!isOpenCodeFreeModel(model)) {
    throw Object.assign(new Error('OpenCode Free requires a free model'), { status: 400 })
  }
  const normalized = model.toLowerCase()
  const apiMode = /^(claude-|qwen)/.test(normalized)
    ? 'anthropic_messages'
    : /^(gpt-|grok-|muse-spark)/.test(normalized)
      ? 'codex_responses'
      : 'chat_completions'
  return { baseUrl: OPENCODE_FREE_BASE_URL, apiKey: '', apiMode }
}
