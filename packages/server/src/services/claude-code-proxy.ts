import { randomBytes } from 'crypto'
import { Readable } from 'stream'
import type { Context } from 'koa'
import { config } from '../config'

export type ApiMode = 'chat_completions' | 'codex_responses' | 'anthropic_messages' | 'bedrock_converse' | 'codex_app_server'

export interface ClaudeCodeProxyTargetInput {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode?: ApiMode
}

interface ClaudeCodeProxyTarget extends ClaudeCodeProxyTargetInput {
  key: string
  routeKey: string
  token: string
  updatedAt: number
}

const targets = new Map<string, ClaudeCodeProxyTarget>()
const CLAUDE_PROXY_VISIBLE_MODELS = [
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-7',
]

function targetKey(provider: string, model: string, apiMode: ApiMode, baseUrl: string): string {
  return `${provider}\0${model}\0${apiMode}\0${baseUrl}`
}

function routeKeyFor(provider: string, model: string, apiMode: ApiMode, baseUrl: string): string {
  return Buffer.from(targetKey(provider, model, apiMode, baseUrl), 'utf-8').toString('base64url')
}

function localProxyBaseUrl(routeKey: string): string {
  return `http://127.0.0.1:${config.port}/api/claude-code-proxy/${routeKey}`
}

export function registerClaudeCodeProxyTarget(input: ClaudeCodeProxyTargetInput): { baseUrl: string; token: string; routeKey: string } {
  const provider = input.provider.trim()
  const model = input.model.trim()
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const apiMode = input.apiMode || 'chat_completions'
  const key = targetKey(provider, model, apiMode, baseUrl)
  const existing = targets.get(key)
  const routeKey = existing?.routeKey || routeKeyFor(provider, model, apiMode, baseUrl)
  const token = existing?.token || `hwui_${randomBytes(24).toString('base64url')}`

  targets.set(key, {
    ...input,
    provider,
    model,
    baseUrl,
    apiMode,
    key,
    routeKey,
    token,
    updatedAt: Date.now(),
  })

  return { baseUrl: localProxyBaseUrl(routeKey), token, routeKey }
}

function findTarget(routeKey: string): ClaudeCodeProxyTarget | null {
  for (const target of targets.values()) {
    if (target.routeKey === routeKey) return target
  }
  return null
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

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'text' in item) return String((item as any).text || '')
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
  }
  if (value == null) return ''
  return JSON.stringify(value)
}

function shouldPreserveReasoningContent(target: ClaudeCodeProxyTarget): boolean {
  const identifier = `${target.provider} ${target.model} ${target.baseUrl}`.toLowerCase()
  return [
    'deepseek',
    'moonshot',
    'kimi',
    'mimo',
    'xiaomimimo',
  ].some(part => identifier.includes(part))
}

function anthropicContentToOpenAiMessages(message: any, preserveReasoningContent = false): any[] {
  const content = message?.content
  if (!Array.isArray(content)) {
    return [{ role: message.role, content: stringifyContent(content) }]
  }

  if (message.role === 'assistant') {
    const textParts: string[] = []
    const reasoningParts: string[] = []
    const toolCalls: any[] = []
    for (const block of content) {
      if (block?.type === 'text') textParts.push(String(block.text || ''))
      if (block?.type === 'thinking' && block.thinking) reasoningParts.push(String(block.thinking))
      if (block?.type === 'redacted_thinking' && preserveReasoningContent) reasoningParts.push('[redacted thinking]')
      if (block?.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id || `tool_${toolCalls.length}`),
          type: 'function',
          function: {
            name: String(block.name || 'tool'),
            arguments: JSON.stringify(block.input || {}),
          },
        })
      }
    }
    const openAiMessage: any = {
      role: 'assistant',
      content: textParts.join('\n') || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    }
    if (preserveReasoningContent && (reasoningParts.length || toolCalls.length)) {
      openAiMessage.reasoning_content = reasoningParts.join('\n') || 'tool call'
    }
    return [openAiMessage]
  }

  const messages: any[] = []
  const textParts: string[] = []
  for (const block of content) {
    if (block?.type === 'text') textParts.push(String(block.text || ''))
    if (block?.type === 'tool_result') {
      if (textParts.length) {
        messages.push({ role: 'user', content: textParts.splice(0).join('\n') })
      }
      messages.push({
        role: 'tool',
        tool_call_id: String(block.tool_use_id || ''),
        content: stringifyContent(block.content),
      })
    }
  }
  if (textParts.length) messages.push({ role: message.role || 'user', content: textParts.join('\n') })
  return messages.length ? messages : [{ role: message.role || 'user', content: '' }]
}

