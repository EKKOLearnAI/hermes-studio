import { randomBytes } from 'crypto'
import { Readable } from 'stream'
import type { Context } from 'koa'
import { config } from '../config'
import type { ApiMode } from './claude-code-proxy'

export interface CodexProxyTargetInput {
  profile: string
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  apiMode?: ApiMode
}

interface CodexProxyTarget extends CodexProxyTargetInput {
  key: string
  routeKey: string
  token: string
  updatedAt: number
}

const targets = new Map<string, CodexProxyTarget>()

function targetKey(profile: string, provider: string, model: string, apiMode: ApiMode, baseUrl: string): string {
  return `${profile}\0${provider}\0${model}\0${apiMode}\0${baseUrl}`
}

function routeKeyFor(profile: string, provider: string, model: string, apiMode: ApiMode, baseUrl: string): string {
  return Buffer.from(targetKey(profile, provider, model, apiMode, baseUrl), 'utf-8').toString('base64url')
}

function localProxyBaseUrl(routeKey: string): string {
  return `http://127.0.0.1:${config.port}/api/codex-proxy/${routeKey}/v1`
}

export function registerCodexProxyTarget(input: CodexProxyTargetInput): { baseUrl: string; token: string; routeKey: string } {
  const profile = input.profile.trim()
  const provider = input.provider.trim()
  const model = input.model.trim()
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const apiMode = input.apiMode || 'chat_completions'
  const key = targetKey(profile, provider, model, apiMode, baseUrl)
  const existing = targets.get(key)
  const routeKey = existing?.routeKey || routeKeyFor(profile, provider, model, apiMode, baseUrl)
  const token = existing?.token || `hwui_${randomBytes(24).toString('base64url')}`

  targets.set(key, {
    ...input,
    profile,
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

function findTarget(routeKey: string): CodexProxyTarget | null {
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

function stringifyContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const block = item as any
        if (typeof block.text === 'string') return block.text
        if (typeof block.output === 'string') return block.output
      }
      return JSON.stringify(item)
    }).filter(Boolean).join('\n')
  }
  if (value == null) return ''
  return JSON.stringify(value)
}

function responseContentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return stringifyContent(content)
  return content.map((part: any) => {
    if (typeof part === 'string') return part
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
      return String(part.text || '')
    }
    return stringifyContent(part)
  }).filter(Boolean).join('\n')
}

function responsesInputToChatMessages(body: any): any[] {
  const messages: any[] = []
  if (body?.instructions) {
    messages.push({ role: 'system', content: stringifyContent(body.instructions) })
  }

  const input = body?.input
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
    return messages
  }

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call') {
      const callId = String(item.call_id || item.id || `call_${messages.length}`)
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: String(item.name || 'tool'),
            arguments: String(item.arguments || '{}'),
          },
        }],
      })
      continue
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id || ''),
        content: stringifyContent(item.output),
      })
      continue
    }
    if (item.role) {
      messages.push({
        role: chatRoleForResponsesRole(item.role),
        content: responseContentToText(item.content),
      })
    }
  }

  return messages.length ? messages : [{ role: 'user', content: '' }]
}

function chatRoleForResponsesRole(role: unknown): string {
  const value = String(role || '').trim()
  if (value === 'developer') return 'system'
  if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'user'
}

function responsesToolsToChatTools(tools: unknown): any[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const mapped = tools.map((tool: any) => {
    if (tool?.type !== 'function') return null
    return {
      type: 'function',
      function: {
        name: String(tool.name || ''),
        description: String(tool.description || ''),
        parameters: tool.parameters || { type: 'object', properties: {} },
      },
    }
  }).filter((tool: any) => tool?.function?.name)
  return mapped.length ? mapped : undefined
}

