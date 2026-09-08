import type { ChatCodingAgentId } from '@/api/coding-agents'

const SCOPED_EXTERNAL_AGENT_AUTH_PROVIDERS = new Set([
  'openai-codex',
  'copilot',
  'xai-oauth',
  'qwen-oauth',
  'nous',
  'claude-oauth',
  'minimax-oauth',
])

export function isAuthModelProvider(provider?: string): boolean {
  return SCOPED_EXTERNAL_AGENT_AUTH_PROVIDERS.has(String(provider || '').trim().toLowerCase())
}

export function canScopedCodingAgentUseProvider(
  agentId: ChatCodingAgentId,
  provider?: string,
): boolean {
  return agentId === 'ekko-agent' || !isAuthModelProvider(provider)
}

export function usesServerManagedProviderAuth(
  agentId: ChatCodingAgentId,
  provider?: string,
): boolean {
  return agentId === 'ekko-agent' && isAuthModelProvider(provider)
}

export function isKeylessModelProvider(provider?: string): boolean {
  return provider === 'opencode-free'
}

export function openCodeFreeApiMode(model: string): 'chat_completions' | 'anthropic_messages' | 'codex_responses' {
  const normalized = model.toLowerCase()
  if (/^(claude-|qwen)/.test(normalized)) return 'anthropic_messages'
  if (/^(gpt-|grok-|muse-spark)/.test(normalized)) return 'codex_responses'
  return 'chat_completions'
}