function anthropicToOpenAiChat(body: any, target: ClaudeCodeProxyTarget, stream = false): any {
  const messages: any[] = []
  const preserveReasoningContent = shouldPreserveReasoningContent(target)
  const system = body?.system
  if (system) messages.push({ role: 'system', content: stringifyContent(system) })
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    messages.push(...anthropicContentToOpenAiMessages(message, preserveReasoningContent))
  }

  const tools = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => ({
      type: 'function',
      function: {
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.input_schema || { type: 'object', properties: {} },
      },
    })).filter((tool: any) => tool.function.name)
    : undefined

  return {
    model: target.model,
    messages,
    ...(typeof body?.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function anthropicToOpenAiResponsesInput(message: any): any[] {
  const content = Array.isArray(message?.content) ? message.content : [{ type: 'text', text: stringifyContent(message?.content) }]

  if (message.role === 'assistant') {
    const items: any[] = []
    const textParts: string[] = []
    for (const block of content) {
      if (block?.type === 'text') textParts.push(String(block.text || ''))
      if (block?.type === 'tool_use') {
        if (textParts.length) {
          items.push({ role: 'assistant', content: textParts.splice(0).join('\n') })
        }
        items.push({
          type: 'function_call',
          call_id: String(block.id || `tool_${items.length}`),
          name: String(block.name || 'tool'),
          arguments: JSON.stringify(block.input || {}),
        })
      }
    }
    if (textParts.length) items.push({ role: 'assistant', content: textParts.join('\n') })
    return items
  }

  const items: any[] = []
  const textParts: string[] = []
  for (const block of content) {
    if (block?.type === 'text') textParts.push(String(block.text || ''))
    if (block?.type === 'tool_result') {
      if (textParts.length) {
        items.push({ role: 'user', content: textParts.splice(0).join('\n') })
      }
      items.push({
        type: 'function_call_output',
        call_id: String(block.tool_use_id || ''),
        output: stringifyContent(block.content),
      })
    }
  }
  if (textParts.length) items.push({ role: message.role || 'user', content: textParts.join('\n') })
  return items.length ? items : [{ role: message.role || 'user', content: '' }]
}

function anthropicToOpenAiResponses(body: any, target: ClaudeCodeProxyTarget, stream = false): any {
  const input: any[] = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    input.push(...anthropicToOpenAiResponsesInput(message))
  }

  const tools = Array.isArray(body?.tools)
    ? body.tools.map((tool: any) => ({
      type: 'function',
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      parameters: tool.input_schema || { type: 'object', properties: {} },
    })).filter((tool: any) => tool.name)
    : undefined

  return {
    model: target.model,
    input,
    ...(body?.system ? { instructions: stringifyContent(body.system) } : {}),
    ...(typeof body?.max_tokens === 'number' ? { max_output_tokens: body.max_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
    store: false,
  }
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function mapStopReason(reason: string | null | undefined, hasTools: boolean): string {
  if (hasTools) return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'stop_sequence'
  return 'end_turn'
}

function openAiToAnthropicMessage(data: any, target: ClaudeCodeProxyTarget): any {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const content: any[] = []
  if (shouldPreserveReasoningContent(target) && message.reasoning_content) {
    content.push({ type: 'thinking', thinking: String(message.reasoning_content) })
  }
  if (message.content) content.push({ type: 'text', text: String(message.content) })
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    content.push({
      type: 'tool_use',
      id: String(call.id || `toolu_${content.length}`),
      name: String(call.function?.name || 'tool'),
      input: safeJsonParse(String(call.function?.arguments || '{}')),
    })
  }

  const hasTools = content.some(block => block.type === 'tool_use')
  return {
    id: String(data?.id || `msg_${Date.now()}`),
    type: 'message',
    role: 'assistant',
    model: target.model,
    content,
    stop_reason: mapStopReason(choice.finish_reason, hasTools),
    stop_sequence: null,
    usage: {
      input_tokens: Number(data?.usage?.prompt_tokens || 0),
      output_tokens: Number(data?.usage?.completion_tokens || 0),
    },
  }
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function anthropicMessageToSse(message: any): string {
  let output = ''
  output += sseEvent('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } },
  })

  message.content.forEach((block: any, index: number) => {
    if (block.type === 'text') {
      output += sseEvent('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      if (block.text) output += sseEvent('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
      output += sseEvent('content_block_stop', { type: 'content_block_stop', index })
    } else if (block.type === 'tool_use') {
      output += sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      output += sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      })
      output += sseEvent('content_block_stop', { type: 'content_block_stop', index })
    }
  })

  output += sseEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  })
  output += sseEvent('message_stop', { type: 'message_stop' })
  return output
}

