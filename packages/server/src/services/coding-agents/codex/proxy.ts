import { Readable } from 'stream'
import type { Context } from 'koa'
import { config } from '../../../config'
import {
  anthropicMessagesUrl as resolveAnthropicMessagesUrl,
  chatCompletionsUrl as resolveChatCompletionsUrl,
  responsesUrl as resolveResponsesUrl,
} from '../shared/endpoint-resolver'
import { sseEvent } from '../shared/sse'
import { AgentTargetRegistry, type AgentTargetInput, type RegisteredAgentTarget } from '../shared/target-registry'
import type { ApiMode } from '../shared/types'
import {
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
  truncateResponsesToolOutputs,
} from '../shared/adapters/responses'
import {
  anthropicMessagesSseToResponsesEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../shared/adapters/responses-stream'
import { agentRunGateway } from '../shared/gateway'
import { codingAgentRunManager } from '../runtime/run-manager'
import { getSession } from '../../../db/hermes/session-store'

export interface CodexProxyTargetInput extends AgentTargetInput {
  profile: string
}

type CodexProxyTarget = RegisteredAgentTarget<CodexProxyTargetInput>

const targetRegistry = new AgentTargetRegistry<CodexProxyTargetInput>(
  input => [input.profile.trim(), input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId || '', input.chatSessionId || '', input.agentId || '', input.preserveCodexIdentity ? 'preserve-identity' : ''],
)

function localProxyBaseUrl(routeKey: string): string {
  return `http://127.0.0.1:${config.port}/api/codex-proxy/${routeKey}/v1`
}

export function registerCodexProxyTarget(input: CodexProxyTargetInput): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  })

  return { baseUrl: localProxyBaseUrl(target.routeKey), token: target.token, routeKey: target.routeKey }
}

export function restoreCodexProxyTarget(
  input: CodexProxyTargetInput,
  token: string,
): { baseUrl: string; token: string; routeKey: string } {
  const target = targetRegistry.register({
    ...input,
    profile: input.profile.trim(),
  }, { token })

  return { baseUrl: localProxyBaseUrl(target.routeKey), token: target.token, routeKey: target.routeKey }
}

export function revokeCodexProxyTargets(profile: string, provider: string): number {
  const normalizedProfile = String(profile || '').trim()
  const normalizedProvider = String(provider || '').trim()
  return targetRegistry.removeWhere(target => (
    target.profile === normalizedProfile && target.provider === normalizedProvider
  ))
}

function findTarget(routeKey: string): CodexProxyTarget | null {
  return targetRegistry.find(routeKey)
}

function authToken(ctx: Context): string {
  const apiKey = ctx.get('x-api-key').trim()
  if (apiKey) return apiKey
  const auth = ctx.get('authorization').trim()
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function requireTarget(ctx: Context): CodexProxyTarget | null {
  const target = findTarget(String(ctx.params.key || ''))
  if (!target) {
    ctx.status = 404
    ctx.body = { error: { type: 'not_found_error', message: 'Codex proxy target not found' } }
    return null
  }
  if (authToken(ctx) !== target.token) {
    ctx.status = 401
    ctx.body = { error: { type: 'authentication_error', message: 'Invalid Codex proxy token' } }
    return null
  }
  return target
}

function shouldPreserveCodexIdentity(target: CodexProxyTarget): boolean {
  const override = target.chatSessionId ? getSession(target.chatSessionId)?.preserve_codex_identity : null
  return target.agentId === 'codex' &&
    target.apiMode === 'codex_responses' &&
    (override ?? target.preserveCodexIdentity === true)
}

function preservedCodexHeaders(ctx: Context, target: CodexProxyTarget): Record<string, string> {
  if (!shouldPreserveCodexIdentity(target)) return {}
  const headers: Record<string, string> = {}
  const allowedHeaders: Array<[string, string]> = [
    ['user-agent', 'User-Agent'],
    ['originator', 'Originator'],
    ['openai-beta', 'OpenAI-Beta'],
    ['x-openai-client-user-agent', 'X-OpenAI-Client-User-Agent'],
    ['x-stainless-lang', 'X-Stainless-Lang'],
    ['x-stainless-package-version', 'X-Stainless-Package-Version'],
    ['x-stainless-os', 'X-Stainless-OS'],
    ['x-stainless-arch', 'X-Stainless-Arch'],
    ['x-stainless-runtime', 'X-Stainless-Runtime'],
    ['x-stainless-runtime-version', 'X-Stainless-Runtime-Version'],
  ]
  for (const [incoming, outgoing] of allowedHeaders) {
    const value = ctx.get(incoming).trim()
    if (value) headers[outgoing] = value
  }
  return headers
}

function chatCompletionsUrl(target: CodexProxyTarget): string {
  return resolveChatCompletionsUrl(target.baseUrl)
}

function anthropicMessagesUrl(target: CodexProxyTarget): string {
  return resolveAnthropicMessagesUrl(target.baseUrl)
}

async function callOpenAiChat(target: CodexProxyTarget, body: any, ctx: Context): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const chatBody = responsesToOpenAiChat(body, target)
  return agentRunGateway.completeJson({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    headers: preservedCodexHeaders(ctx, target),
    body: chatBody,
  })
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any, ctx: Context): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const anthropicBody = responsesToAnthropicMessages(body, target)
  return agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
      ...preservedCodexHeaders(ctx, target),
    },
    body: anthropicBody,
  })
}

