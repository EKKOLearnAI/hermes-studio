import { readSseFrameTexts } from '../sse'

export interface ResponsesStreamAdapterTarget {
  model: string
}

export interface CanonicalResponsesEvent {
  type: string
  data: Record<string, unknown>
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function parseSseFrames(buffer: string): { events: string[]; rest: string } {
  const parsed = readSseFrameTexts(buffer)
  return { events: parsed.frames, rest: parsed.rest }
}

function extractSseData(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
}

function extractSseEventName(event: string): string {
  return event
    .split(/\r?\n/)
    .find(line => line.startsWith('event:'))
    ?.slice(6)
    .trim() || ''
}

export async function* openAiChatSseToResponsesEvents(
  stream: AsyncIterable<Uint8Array>,
  target: ResponsesStreamAdapterTarget,
): AsyncGenerator<CanonicalResponsesEvent> {
  const decoder = new TextDecoder()
  const id = `resp_${Date.now()}`
  const messageId = `msg_${id}`
  let buffer = ''
  let textStarted = false
  let text = ''
  let reasoning = ''
  const toolCalls = new Map<number, { id: string; name: string; arguments: string; added: boolean }>()

  yield {
    type: 'response.created',
    data: {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', model: target.model, output: [] },
    },
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
    buffer = parsed.rest

    for (const event of parsed.events) {
      for (const dataLine of extractSseData(event)) {
        if (!dataLine || dataLine === '[DONE]') continue
        const data = safeJsonParse(dataLine)
        const choice = data?.choices?.[0]
        if (!choice) continue

        const delta = choice.delta || {}
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          reasoning += delta.reasoning_content
          yield {
            type: 'response.reasoning.delta',
            data: {
              type: 'response.reasoning.delta',
              item_id: messageId,
              output_index: 0,
              delta: delta.reasoning_content,
            },
          }
        }

        if (typeof delta.content === 'string' && delta.content) {
          if (!textStarted) {
            textStarted = true
            yield {
              type: 'response.output_item.added',
              data: {
                type: 'response.output_item.added',
                output_index: 0,
                item: {
                  type: 'message',
                  id: messageId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: [],
                },
              },
            }
            yield {
              type: 'response.content_part.added',
              data: {
                type: 'response.content_part.added',
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                part: { type: 'output_text', text: '', annotations: [] },
              },
            }
          }
          text += delta.content
          yield {
            type: 'response.output_text.delta',
            data: {
              type: 'response.output_text.delta',
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              delta: delta.content,
            },
          }
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
            yield {
              type: 'response.output_item.added',
              data: {
                type: 'response.output_item.added',
                output_index: textStarted ? index + 1 : index,
                item: {
                  type: 'function_call',
                  id: call.id,
                  call_id: call.id,
                  name: call.name,
                  arguments: '',
                },
              },
            }
          }
          const argsDelta = toolCall.function?.arguments
          if (typeof argsDelta === 'string' && argsDelta) {
            call.arguments += argsDelta
            yield {
              type: 'response.function_call_arguments.delta',
              data: {
                type: 'response.function_call_arguments.delta',
                item_id: call.id,
                output_index: textStarted ? index + 1 : index,
                delta: argsDelta,
              },
            }
          }
        }
      }
    }
  }

  const output: any[] = []
  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: `rs_${id}`,
      summary: [{ type: 'summary_text', text: reasoning }],
    })
  }
  if (textStarted) {
    const messageItem = {
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    output.push(messageItem)
    yield {
      type: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      },
    }
    yield {
      type: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
    }
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: messageItem,
      },
    }
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
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: callItem,
      },
    }
  }
  yield {
    type: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        id,
        object: 'response',
        status: 'completed',
        model: target.model,
        output,
      },
    },
  }
}

