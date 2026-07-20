import { Readable } from 'stream'
import type { Context } from 'koa'
import { config } from '../../../config'
import {
  anthropicMessagesUrl as resolveAnthropicMessagesUrl,
  chatCompletionsUrl as resolveChatCompletionsUrl,
  responsesUrl as resolveResponsesUrl,
} from '../endpoint-resolver'
import { sseEvent } from '../sse'
import { AgentTargetRegistry, type AgentTargetInput, type RegisteredAgentTarget } from '../target-registry'
import type { ApiMode } from '../types'
import {
  anthropicToOpenAiChat,
  anthropicToOpenAiResponses,
  openAiResponsesToAnthropicMessage,
  openAiToAnthropicMessage,
} from '../adapters/anthropic'
import {
  openAiChatSseToAnthropicEvents,
  openAiResponsesSseToAnthropicEvents,
  type AnthropicStreamEvent,
} from '../adapters/anthropic-stream'
import {
  anthropicMessagesSseToResponsesEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../adapters/responses-stream'
import { agentRunGateway, ProviderApiError } from '../gateway'
import { teeAsyncIterable } from '../stream-tee'
import { codingAgentRunManager } from '../coding-agent-run-manager'
import { logger } from '../../logger'

export type { ApiMode } from '../types'

export interface ClaudeCodeProxyTargetInput extends AgentTargetInput {}

type ClaudeCodeProxyTarget = RegisteredAgentTarget<ClaudeCodeProxyTargetInput>

const targetRegistry = new AgentTargetRegistry<ClaudeCodeProxyTargetInput>(
  input => [input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId || '', input.chatSessionId || ''],
)
const CLAUDE_PROXY_VISIBLE_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
]

function localProxyBaseUrl(routeKey: string): string {
  return `http://127.0.0.1:${config.port}/api/claude-code-proxy/${routeKey}`
}

export function registerClaudeCodeProxyTarget(input: ClaudeCodeProxyTargetInput): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register(input)

  return { baseUrl: localProxyBaseUrl(target.routeKey), token: target.token, routeKey: target.routeKey }
}

function findTarget(routeKey: string): ClaudeCodeProxyTarget | null {
  return targetRegistry.find(routeKey)
}

function authToken(ctx: Context): string {
  const apiKey = ctx.get('x-api-key').trim()
  if (apiKey) return apiKey
  const auth = ctx.get('authorization').trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function requireTarget(ctx: Context): ClaudeCodeProxyTarget | null {
  const target = findTarget(String(ctx.params.key || ''))
  if (!target) {
    ctx.status = 404
    ctx.body = { type: 'error', error: { type: 'not_found_error', message: 'Claude proxy target not found' } }
    return null
  }
  if (authToken(ctx) !== target.token) {
    ctx.status = 401
    ctx.body = { type: 'error', error: { type: 'authentication_error', message: 'Invalid Claude proxy token' } }
    return null
  }
  return target
}

function anthropicMessagesUrl(target: ClaudeCodeProxyTarget): string {
  return resolveAnthropicMessagesUrl(target.baseUrl)
}

function anthropicRequestBody(body: any, target: ClaudeCodeProxyTarget): any {
  return {
    ...body,
    model: target.model,
  }
}

const OPAQUE_THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

type OpaqueThinkingSanitization = {
  body: any
  removedBlocks: number
  removedMessages: number
}

function withoutOpaqueThinkingHistory(body: any): OpaqueThinkingSanitization | null {
  if (!Array.isArray(body?.messages)) return null
  let removedBlocks = 0
  let removedMessages = 0
  const messages: any[] = []

  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) {
      messages.push(message)
      continue
    }
    const content = message.content.filter((block: any) => {
      const strip = OPAQUE_THINKING_BLOCK_TYPES.has(String(block?.type || ''))
      if (strip) removedBlocks += 1
      return !strip
    })
    if (content.length === 0 && message.content.length > 0) {
      removedMessages += 1
      continue
    }
    messages.push(content.length === message.content.length ? message : { ...message, content })
  }

  if (removedBlocks === 0 || messages.length === 0) return null
  return {
    body: { ...body, messages },
    removedBlocks,
    removedMessages,
  }
}

const ENCRYPTED_CONTENT_MESSAGE = /^Encrypted content could not be decrypted or parsed\.?$/i
const ENCRYPTED_CONTENT_VERIFICATION_MESSAGE = /^The encrypted content [^\r\n]+ could not be verified\. Reason: Encrypted content could not be decrypted or parsed\.?$/i

function isCustomEncryptedContentFailure(target: ClaudeCodeProxyTarget, error: unknown): boolean {
  if (!target.provider.startsWith('custom:') || !(error instanceof ProviderApiError) || error.status !== 400) return false
  const providerError = error.providerError as any
  if (providerError?.error?.code === 'invalid_encrypted_content') return true
  const message = String(providerError?.error?.message || '')
  return ENCRYPTED_CONTENT_MESSAGE.test(message) || ENCRYPTED_CONTENT_VERIFICATION_MESSAGE.test(message)
}