async function callOpenAiResponses(target: CodexProxyTarget, body: any, ctx: Context): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const responsesBody = truncateResponsesToolOutputs({ ...body, model: target.model })
  return agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    headers: preservedCodexHeaders(ctx, target),
    body: responsesBody,
  })
}

function responsesEventStream(events: AsyncIterable<CanonicalResponsesEvent>): Readable {
  async function* generate() {
    for await (const event of events) {
      yield sseEvent(event.type, event.data)
    }
  }
  return Readable.from(generate())
}

function responseEventForCodexClient(target: CodexProxyTarget, event: CanonicalResponsesEvent): CanonicalResponsesEvent {
  if (target.apiMode === 'codex_responses' || event.type !== 'response.completed') return event
  const response = (event.data as any).response
  if (!response?.usage) return event
  const { usage: _usage, ...responseWithoutUsage } = response
  return {
    ...event,
    data: {
      ...event.data,
      response: responseWithoutUsage,
    },
  }
}

function observableResponsesEvents(target: CodexProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>): AsyncIterable<CanonicalResponsesEvent> {
  async function* observe() {
    for await (const event of events) {
      codingAgentRunManager.handleProxyUsageEvent(target.agentSessionId, event)
      const clientEvent = responseEventForCodexClient(target, event)
      codingAgentRunManager.handleResponseEvent(target.agentSessionId, clientEvent)
      yield clientEvent
    }
  }
  return observe()
}

async function openAiChatToResponsesSseStream(target: CodexProxyTarget, body: any, ctx: Context): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const chatBody = responsesToOpenAiChat(body, target, true)
  const stream = await agentRunGateway.streamBytes({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    headers: preservedCodexHeaders(ctx, target),
    body: chatBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
  })))
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any, ctx: Context): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const anthropicBody = responsesToAnthropicMessages(body, target, true)
  const stream = await agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
      ...preservedCodexHeaders(ctx, target),
    },
    body: anthropicBody,
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, {
    ...target,
    annotateMcpToolNamespaces: true,
  })))
}

async function openAiResponsesSseStream(target: CodexProxyTarget, body: any, ctx: Context): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const responsesBody = truncateResponsesToolOutputs({ ...body, model: target.model, stream: true })
  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    headers: preservedCodexHeaders(ctx, target),
    body: responsesBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiResponsesSseToResponsesEvents(stream)))
}

export async function codexProxyResponses(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    const requestBody = ctx.request.body || {}
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesToResponsesSseStream(target, requestBody, ctx)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesSseStream(target, requestBody, ctx)
          : await openAiChatToResponsesSseStream(target, requestBody, ctx)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      ctx.body = target.apiMode === 'anthropic_messages'
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody, ctx), target)
        : target.apiMode === 'codex_responses'
          ? await callOpenAiResponses(target, requestBody, ctx)
          : openAiChatToResponses(await callOpenAiChat(target, requestBody, ctx), target)
    }
  } catch (err: any) {
    ctx.status = err.status || 502
    ctx.body = {
      error: {
        type: 'api_error',
        message: err?.message || 'Codex proxy request failed',
        provider_error: err?.providerError,
      },
    }
  }
}

export async function codexProxyModels(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  ctx.body = {
    object: 'list',
    data: [{
      id: target.model,
      object: 'model',
      created: 0,
      owned_by: target.provider,
    }],
  }
}
