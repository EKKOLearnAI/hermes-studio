export interface AnthropicAdapterTarget {
  provider: string
  model: string
  baseUrl: string
}

export function stringifyContent(value: unknown): string {
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

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}
export function shouldPreserveReasoningContent(target: AnthropicAdapterTarget): boolean {
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

export function anthropicToOpenAiChat(body: any, target: AnthropicAdapterTarget, stream = false): any {
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

export function anthropicToOpenAiResponses(body: any, target: AnthropicAdapterTarget, stream = false): any {
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

export function mapStopReason(reason: string | null | undefined, hasTools: boolean): string {
  if (hasTools) return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'stop_sequence'
  return 'end_turn'
}

export function openAiToAnthropicMessage(data: any, target: AnthropicAdapterTarget): any {
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

export function openAiResponsesToAnthropicMessage(data: any, target: AnthropicAdapterTarget): any {
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
