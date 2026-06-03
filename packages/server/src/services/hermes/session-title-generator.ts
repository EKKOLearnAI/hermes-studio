import { getSessionDetail, renameSession, updateSession } from '../../db/hermes/session-store'
import { readConfigYamlForProfile } from '../config-helpers'
import { logger } from '../logger'
import { AgentBridgeClient, type AgentBridgeResponse } from './agent-bridge'

export type SessionTitleSkipReason =
  | 'disabled'
  | 'not_found'
  | 'not_ready'
  | 'manual_title'
  | 'missing_model'
  | 'empty_model_output'
  | 'model_failed'

export interface GenerateSessionTitleResult {
  ok: true
  applied: boolean
  title: string
  reason?: SessionTitleSkipReason
}

interface SessionTitleGenerationConfig {
  enabled?: boolean
  use_chat_model?: boolean
  model?: string
  provider?: string
  prompt?: string
}

interface SessionTitleMessage {
  role?: string
  content?: string
  attachments?: Array<{ name?: string }>
}

const DEFAULT_TITLE_PROMPT = 'Generate a short, clear, neutral session title from the first user message and the first assistant reply. Use 2–4 words only. Focus on the shared topic of those two messages. Avoid generic wording, punctuation, and unnecessary detail. Return the title only.'

export function normalizeTitleText(input: unknown): string {
  return String(input || '').replace(/\s+/g, ' ').trim()
}

export function titleSourceTextFromUserMessage(message: SessionTitleMessage | null | undefined): string {
  if (!message) return ''
  const attachmentTitle = Array.isArray(message.attachments) && message.attachments.length > 0
    ? message.attachments.map(item => normalizeTitleText(item?.name)).filter(Boolean).join(', ')
    : ''
  return normalizeTitleText(attachmentTitle || message.content)
}

export function firstMeaningfulUserMessage(messages: SessionTitleMessage[]): SessionTitleMessage | null {
  return messages.find(message => message?.role === 'user' && !!titleSourceTextFromUserMessage(message)) || null
}

export function firstMeaningfulAssistantMessage(messages: Array<{ role?: string; content?: string }>): { content?: string } | null {
  return messages.find(message => message?.role === 'assistant' && !!normalizeTitleText(message.content)) || null
}

export function buildStandardSessionTitleFromText(text: string): string {
  const normalized = normalizeTitleText(text)
  if (!normalized) return ''
  return normalized.length > 40 ? `${normalized.slice(0, 40)}...` : normalized
}

export function buildStandardSessionTitle(messages: SessionTitleMessage[]): string {
  return buildStandardSessionTitleFromText(titleSourceTextFromUserMessage(firstMeaningfulUserMessage(messages)))
}

export function knownAutomaticTitleVariants(messages: SessionTitleMessage[]): Set<string> {
  const firstUserText = titleSourceTextFromUserMessage(firstMeaningfulUserMessage(messages))
  const variants = new Set<string>([''])
  if (!firstUserText) return variants
  variants.add(firstUserText)
  variants.add(buildStandardSessionTitleFromText(firstUserText))
  variants.add(firstUserText.length > 40 ? `${firstUserText.slice(0, 40)}...` : firstUserText)
  variants.add(firstUserText.slice(0, 100))
  return new Set(Array.from(variants).map(normalizeTitleText))
}

export function isReplaceableAutomaticTitle(currentTitle: unknown, messages: SessionTitleMessage[]): boolean {
  return knownAutomaticTitleVariants(messages).has(normalizeTitleText(currentTitle))
}