function anthropicMessagesUrl(target: ClaudeCodeProxyTarget): string {
  if (/\/v\d+$/i.test(target.baseUrl)) return `${target.baseUrl}/messages`
  return `${target.baseUrl}/v1/messages`
}

async function readProviderJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text || `Provider returned HTTP ${res.status}` } }
  }
}

function throwProviderError(res: Response, data: any): never {
  const err = new Error(data?.error?.message || `Provider returned HTTP ${res.status}`)
  ;(err as any).status = res.status
  ;(err as any).providerError = data
  throw err
}

function anthropicRequestBody(body: any, target: ClaudeCodeProxyTarget): any {
  return {
    ...body,
    model: target.model,
  }
}

async function callAnthropicMessages(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Claude proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const res = await fetch(anthropicMessagesUrl(target), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicRequestBody(body, target)),
  })
  const data = await readProviderJson(res)
  if (!res.ok) throwProviderError(res, data)
  return data
}

async function callOpenAiChat(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Claude proxy MVP only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicToOpenAiChat(body, target)),
  })
  const data = await readProviderJson(res)
  if (!res.ok) throwProviderError(res, data)
  return data
}

async function callOpenAiResponses(target: ClaudeCodeProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Claude proxy responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const res = await fetch(`${target.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicToOpenAiResponses(body, target)),
  })
  const data = await readProviderJson(res)
  if (!res.ok) throwProviderError(res, data)
  return data
}

function responseOutputText(item: any): string {
  if (item?.type === 'output_text') return String(item.text || '')
  if (item?.type === 'message' && Array.isArray(item.content)) {
    return item.content
      .map((part: any) => {
        if (part?.type === 'output_text' || part?.type === 'text') return String(part.text || '')
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

function openAiResponsesToAnthropicMessage(data: any, target: ClaudeCodeProxyTarget): any {
  const content: any[] = []
  const output = Array.isArray(data?.output) ? data.output : []

  for (const item of output) {
    const text = responseOutputText(item)
    if (text) content.push({ type: 'text', text })
    if (item?.type === 'function_call') {
      content.push({
        type: 'tool_use',
        id: String(item.call_id || item.id || `toolu_${content.length}`),
        name: String(item.name || 'tool'),
        input: safeJsonParse(String(item.arguments || '{}')),
      })
    }
  }

  if (!content.length && data?.output_text) {
    content.push({ type: 'text', text: String(data.output_text) })
  }

  const hasTools = content.some(block => block.type === 'tool_use')
  return {
    id: String(data?.id || `msg_${Date.now()}`),
    type: 'message',
    role: 'assistant',
    model: target.model,
    content,
    stop_reason: hasTools ? 'tool_use' : (data?.status === 'incomplete' ? 'max_tokens' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: Number(data?.usage?.input_tokens || 0),
      output_tokens: Number(data?.usage?.output_tokens || 0),
    },
  }
}

function getReadableStream(res: Response): AsyncIterable<Uint8Array> {
  const body = res.body
  if (!body) throw new Error('Provider returned an empty stream')
  return body as any
}

function parseOpenAiSse(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let cursor = 0
  while (true) {
    const index = buffer.indexOf('\n\n', cursor)
    if (index < 0) break
    events.push(buffer.slice(cursor, index))
    cursor = index + 2
  }
  return { events, rest: buffer.slice(cursor) }
}

function extractSseData(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
}

function openAiFinishToAnthropic(finishReason: string | null | undefined, sawTool: boolean): string {
  return mapStopReason(finishReason, sawTool)
}

async function openAiChatToAnthropicSseStream(target: ClaudeCodeProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Claude proxy MVP only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const res = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicToOpenAiChat(body, target, true)),
  })
  if (!res.ok) {
    let data: any
    const text = await res.text()
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: { message: text || `Provider returned HTTP ${res.status}` } }
    }
    const err = new Error(data?.error?.message || `Provider returned HTTP ${res.status}`)
    ;(err as any).status = res.status
    ;(err as any).providerError = data
    throw err
  }

  const stream = getReadableStream(res)
  const decoder = new TextDecoder()

  async function* generate() {
    const messageId = `msg_${Date.now()}`
    let buffer = ''
    let thinkingBlockIndex: number | null = null
    let thinkingBlockStopped = false
    let textBlockStarted = false
    let textBlockStopped = false
    let textBlockIndex: number | null = null
    let nextIndex = 0
    let stopReason: string | null = null
    let outputTokens = 0
    const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string; started: boolean }>()

    yield sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: target.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })

    const ensureThinkingBlock = function* () {
      if (thinkingBlockIndex == null) {
        thinkingBlockIndex = nextIndex++
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: thinkingBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        })
      }
      return thinkingBlockIndex
    }

    const stopThinkingBlock = function* () {
      if (thinkingBlockIndex != null && !thinkingBlockStopped) {
        thinkingBlockStopped = true
        yield sseEvent('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex })
      }
    }

    const ensureTextBlock = function* () {
      if (!textBlockStarted) {
        textBlockStarted = true
        textBlockIndex = nextIndex
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        })
        nextIndex += 1
      }
      return textBlockIndex ?? 0
    }

    const ensureToolBlock = function* (toolIndex: number, id?: string, name?: string) {
      let block = toolBlocks.get(toolIndex)
      if (!block) {
        block = {
          blockIndex: nextIndex++,
          id: id || `toolu_${toolIndex}`,
          name: name || 'tool',
          started: false,
        }
        toolBlocks.set(toolIndex, block)
      } else {
        if (id) block.id = id
        if (name) block.name = name
      }
      if (!block.started && block.name) {
        block.started = true
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: block.blockIndex,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        })
      }
      return block
    }

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      const parsed = parseOpenAiSse(buffer)
      buffer = parsed.rest

      for (const event of parsed.events) {
        for (const dataLine of extractSseData(event)) {
          if (!dataLine || dataLine === '[DONE]') continue
          const data = safeJsonParse(dataLine)
          const choice = data?.choices?.[0]
          if (!choice) continue

          const delta = choice.delta || {}
          if (shouldPreserveReasoningContent(target) && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            const index = yield* ensureThinkingBlock()
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            })
          }

          if (typeof delta.content === 'string' && delta.content) {
            yield* stopThinkingBlock()
            const index = yield* ensureTextBlock()
            yield sseEvent('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: delta.content },
            })
          }

          for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            yield* stopThinkingBlock()
            if (textBlockStarted && !textBlockStopped) {
              textBlockStopped = true
              yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex ?? 0 })
            }
            const toolIndex = Number(toolCall.index || 0)
            const block = yield* ensureToolBlock(
              toolIndex,
              toolCall.id ? String(toolCall.id) : undefined,
              toolCall.function?.name ? String(toolCall.function.name) : undefined,
            )
            const argsDelta = toolCall.function?.arguments
            if (typeof argsDelta === 'string' && argsDelta) {
              yield sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: block.blockIndex,
                delta: { type: 'input_json_delta', partial_json: argsDelta },
              })
            }
          }

          if (choice.finish_reason) stopReason = String(choice.finish_reason)
          if (data?.usage?.completion_tokens) outputTokens = Number(data.usage.completion_tokens)
        }
      }
    }

    yield* stopThinkingBlock()
    if (textBlockStarted && !textBlockStopped) {
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex ?? 0 })
    }
    for (const block of toolBlocks.values()) {
      if (block.started) {
        yield sseEvent('content_block_stop', { type: 'content_block_stop', index: block.blockIndex })
      }
    }
    yield sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: openAiFinishToAnthropic(stopReason, toolBlocks.size > 0), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    yield sseEvent('message_stop', { type: 'message_stop' })
  }

  return Readable.from(generate())
}

async function anthropicMessagesSseStream(target: ClaudeCodeProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Claude proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const res = await fetch(anthropicMessagesUrl(target), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicRequestBody(body, target)),
  })
  if (!res.ok) {
    const data = await readProviderJson(res)
    throwProviderError(res, data)
  }
  return Readable.from(getReadableStream(res))
}

async function openAiResponsesToAnthropicSseStream(target: ClaudeCodeProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'codex_responses') {
    const err = new Error(`Claude proxy responses adapter only supports codex_responses targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const res = await fetch(`${target.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(anthropicToOpenAiResponses(body, target, true)),
  })
  if (!res.ok) {
    let data: any
    const text = await res.text()
    try {
      data = JSON.parse(text)
    } catch {
      data = { error: { message: text || `Provider returned HTTP ${res.status}` } }
    }
    const err = new Error(data?.error?.message || `Provider returned HTTP ${res.status}`)
    ;(err as any).status = res.status
    ;(err as any).providerError = data
    throw err
  }

  const stream = getReadableStream(res)
  const decoder = new TextDecoder()

  async function* generate() {
    let messageId = `msg_${Date.now()}`
    let buffer = ''
    let textBlockIndex: number | null = null
    let textBlockStopped = false
    let nextIndex = 0
    let stopReason: string | null = null
    let outputTokens = 0
    const toolBlocks = new Map<string, { blockIndex: number; id: string; name: string; argsDeltaSeen: boolean; stopped: boolean }>()

    yield sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: target.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })

    const ensureTextBlock = function* () {
      if (textBlockIndex == null) {
        textBlockIndex = nextIndex++
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      return textBlockIndex
    }

    const ensureToolBlock = function* (key: string, id?: string, name?: string) {
      let block = toolBlocks.get(key)
      if (!block) {
        block = {
          blockIndex: nextIndex++,
          id: id || key || `toolu_${toolBlocks.size}`,
          name: name || 'tool',
          argsDeltaSeen: false,
          stopped: false,
        }
        toolBlocks.set(key, block)
        yield sseEvent('content_block_start', {
          type: 'content_block_start',
          index: block.blockIndex,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        })
      } else {
        if (id) block.id = id
        if (name && block.name === 'tool') block.name = name
      }
      return block
    }

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      const parsed = parseOpenAiSse(buffer)
      buffer = parsed.rest

      for (const event of parsed.events) {
        for (const dataLine of extractSseData(event)) {
          if (!dataLine || dataLine === '[DONE]') continue
          const data = safeJsonParse(dataLine)
          const eventType = data?.type

          if (eventType === 'response.created') {
            messageId = String(data?.response?.id || messageId)
          }

          if (eventType === 'response.output_text.delta') {
            const deltaText = String(data?.delta || data?.text || '')
            if (deltaText) {
              const index = yield* ensureTextBlock()
              yield sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: deltaText },
              })
            }
          }

          if (eventType === 'response.output_text.done' && textBlockIndex != null && !textBlockStopped) {
            textBlockStopped = true
            yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex })
          }

          if (eventType === 'response.output_item.added') {
            const item = data?.item || data?.output_item
            if (item?.type === 'function_call') {
              const key = String(item.call_id || item.id || data.output_index || toolBlocks.size)
              yield* ensureToolBlock(key, String(item.call_id || item.id || key), item.name ? String(item.name) : undefined)
            }
          }

          if (eventType === 'response.function_call_arguments.delta') {
            const key = String(data.call_id || data.item_id || data.output_index || toolBlocks.size)
            const block = yield* ensureToolBlock(key)
            const argsDelta = String(data.delta || '')
            if (argsDelta) {
              block.argsDeltaSeen = true
              yield sseEvent('content_block_delta', {
                type: 'content_block_delta',
                index: block.blockIndex,
                delta: { type: 'input_json_delta', partial_json: argsDelta },
              })
            }
          }

          if (eventType === 'response.output_item.done') {
            const item = data?.item || data?.output_item
            if (item?.type === 'function_call') {
              const key = String(item.call_id || item.id || data.output_index || toolBlocks.size)
              const block = yield* ensureToolBlock(key, String(item.call_id || item.id || key), item.name ? String(item.name) : undefined)
              const args = String(item.arguments || '')
              if (args && !block.argsDeltaSeen) {
                yield sseEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: block.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: args },
                })
              }
              if (!block.stopped) {
                block.stopped = true
                yield sseEvent('content_block_stop', { type: 'content_block_stop', index: block.blockIndex })
              }
            }
          }

          if (eventType === 'response.completed') {
            const response = data?.response || data
            outputTokens = Number(response?.usage?.output_tokens || outputTokens)
            stopReason = response?.status === 'incomplete' ? 'length' : 'stop'
          }
        }
      }
    }

    if (textBlockIndex != null && !textBlockStopped) {
      yield sseEvent('content_block_stop', { type: 'content_block_stop', index: textBlockIndex })
    }
    for (const block of toolBlocks.values()) {
      if (!block.stopped) {
        yield sseEvent('content_block_stop', { type: 'content_block_stop', index: block.blockIndex })
      }
    }
    yield sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: openAiFinishToAnthropic(stopReason, toolBlocks.size > 0), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    yield sseEvent('message_stop', { type: 'message_stop' })
  }

  return Readable.from(generate())
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