function responsesToOpenAiChat(body: any, target: CodexProxyTarget, stream = false): any {
  const tools = responsesToolsToChatTools(body?.tools)
  return {
    model: target.model,
    messages: responsesInputToChatMessages(body),
    ...(typeof body?.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : {}),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function responsesRoleToAnthropicRole(role: unknown): 'user' | 'assistant' {
  return String(role || '') === 'assistant' ? 'assistant' : 'user'
}

function responsesContentToAnthropicContent(content: unknown, role: 'user' | 'assistant'): any[] {
  const parts = Array.isArray(content) ? content : [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: stringifyContent(content) }]
  const mapped = parts.map((part: any) => {
    if (typeof part === 'string') return { type: 'text', text: part }
    if (part?.type === 'input_text' || part?.type === 'output_text' || part?.type === 'text') {
      return { type: 'text', text: String(part.text || '') }
    }
    return null
  }).filter(Boolean)
  return mapped.length ? mapped : [{ type: 'text', text: '' }]
}

function responsesInputToAnthropicMessages(body: any): any[] {
  const messages: any[] = []
  const input = body?.input
  if (typeof input === 'string') return [{ role: 'user', content: [{ type: 'text', text: input }] }]

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: String(item.call_id || item.id || `toolu_${messages.length}`),
          name: String(item.name || 'tool'),
          input: safeJsonParse(String(item.arguments || '{}')),
        }],
      })
      continue
    }
    if (item.type === 'function_call_output') {
      messages.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: String(item.call_id || ''),
          content: stringifyContent(item.output),
        }],
      })
      continue
    }
    if (item.role) {
      const role = responsesRoleToAnthropicRole(item.role)
      messages.push({
        role,
        content: responsesContentToAnthropicContent(item.content, role),
      })
    }
  }

  return messages.length ? messages : [{ role: 'user', content: [{ type: 'text', text: '' }] }]
}

function responsesToolsToAnthropicTools(tools: unknown): any[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const mapped = tools.map((tool: any) => {
    if (tool?.type !== 'function') return null
    return {
      name: String(tool.name || ''),
      description: String(tool.description || ''),
      input_schema: tool.parameters || { type: 'object', properties: {} },
    }
  }).filter((tool: any) => tool?.name)
  return mapped.length ? mapped : undefined
}

function responsesToAnthropicMessages(body: any, target: CodexProxyTarget, stream = false): any {
  const tools = responsesToolsToAnthropicTools(body?.tools)
  return {
    model: target.model,
    messages: responsesInputToAnthropicMessages(body),
    ...(body?.instructions ? { system: stringifyContent(body.instructions) } : {}),
    ...(typeof body?.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : { max_tokens: 4096 }),
    ...(typeof body?.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(typeof body?.top_p === 'number' ? { top_p: body.top_p } : {}),
    ...(tools?.length ? { tools } : {}),
    stream,
  }
}

function chatCompletionsUrl(target: CodexProxyTarget): string {
  if (/\/v\d+$/i.test(target.baseUrl)) return `${target.baseUrl}/chat/completions`
  return `${target.baseUrl}/v1/chat/completions`
}

function anthropicMessagesUrl(target: CodexProxyTarget): string {
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

function responseId(data: any): string {
  return String(data?.id || `resp_${Date.now()}`)
}

function usageFromChat(data: any) {
  return {
    input_tokens: Number(data?.usage?.prompt_tokens || 0),
    output_tokens: Number(data?.usage?.completion_tokens || 0),
    total_tokens: Number(data?.usage?.total_tokens || 0),
  }
}

function usageFromAnthropic(data: any) {
  const inputTokens = Number(data?.usage?.input_tokens || 0)
  const outputTokens = Number(data?.usage?.output_tokens || 0)
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  }
}

function openAiChatToResponses(data: any, target: CodexProxyTarget): any {
  const choice = data?.choices?.[0] || {}
  const message = choice.message || {}
  const output: any[] = []

  if (message.content) {
    output.push({
      type: 'message',
      id: `msg_${responseId(data)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: String(message.content), annotations: [] }],
    })
  }

  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    output.push({
      type: 'function_call',
      id: String(call.id || `fc_${output.length}`),
      call_id: String(call.id || `call_${output.length}`),
      name: String(call.function?.name || 'tool'),
      arguments: String(call.function?.arguments || '{}'),
    })
  }

  return {
    id: responseId(data),
    object: 'response',
    created_at: Number(data?.created || Math.floor(Date.now() / 1000)),
    status: 'completed',
    model: target.model,
    output,
    usage: usageFromChat(data),
  }
}

function anthropicMessageToResponses(data: any, target: CodexProxyTarget): any {
  const output: any[] = []
  const textParts: string[] = []
  for (const block of Array.isArray(data?.content) ? data.content : []) {
    if (block?.type === 'text' && block.text) textParts.push(String(block.text))
    if (block?.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: String(block.id || `fc_${output.length}`),
        call_id: String(block.id || `call_${output.length}`),
        name: String(block.name || 'tool'),
        arguments: JSON.stringify(block.input || {}),
      })
    }
  }
  if (textParts.length) {
    output.unshift({
      type: 'message',
      id: `msg_${responseId(data)}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textParts.join('\n'), annotations: [] }],
    })
  }

  return {
    id: responseId(data),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: target.model,
    output,
    usage: usageFromAnthropic(data),
  }
}