function sanitizeGeneratedTitle(raw: string): string {
  const cleaned = normalizeTitleText(raw)
    .replace(/^[-–—•*"'`]+/, '')
    .replace(/[-–—•*"'`]+$/, '')
    .replace(/^title\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const words = cleaned.split(' ').filter(Boolean).slice(0, 4)
  return words.join(' ')
}

function legacyExplicitModelProvider(config: Record<string, any>): { model?: string; provider?: string } {
  const titleConfig = (config.session_title_generation || {}) as SessionTitleGenerationConfig
  if (titleConfig.use_chat_model === false && titleConfig.model && titleConfig.provider) {
    return { model: String(titleConfig.model).trim(), provider: String(titleConfig.provider).trim() }
  }
  return {}
}

async function requestTitleFromModel(args: {
  profile: string
  model?: string
  provider?: string
  prompt: string
  input: string
}): Promise<string> {
  const bridge = new AgentBridgeClient({ timeoutMs: 45_000 })
  const response = await bridge.request<AgentBridgeResponse & { content?: string }>({
    action: 'auxiliary_llm',
    task: 'title_generation',
    profile: args.profile,
    messages: [
      { role: 'system', content: args.prompt },
      { role: 'user', content: args.input },
    ],
    temperature: 0.2,
    max_tokens: 32,
    ...(args.model ? { model: args.model } : {}),
    ...(args.provider ? { provider: args.provider } : {}),
  }, { timeoutMs: 45_000 })
  return normalizeTitleText(response.content)
}

export async function generateSessionTitleForSession(sessionId: string, profileOverride?: string): Promise<GenerateSessionTitleResult> {
  const existing = getSessionDetail(sessionId)
  if (!existing) {
    return { ok: true, applied: false, title: '', reason: 'not_found' }
  }

  const profile = profileOverride || existing.profile || 'default'
  const currentTitle = normalizeTitleText(existing.title)
  let config: Record<string, any> = {}
  try {
    config = await readConfigYamlForProfile(profile)
  } catch (err) {
    logger.warn(err, 'Failed to read session title generation config')
    return { ok: true, applied: false, title: currentTitle, reason: 'disabled' }
  }
  const titleConfig = (config.session_title_generation || {}) as SessionTitleGenerationConfig

  if (titleConfig.enabled !== true) {
    return { ok: true, applied: false, title: currentTitle, reason: 'disabled' }
  }

  const messages = existing.messages || []
  if (!isReplaceableAutomaticTitle(currentTitle, messages)) {
    return { ok: true, applied: false, title: currentTitle, reason: 'manual_title' }
  }

  const firstUser = firstMeaningfulUserMessage(messages)
  const firstAssistant = firstMeaningfulAssistantMessage(messages)
  const firstUserText = titleSourceTextFromUserMessage(firstUser)
  const firstAssistantText = normalizeTitleText(firstAssistant?.content)
  if (!firstUserText || !firstAssistantText) {
    return { ok: true, applied: false, title: currentTitle, reason: 'not_ready' }
  }

  const { model, provider } = legacyExplicitModelProvider(config)
  const prompt = normalizeTitleText(titleConfig.prompt) || DEFAULT_TITLE_PROMPT
  const input = [
    'First user message:',
    firstUserText,
    '',
    'First assistant message:',
    firstAssistantText,
    '',
    'Return only the title.',
  ].join('\n')

  try {
    const generated = await requestTitleFromModel({ profile, model, provider, prompt, input })
    const title = sanitizeGeneratedTitle(generated)
    if (!title) {
      return { ok: true, applied: false, title: currentTitle, reason: 'empty_model_output' }
    }
    if (title !== currentTitle) {
      renameSession(existing.id, title)
      updateSession(existing.id, { last_active: Date.now() } as any)
    }
    return { ok: true, applied: true, title }
  } catch (err: any) {
    logger.warn(err, 'Failed to generate session title')
    return { ok: true, applied: false, title: currentTitle, reason: 'model_failed' }
  }
}

export async function maybeGenerateSessionTitleForSession(sessionId: string, profile?: string): Promise<GenerateSessionTitleResult> {
  const result = await generateSessionTitleForSession(sessionId, profile)
  if (!result.applied) {
    logger.info?.({ sessionId, profile, reason: result.reason }, 'Session title generation skipped')
  }
  return result
}
