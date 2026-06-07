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
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
} from '../adapters/responses'
import {
  anthropicMessagesSseToResponsesEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../adapters/responses-stream'
import { agentRunGateway } from '../gateway'
import { codingAgentRunManager } from '../coding-agent-run-manager'

export interface CodexProxyTargetInput extends AgentTargetInput {
  profile: string
}

type CodexProxyTarget = RegisteredAgentTarget<CodexProxyTargetInput>

const targetRegistry = new AgentTargetRegistry<CodexProxyTargetInput>(
  input => [input.profile.trim(), input.provider, input.model, input.apiMode, input.baseUrl, input.agentSessionId || '', input.chatSessionId || ''],
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

function chatCompletionsUrl(target: CodexProxyTarget): string {
  return resolveChatCompletionsUrl(target.baseUrl)
}

function anthropicMessagesUrl(target: CodexProxyTarget): string {
  return resolveAnthropicMessagesUrl(target.baseUrl)
}

async function callOpenAiChat(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  return agentRunGateway.completeJson({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    body: responsesToOpenAiChat(body, target),
  })
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  return agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: responsesToAnthropicMessages(body, target),
  })
}

async function callOpenAiResponses(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  return agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    body: { ...body, model: target.model },
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

function observableResponsesEvents(target: CodexProxyTarget, events: AsyncIterable<CanonicalResponsesEvent>): AsyncIterable<CanonicalResponsesEvent> {
  async function* observe() {
    for await (const event of events) {
      codingAgentRunManager.handleResponseEvent(target.agentSessionId, event)
      yield event
    }
  }
  return observe()
}

async function openAiChatToResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    body: responsesToOpenAiChat(body, target, true),
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, target)))
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: responsesToAnthropicMessages(body, target, true),
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, target)))
}

async function openAiResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
    body: { ...body, model: target.model, stream: true },
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
        ? await anthropicMessagesToResponsesSseStream(target, requestBody)
        : target.apiMode === 'codex_responses'
          ? await openAiResponsesSseStream(target, requestBody)
          : await openAiChatToResponsesSseStream(target, requestBody)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      ctx.body = target.apiMode === 'anthropic_messages'
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody), target)
        : target.apiMode === 'codex_responses'
          ? await callOpenAiResponses(target, requestBody)
          : openAiChatToResponses(await callOpenAiChat(target, requestBody), target)
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