async function callOpenAiChat(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }
  const res = await fetch(chatCompletionsUrl(target), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(responsesToOpenAiChat(body, target)),
  })
  const data = await readProviderJson(res)
  if (!res.ok) throwProviderError(res, data)
  return data
}

async function callAnthropicMessages(target: CodexProxyTarget, body: any): Promise<any> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
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
    body: JSON.stringify(responsesToAnthropicMessages(body, target)),
  })
  const data = await readProviderJson(res)
  if (!res.ok) throwProviderError(res, data)
  return data
}

function sseEvent(event: string, data: any): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
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

async function openAiChatToResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'chat_completions') {
    const err = new Error(`Codex proxy only supports chat_completions targets, got ${target.apiMode}`)
    ;(err as any).status = 501
    throw err
  }

  const res = await fetch(chatCompletionsUrl(target), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(responsesToOpenAiChat(body, target, true)),
  })
  if (!res.ok) {
    const data = await readProviderJson(res)
    throwProviderError(res, data)
  }

  const stream = getReadableStream(res)
  const decoder = new TextDecoder()

  async function* generate() {
    const id = `resp_${Date.now()}`
    const messageId = `msg_${id}`
    let buffer = ''
    let textStarted = false
    let text = ''
    const toolCalls = new Map<number, { id: string; name: string; arguments: string; added: boolean }>()

    yield sseEvent('response.created', {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', model: target.model, output: [] },
    })

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
          if (typeof delta.content === 'string' && delta.content) {
            if (!textStarted) {
              textStarted = true
              yield sseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                  type: 'message',
                  id: messageId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: [],
                },
              })
              yield sseEvent('response.content_part.added', {
                type: 'response.content_part.added',
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              })
            }
            text += delta.content
            yield sseEvent('response.output_text.delta', {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            })
          }

          for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const index = Number(toolCall.index || 0)
            let call = toolCalls.get(index)
            if (!call) {
              call = {
                id: String(toolCall.id || `call_${index}`),
                name: String(toolCall.function?.name || 'tool'),
                arguments: '',
                added: false,
              }
              toolCalls.set(index, call)
            }
            if (toolCall.id) call.id = String(toolCall.id)
            if (toolCall.function?.name) call.name = String(toolCall.function.name)
            if (!call.added && call.name) {
              call.added = true
              yield sseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: textStarted ? index + 1 : index,
                item: {
                  type: 'function_call',
                  id: call.id,
                  call_id: call.id,
                  name: call.name,
                  arguments: '',
                },
              })
            }
            const argsDelta = toolCall.function?.arguments
            if (typeof argsDelta === 'string' && argsDelta) {
              call.arguments += argsDelta
              yield sseEvent('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                item_id: call.id,
                output_index: textStarted ? index + 1 : index,
                delta: argsDelta,
              })
            }
          }
        }
      }
    }

    const output: any[] = []
    if (textStarted) {
      const messageItem = {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      }
      output.push(messageItem)
      yield sseEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      })
      yield sseEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      })
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: messageItem,
      })
    }

    for (const [index, call] of toolCalls.entries()) {
      const outputIndex = textStarted ? index + 1 : index
      const callItem = {
        type: 'function_call',
        id: call.id,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments || '{}',
      }
      output.push(callItem)
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: callItem,
      })
    }
    yield sseEvent('response.completed', {
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        status: 'completed',
        model: target.model,
        output,
      },
    })
  }

  return Readable.from(generate())
}

function extractSseEventName(event: string): string {
  return event
    .split(/\r?\n/)
    .find(line => line.startsWith('event:'))
    ?.slice(6)
    .trim() || ''
}

