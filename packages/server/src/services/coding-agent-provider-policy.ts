const SCOPED_CODING_AGENT_AUTH_PROVIDERS = new Set([
  'openai-codex',
  'copilot',
  'xai-oauth',
  'qwen-oauth',
  'nous',
  'claude-oauth',
])

export function isScopedCodingAgentAuthProvider(provider: unknown): boolean {
  return SCOPED_CODING_AGENT_AUTH_PROVIDERS.has(String(provider || '').trim().toLowerCase())
}

export function assertScopedCodingAgentProviderAllowed(mode: 'scoped' | 'global', provider: unknown): void {
  if (mode === 'global' || !isScopedCodingAgentAuthProvider(provider)) return
  const err = new Error('Coding agent scoped mode does not support OAuth/subscription providers. Use global mode or select an API-key provider.')
  ;(err as any).status = 400
  throw err
}
