import { readSseFrameTexts } from '../sse'
import { mapStopReason, shouldPreserveReasoningContent, type AnthropicAdapterTarget } from './anthropic'

export interface AnthropicStreamEvent {
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

function openAiFinishToAnthropic(finishReason: string | null | undefined, sawTool: boolean): string {
  return mapStopReason(finishReason, sawTool)
}

export async function* openAiChatSseToAnthropicEvents(
  stream: AsyncIterable<Uint8Array>,
  target: AnthropicAdapterTarget,
): AsyncGenerator<AnthropicStreamEvent> {
  const decoder = new TextDecoder()
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

  yield {
    type: 'message_start',
    data: {
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
    },
  }

  const ensureThinkingBlock = function* (): Generator<AnthropicStreamEvent, number> {
    if (thinkingBlockIndex == null) {
      thinkingBlockIndex = nextIndex++
      yield {
        type: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: thinkingBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        },
      }
    }
    return thinkingBlockIndex
  }

  const stopThinkingBlock = function* (): Generator<AnthropicStreamEvent> {
    if (thinkingBlockIndex != null && !thinkingBlockStopped) {
      thinkingBlockStopped = true
      yield {
        type: 'content_block_stop',
        data: { type: 'content_block_stop', index: thinkingBlockIndex },
      }
    }
  }

  const ensureTextBlock = function* (): Generator<AnthropicStreamEvent, number> {
    if (!textBlockStarted) {
      textBlockStarted = true
      textBlockIndex = nextIndex
      yield {
        type: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        },
      }
      nextIndex += 1
    }
    return textBlockIndex ?? 0
  }

  const ensureToolBlock = function* (toolIndex: number, id?: string, name?: string): Generator<AnthropicStreamEvent, { blockIndex: number; id: string; name: string; started: boolean }> {
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
      yield {
        type: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: block.blockIndex,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
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
      for (const dataLine of extractSseData(event)) {
        if (!dataLine || dataLine === '[DONE]') continue
        const data = safeJsonParse(dataLine)
        const choice = data?.choices?.[0]
        if (!choice) continue

        const delta = choice.delta || {}
        if (shouldPreserveReasoningContent(target) && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          const index = yield* ensureThinkingBlock()
          yield {
            type: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            },
          }
        }

        if (typeof delta.content === 'string' && delta.content) {
          yield* stopThinkingBlock()
          const index = yield* ensureTextBlock()
          yield {
            type: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index,
              delta: { type: 'text_delta', text: delta.content },
            },
          }
        }

        for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          yield* stopThinkingBlock()
          if (textBlockStarted && !textBlockStopped) {
            textBlockStopped = true
            yield {
              type: 'content_block_stop',
              data: { type: 'content_block_stop', index: textBlockIndex ?? 0 },
            }
          }
          const toolIndex = Number(toolCall.index || 0)
          const block = yield* ensureToolBlock(
            toolIndex,
            toolCall.id ? String(toolCall.id) : undefined,
            toolCall.function?.name ? String(toolCall.function.name) : undefined,
          )
          const argsDelta = toolCall.function?.arguments
          if (typeof argsDelta === 'string' && argsDelta) {
            yield {
              type: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: block.blockIndex,
                delta: { type: 'input_json_delta', partial_json: argsDelta },
              },
            }
          }
        }

        if (choice.finish_reason) stopReason = String(choice.finish_reason)
        if (data?.usage?.completion_tokens) outputTokens = Number(data.usage.completion_tokens)
      }
    }
  }

  yield* stopThinkingBlock()
  if (textBlockStarted && !textBlockStopped) {
    yield {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: textBlockIndex ?? 0 },
    }
  }
  for (const block of toolBlocks.values()) {
    if (block.started) {
      yield {
        type: 'content_block_stop',
        data: { type: 'content_block_stop', index: block.blockIndex },
      }
    }
  }
  yield {
    type: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: openAiFinishToAnthropic(stopReason, toolBlocks.size > 0), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  }
  yield { type: 'message_stop', data: { type: 'message_stop' } }
}
export async function* openAiResponsesSseToAnthropicEvents(
  stream: AsyncIterable<Uint8Array>,
  target: AnthropicAdapterTarget,
): AsyncGenerator<AnthropicStreamEvent> {
  const decoder = new TextDecoder()
  let messageId = `msg_${Date.now()}`
  let buffer = ''
  let textBlockIndex: number | null = null
  let textBlockStopped = false
  let nextIndex = 0
  let stopReason: string | null = null
  let outputTokens = 0
  const toolBlocks = new Map<string, { blockIndex: number; id: string; name: string; argsDeltaSeen: boolean; stopped: boolean }>()

  yield {
    type: 'message_start',
    data: {
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
    },
  }

  const ensureTextBlock = function* (): Generator<AnthropicStreamEvent, number> {
    if (textBlockIndex == null) {
      textBlockIndex = nextIndex++
      yield {
        type: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        },
      }
    }
    return textBlockIndex
  }

  const ensureToolBlock = function* (key: string, id?: string, name?: string): Generator<AnthropicStreamEvent, { blockIndex: number; id: string; name: string; argsDeltaSeen: boolean; stopped: boolean }> {
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
      yield {
        type: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: block.blockIndex,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
      }
    } else {
      if (id) block.id = id
      if (name && block.name === 'tool') block.name = name
    }
    return block
  }

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = parseSseFrames(buffer)
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
            yield {
              type: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: deltaText },
              },
            }
          }
        }

        if (eventType === 'response.output_text.done' && textBlockIndex != null && !textBlockStopped) {
          textBlockStopped = true
          yield {
            type: 'content_block_stop',
            data: { type: 'content_block_stop', index: textBlockIndex },
          }
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
            yield {
              type: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: block.blockIndex,
                delta: { type: 'input_json_delta', partial_json: argsDelta },
              },
            }
          }
        }

        if (eventType === 'response.output_item.done') {
          const item = data?.item || data?.output_item
          if (item?.type === 'function_call') {
            const key = String(item.call_id || item.id || data.output_index || toolBlocks.size)
            const block = yield* ensureToolBlock(key, String(item.call_id || item.id || key), item.name ? String(item.name) : undefined)
            const args = String(item.arguments || '')
            if (args && !block.argsDeltaSeen) {
              yield {
                type: 'content_block_delta',
                data: {
                  type: 'content_block_delta',
                  index: block.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: args },
                },
              }
            }
            if (!block.stopped) {
              block.stopped = true
              yield {
                type: 'content_block_stop',
                data: { type: 'content_block_stop', index: block.blockIndex },
              }
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
    yield {
      type: 'content_block_stop',
      data: { type: 'content_block_stop', index: textBlockIndex },
    }
  }
  for (const block of toolBlocks.values()) {
    if (!block.stopped) {
      yield {
        type: 'content_block_stop',
        data: { type: 'content_block_stop', index: block.blockIndex },
      }
    }
  }
  yield {
    type: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: openAiFinishToAnthropic(stopReason, toolBlocks.size > 0), stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
  }
  yield { type: 'message_stop', data: { type: 'message_stop' } }
}