async function anthropicMessagesToResponsesSseStream(target: CodexProxyTarget, body: any): Promise<Readable> {
  if (target.apiMode !== 'anthropic_messages') {
    const err = new Error(`Codex proxy Anthropic adapter only supports anthropic_messages targets, got ${target.apiMode}`)
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
    body: JSON.stringify(responsesToAnthropicMessages(body, target, true)),
  })
  if (!res.ok) {
    const data = await readProviderJson(res)
    throwProviderError(res, data)
  }

  const stream = getReadableStream(res)
  const decoder = new TextDecoder()

  async function* generate() {
    let id = `resp_${Date.now()}`
    let messageId = `msg_${id}`
    let buffer = ''
    let textStarted = false
    let text = ''
    const toolBlocks = new Map<number, { id: string; name: string; arguments: string; added: boolean }>()

    yield sseEvent('response.created', {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', model: target.model, output: [] },
    })

    const ensureText = function* () {
      if (!textStarted) {
        textStarted = true
        yield sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
        })
        yield sseEvent('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      }
    }

    const ensureTool = function* (index: number, idValue?: string, name?: string) {
      let block = toolBlocks.get(index)
      if (!block) {
        block = { id: idValue || `toolu_${index}`, name: name || 'tool', arguments: '', added: false }
        toolBlocks.set(index, block)
      }
      if (idValue) block.id = idValue
      if (name) block.name = name
      if (!block.added) {
        block.added = true
        yield sseEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: textStarted ? index + 1 : index,
          item: { type: 'function_call', id: block.id, call_id: block.id, name: block.name, arguments: '' },
        })
      }
      return block
    }

    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      const parsed = parseOpenAiSse(buffer)
      buffer = parsed.rest

      for (const event of parsed.events) {
        const eventName = extractSseEventName(event)
        for (const dataLine of extractSseData(event)) {
          if (!dataLine || dataLine === '[DONE]') continue
          const data = safeJsonParse(dataLine)

          if (eventName === 'message_start' || data?.type === 'message_start') {
            id = String(data?.message?.id || id)
            messageId = `msg_${id}`
          }

          if (eventName === 'content_block_start' || data?.type === 'content_block_start') {
            const contentBlock = data?.content_block || {}
            if (contentBlock.type === 'tool_use') {
              yield* ensureTool(Number(data.index || 0), String(contentBlock.id || ''), String(contentBlock.name || 'tool'))
            }
          }

          if (eventName === 'content_block_delta' || data?.type === 'content_block_delta') {
            const delta = data?.delta || {}
            if (delta.type === 'text_delta' && delta.text) {
              yield* ensureText()
              text += String(delta.text)
              yield sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: String(delta.text),
              })
            }
            if (delta.type === 'input_json_delta' && delta.partial_json) {
              const index = Number(data.index || 0)
              const block = yield* ensureTool(index)
              const argsDelta = String(delta.partial_json)
              block.arguments += argsDelta
              yield sseEvent('response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                item_id: block.id,
                output_index: textStarted ? index + 1 : index,
                delta: argsDelta,
              })
            }
          }
        }
      }
    }

    const output: any[] = []
    if (textStarted) {
      const messageItem = {
        type: 'message',
        id: messageId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      }
      output.push(messageItem)
      yield sseEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      })
      yield sseEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      })
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: messageItem,
      })
    }
    for (const [index, block] of toolBlocks.entries()) {
      const outputIndex = textStarted ? index + 1 : index
      const item = {
        type: 'function_call',
        id: block.id,
        call_id: block.id,
        name: block.name,
        arguments: block.arguments || '{}',
      }
      output.push(item)
      yield sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
      })
    }
    yield sseEvent('response.completed', {
      type: 'response.completed',
      response: { id, object: 'response', status: 'completed', model: target.model, output },
    })
  }

  return Readable.from(generate())
}

export async function codexProxyResponses(ctx: Context) {
  const target = requireTarget(ctx)
  if (!target) return
  try {
    const requestBody = ctx.request.body || {}
    if ((requestBody as any).stream === true) {
      const stream = target.apiMode === 'anthropic_messages'
        ? await anthropicMessagesToResponsesSseStream(target, requestBody)
        : await openAiChatToResponsesSseStream(target, requestBody)
      ctx.set('Content-Type', 'text/event-stream; charset=utf-8')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = stream
    } else {
      ctx.body = target.apiMode === 'anthropic_messages'
        ? anthropicMessageToResponses(await callAnthropicMessages(target, requestBody), target)
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