async function withCustomEncryptedContentRetry<T>(
  target: ClaudeCodeProxyTarget,
  body: any,
  request: (nextBody: any) => Promise<T>,
): Promise<T> {
  try {
    return await request(body)
  } catch (error) {
    if (!isCustomEncryptedContentFailure(target, error)) throw error
    const sanitization = withoutOpaqueThinkingHistory(body)
    if (!sanitization) {
      loggerLikeWarn({
        provider: target.provider,
        status: 400,
        retryStarted: false,
      }, '[claude-code-proxy] encrypted-thinking compatibility retry skipped')
      throw error
    }
    loggerLikeWarn({
      provider: target.provider,
      status: 400,
      removedBlocks: sanitization.removedBlocks,
      removedMessages: sanitization.removedMessages,
      retryStarted: true,
    }, '[claude-code-proxy] retrying without historical opaque thinking')
    try {
      return await request(sanitization.body)
    } catch (retryError) {
      const providerError = retryError instanceof ProviderApiError ? retryError.providerError as any : null
      loggerLikeWarn({
        provider: target.provider,
        status: retryError instanceof ProviderApiError ? retryError.status : null,
        code: String(providerError?.error?.code || ''),
        retryFailed: true,
      }, '[claude-code-proxy] encrypted-thinking compatibility retry failed')
      throw retryError
    }
  }
}

async function callAnthropicMessages(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Claude proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  return withCustomEncryptedContentRetry(target, body, nextBody => agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: anthropicRequestBody(nextBody, target),
  }))
}

async function callOpenAiChat(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Claude proxy MVP only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  return agentRunGateway.completeJson({
    url: resolveChatCompletionsUrl(target.baseUrl),
    apiKey: target.apiKey,
    body: anthropicToOpenAiChat(body, target),
  })
}

async function callOpenAiResponses(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Claude proxy responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  return agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    body: anthropicToOpenAiResponses(body, target),
  })
}

function anthropicEventStream(events: AsyncIterable<AnthropicStreamEvent>): Readable {
  async function* generate() {
    for await (const event of events) {
      yield sseEvent(event.type, event.data)
    }
  }
  return Readable.from(generate())
}

function observeResponsesEvents(target: ClaudeCodeProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>) {
  void (async () => {
    try {
      for await (const event of events) {
        codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, event)
        codingAgentRunManager.handleResponseEvent(target.agentSessionId, event)
      }
    } catch (err) {
      loggerLikeWarn(err, '[claude-code-proxy] failed to observe provider stream')
    }
  })()
}

function loggerLikeWarn(err: unknown, message: string) {
  logger.warn(err, message)
}

async function openAiChatToAnthropicSseStream(target: ClaudeCodeProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Claude proxy MVP only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: resolveChatCompletionsUrl(target.baseUrl),
    apiKey: target.apiKey,
    body: anthropicToOpenAiChat(body, target, true),
  })
  const [clientStream, observerStream] = teeAsyncIterable(stream)
  observeResponsesEvents(target, openAiChatSseToResponsesEvents(observerStream, target))
  return anthropicEventStream(openAiChatSseToAnthropicEvents(clientStream, target))
}

async function anthropicMessagesSseStream(target: ClaudeCodeProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Claude proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await withCustomEncryptedContentRetry(target, body, nextBody => agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: anthropicRequestBody(nextBody, target),
  }))
  const [clientStream, observerStream] = teeAsyncIterable(stream)
  observeResponsesEvents(target, anthropicMessagesSseToResponsesEvents(observerStream, target))
  return Readable.from(clientStream)
}

async function openAiResponsesToAnthropicSseStream(target: ClaudeCodeProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Claude proxy responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    body: anthropicToOpenAiResponses(body, target, true),
  })
  const [clientStream, observerStream] = teeAsyncIterable(stream)
  observeResponsesEvents(target, openAiResponsesSseToResponsesEvents(observerStream))
  return anthropicEventStream(openAiResponsesSseToAnthropicEvents(clientStream, target))
}

export async function claudeProxyModels(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  const ids = [...new Set([...CLAUDE_PROXY_VISIBLE_MODELS, target.model])]
  ctx.body = {
    data: ids.map(id => ({
      type: 'model',
      id,
      display_name: id,
      created_at: '2026-01-01T00:00:00Z',
    })),
    has_more: false,
    first_id: ids[0],
    last_id: ids[ids.length - 1],
  }
}

export async function claudeProxyMessages(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    const requestBody = ctx.request.body || {}
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesSseStream(target, requestBody)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesToAnthropicSseStream(target, requestBody)
          : await openAiChatToAnthropicSseStream(target, requestBody)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      const message = target.apiMode === 'anthropic_messages'
        ? await callAnthropicMessages(target, requestBody)
        : target.apiMode === 'codex_responses'
          ? openAiResponsesToAnthropicMessage(await callOpenAiResponses(target, requestBody), target)
          : openAiToAnthropicMessage(await callOpenAiChat(target, requestBody), target)
      ctx.body = message
    }
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = {
      type: 'error',
      error: {
        type: 'api_error',
        message: err?.message || 'Claude proxy request failed',
        provider_error: err?.providerError,
      },
    }
  }
}
