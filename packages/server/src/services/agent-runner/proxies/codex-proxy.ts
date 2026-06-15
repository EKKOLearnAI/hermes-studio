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
import { logger } from '../../logger'

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

function contentCharLength(content: any): number {
  if (typeof content === 'string') return content.length
  if (content == null) return 0
  try {
    return JSON.stringify(content).length
  } catch {
    return 0
  }
}

function summarizeContentBlocks(content: any): any {
  if (!Array.isArray(content)) return { content_chars: contentCharLength(content) }
  return {
    content_blocks: content.map((block: any, index: number) => ({
      index,
      type: block?.type,
      text_chars: typeof block?.text === 'string'
        ? block.text.length
        : typeof block?.input_text === 'string'
          ? block.input_text.length
          : typeof block?.output_text === 'string'
            ? block.output_text.length
            : undefined,
      tool_use_id: block?.tool_use_id,
      id: block?.id,
      name: block?.name,
      input_chars: contentCharLength(block?.input),
      content_chars: block?.text == null && block?.input_text == null && block?.output_text == null
        ? contentCharLength(block?.content)
        : undefined,
    })),
  }
}

function summarizeTools(tools: any): any[] {
  if (!Array.isArray(tools)) return []
  return tools.map((tool: any, index: number) => ({
    index,
    type: tool?.type,
    name: tool?.function?.name || tool?.name,
    description: tool?.function?.description || tool?.description,
    parameters: tool?.function?.parameters || tool?.parameters || tool?.input_schema,
  }))
}

function summarizeMessages(messages: any[]): any[] {
  return messages.map((message, index) => ({
    index,
    role: message?.role,
    ...summarizeContentBlocks(message?.content),
    tool_call_id: message?.tool_call_id,
    tool_calls: Array.isArray(message?.tool_calls)
      ? message.tool_calls.map((call: any) => ({
          id: call?.id,
          type: call?.type,
          name: call?.function?.name,
          arguments_chars: typeof call?.function?.arguments === 'string' ? call.function.arguments.length : 0,
        }))
      : undefined,
  }))
}

function summarizeResponsesInput(input: any): any {
  if (!Array.isArray(input)) return { input_chars: contentCharLength(input) }
  return {
    input: input.map((item: any, index: number) => ({
      index,
      type: item?.type,
      role: item?.role,
      id: item?.id,
      call_id: item?.call_id,
      name: item?.name,
      status: item?.status,
      arguments_chars: typeof item?.arguments === 'string' ? item.arguments.length : contentCharLength(item?.arguments),
      ...summarizeContentBlocks(item?.content),
    })),
  }
}

function logCodexProxyRequest(target: CodexProxyTarget, route: 'chat_completions' | 'anthropic_messages' | 'codex_responses', url: string, body: any) {
  logger.info({
    event: 'codex_proxy_upstream_request',
    route,
    provider: target.provider,
    model: target.model,
    apiMode: target.apiMode,
    url,
    stream: body?.stream === true,
    messages: Array.isArray(body?.messages) ? summarizeMessages(body.messages) : undefined,
    ...('input' in Object(body) ? summarizeResponsesInput(body?.input) : {}),
    tools: summarizeTools(body?.tools),
  }, '[codex-proxy] upstream request')
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
  const chatBody = responsesToOpenAiChat(body, target)
  logCodexProxyRequest(target, 'chat_completions', chatCompletionsUrl(target), chatBody)
  return agentRunGateway.completeJson({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    body: chatBody,
  })
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const anthropicBody = responsesToAnthropicMessages(body, target)
  logCodexProxyRequest(target, 'anthropic_messages', anthropicMessagesUrl(target), anthropicBody)
  return agentRunGateway.completeJson({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: anthropicBody,
  })
}

async function callOpenAiResponses(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const responsesBody = { ...body, model: target.model }
  logCodexProxyRequest(target, 'codex_responses', resolveResponsesUrl(target.baseUrl), responsesBody)
  return agentRunGateway.completeJson({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
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

  const chatBody = responsesToOpenAiChat(body, target, true)
  logCodexProxyRequest(target, 'chat_completions', chatCompletionsUrl(target), chatBody)
  const stream = await agentRunGateway.streamBytes({
    url: chatCompletionsUrl(target),
    apiKey: target.apiKey,
    body: chatBody,
  })
  return responsesEventStream(observableResponsesEvents(target, openAiChatSseToResponsesEvents(stream, target)))
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const anthropicBody = responsesToAnthropicMessages(body, target, true)
  logCodexProxyRequest(target, 'anthropic_messages', anthropicMessagesUrl(target), anthropicBody)
  const stream = await agentRunGateway.streamBytes({
    url: anthropicMessagesUrl(target),
    apiKey: target.apiKey,
    headers: {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: anthropicBody,
  })
  return responsesEventStream(observableResponsesEvents(target, anthropicMessagesSseToResponsesEvents(stream, target)))
}

async function openAiResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Codex proxy Responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const responsesBody = { ...body, model: target.model, stream: true }
  logCodexProxyRequest(target, 'codex_responses', resolveResponsesUrl(target.baseUrl), responsesBody)
  const stream = await agentRunGateway.streamBytes({
    url: resolveResponsesUrl(target.baseUrl),
    apiKey: target.apiKey,
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
