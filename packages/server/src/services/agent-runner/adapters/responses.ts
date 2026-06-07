export interface ResponsesAdapterTarget {
  model: string
}

export function stringifyContent(value: unknown): string {
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

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
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

function chatRoleForResponsesRole(role: unknown): string {
  const value = String(role || '').trim()
  if (value === 'developer') return 'system'
  if (value === 'system' || value === 'user' || value === 'assistant' || value === 'tool') return value
  return 'user'
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

export function responsesToOpenAiChat(body: any, target: ResponsesAdapterTarget, stream = false): any {
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

export function responsesToAnthropicMessages(body: any, target: ResponsesAdapterTarget, stream = false): any {
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

export function openAiChatToResponses(data: any, target: ResponsesAdapterTarget): any {
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

export function anthropicMessageToResponses(data: any, target: ResponsesAdapterTarget): any {
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