export async function* openAiResponsesSseToResponsesEvents(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<CanonicalResponsesEvent> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
    buffer = parsed.rest

    for (const event of parsed.events) {
      const eventName = extractSseEventName(event)
      for (const dataLine of extractSseData(event)) {
        if (!dataLine || dataLine === '[DONE]') continue
        const data = safeJsonParse(dataLine)
        const type = String(data?.type || eventName || data?.event || '').trim()
        if (!type) continue
        if (!data.type) data.type = type
        yield { type, data }
      }
    }
  }
}

export async function* anthropicMessagesSseToResponsesEvents(
  stream: AsyncIterable<Uint8Array>,
  target: ResponsesStreamAdapterTarget,
): AsyncGenerator<CanonicalResponsesEvent> {
  const decoder = new TextDecoder()
  let id = `resp_${Date.now()}`
  let messageId = `msg_${id}`
  let buffer = ''
  let textStarted = false
  let text = ''
  let reasoning = ''
  const toolBlocks = new Map<number, { id: string; name: string; arguments: string; added: boolean }>()

  yield {
    type: 'response.created',
    data: {
      type: 'response.created',
      response: { id, object: 'response', status: 'in_progress', model: target.model, output: [] },
    },
  }

  const ensureText = function* (): Generator<CanonicalResponsesEvent> {
    if (!textStarted) {
      textStarted = true
      yield {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: messageId, status: 'in_progress', role: 'assistant', content: [] },
        },
      }
      yield {
        type: 'response.content_part.added',
        data: {
          type: 'response.content_part.added',
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
      }
    }
  }

  const ensureTool = function* (index: number, idValue?: string, name?: string): Generator<CanonicalResponsesEvent, { id: string; name: string; arguments: string; added: boolean }> {
    let block = toolBlocks.get(index)
    if (!block) {
      block = { id: idValue || `toolu_${index}`, name: name || 'tool', arguments: '', added: false }
      toolBlocks.set(index, block)
    }
    if (idValue) block.id = idValue
    if (name) block.name = name
    if (!block.added) {
      block.added = true
      yield {
        type: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: textStarted ? index + 1 : index,
          item: { type: 'function_call', id: block.id, call_id: block.id, name: block.name, arguments: '' },
        },
      }
    }
    return block
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
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
          if (delta.type === 'thinking_delta' && delta.thinking) {
            const textDelta = String(delta.thinking)
            reasoning += textDelta
            yield {
              type: 'response.reasoning.delta',
              data: {
                type: 'response.reasoning.delta',
                item_id: messageId,
                output_index: Number(data.index || 0),
                delta: textDelta,
              },
            }
          }
          if (delta.type === 'text_delta' && delta.text) {
            yield* ensureText()
            text += String(delta.text)
            yield {
              type: 'response.output_text.delta',
              data: {
                type: 'response.output_text.delta',
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                delta: String(delta.text),
              },
            }
          }
          if (delta.type === 'input_json_delta' && delta.partial_json) {
            const index = Number(data.index || 0)
            const block = yield* ensureTool(index)
            const argsDelta = String(delta.partial_json)
            block.arguments += argsDelta
            yield {
              type: 'response.function_call_arguments.delta',
              data: {
                type: 'response.function_call_arguments.delta',
                item_id: block.id,
                output_index: textStarted ? index + 1 : index,
                delta: argsDelta,
              },
            }
          }
        }
      }
    }
  }

  const output: any[] = []
  if (reasoning) {
    output.push({
      type: 'reasoning',
      id: `rs_${id}`,
      summary: [{ type: 'summary_text', text: reasoning }],
    })
  }
  if (textStarted) {
    const messageItem = {
      type: 'message',
      id: messageId,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    output.push(messageItem)
    yield {
      type: 'response.output_text.done',
      data: {
        type: 'response.output_text.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        text,
      },
    }
    yield {
      type: 'response.content_part.done',
      data: {
        type: 'response.content_part.done',
        item_id: messageId,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      },
    }
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: 0,
        item: messageItem,
      },
    }
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
    yield {
      type: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item,
      },
    }
  }
  yield {
    type: 'response.completed',
    data: {
      type: 'response.completed',
      response: { id, object: 'response', status: 'completed', model: target.model, output },
    },
  }
}
