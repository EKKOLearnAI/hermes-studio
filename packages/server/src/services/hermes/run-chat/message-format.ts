import { parseAnthropicContentArray } from '../../../lib/llm-json'
import { logger } from '../../logger'
import type { SessionMessage } from './types'

function cleanToolCalls(toolCalls: any): any[] {
  return Array.isArray(toolCalls)
    ? toolCalls
        .filter((tc: any) => tc?.id && String(tc.id).length > 0)
        .map((tc: any) => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
        }))
    : []
}

function hasSendableContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (Array.isArray(content)) {
    return content.some((block: any) => {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'text') return typeof block.text === 'string' && block.text.trim().length > 0
      return Boolean(block.type && block.type !== 'thinking')
    })
  }
  return false
}

function toolCallsToText(toolCalls: any[]): string {
  return toolCalls
    .map((tc: any) => {
      const name = tc?.function?.name || 'unknown'
      let args = typeof tc?.function?.arguments === 'string'
        ? tc.function.arguments
        : JSON.stringify(tc?.function?.arguments ?? {})
      if (args.length > 4000) args = `${args.slice(0, 4000)}...`
      return `[Calling tool: ${name} with arguments: ${args}]`
    })
    .join('\n')
}

export function isAssistantMessageSendable(message: { content?: unknown; tool_calls?: any }): boolean {
  if (hasSendableContent(message.content)) return true
  return cleanToolCalls(message.tool_calls).length > 0
}

/**
 * Convert OpenAI format conversation history to Anthropic format.
 */
export function convertHistoryFormat(messages: any[]): any[] {
  const result: any[] = []

  for (const m of messages) {
    const role = m.role
    const content = m.content || ''
    delete m.reasoning_content
    if (role === 'tool') {
      let pushItem = { ...m }
      pushItem.role = 'user'
      pushItem.content = `[Tool result: ${content}]`
      result.push(pushItem)
      continue
    }

    if (role === 'user') {
      if (typeof content === 'string') {
        result.push({ role: 'user', content: content })
      } else if (Array.isArray(content)) {
        const textParts = content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
        result.push({ role: 'user', content: textParts || JSON.stringify(content) })
      }
      continue
    }
    if (role === 'assistant') {
      const toolCalls = cleanToolCalls(m.tool_calls)
      const item = { ...m }
      delete item.reasoning_content
      if (toolCalls.length > 0 && !hasSendableContent(item.content)) {
        item.content = toolCallsToText(toolCalls)
      }
      delete item.tool_calls
      if (!isAssistantMessageSendable(item)) {
        logger.warn('[chat-run-socket] skipped empty assistant message in conversation history')
        continue
      }
      result.push(item)
      continue
    }
  }
  return result
}

/**
 * Process raw DB messages into client-ready format.
 * Parses Anthropic content blocks, reconstructs tool_call_ids, etc.
 */
export function handleMessage(messages: SessionMessage[], sid: string): any[] {
  let _messages = []
  try {
    _messages = messages
      .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'tool' || m.role === 'command') && m.content !== undefined)
      .map((m, idx, arr) => {
        const msg: any = {
          id: m.id,
          session_id: sid,
          role: m.role,
          content: m.content || '',
          reasoning: m.reasoning || '',
          timestamp: m.timestamp,
        }
        // Convert Anthropic format content to OpenAI format
        if (m.role === 'assistant' && typeof m.content === 'string') {
          let contentToParse = m.content
          const trimmed = m.content.trim()
          if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
            contentToParse = trimmed.slice(1, -1)
            logger.info('[chat-run-socket] resume message %s: double-serialized, removed outer quotes', m.id)
          }

          if (contentToParse.startsWith('[') && contentToParse.endsWith(']')) {
            try {
              const parsedContent = parseAnthropicContentArray(contentToParse)
              const textBlocks: string[] = []
              const toolCalls: any[] = []
              let reasoningContent: string | null = null

              for (const block of parsedContent) {
                if (block.type === 'thinking') {
                  reasoningContent = block.thinking || null
                } else if (block.type === 'text') {
                  textBlocks.push(block.text || '')
                } else if (block.type === 'tool_use') {
                  toolCalls.push({
                    id: block.id,
                    type: 'function',
                    function: {
                      name: block.name,
                      arguments: typeof block.input === 'object' ? JSON.stringify(block.input) : (block.input ?? '{}'),
                    },
                  })
                }
              }

              msg.content = textBlocks.join('') || ''
              if (toolCalls.length > 0) msg.tool_calls = toolCalls
              if (reasoningContent) msg.reasoning = reasoningContent
            } catch (e) {
              logger.warn(e, '[chat-run-socket] failed to parse array content for message %s, keeping original', m.id)
              msg.content = m.content
            }
          }
        } else if (Array.isArray(m.content)) {
          const textBlocks: string[] = []
          const toolCalls: any[] = []
          let reasoningContent: string | null = null

          for (const block of m.content) {
            if (block.type === 'thinking') {
              reasoningContent = block.thinking
            } else if (block.type === 'text') {
              textBlocks.push(block.text)
            } else if (block.type === 'tool_use') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                },
              })
            }
          }

          msg.content = textBlocks.join('') || ''
          if (toolCalls.length > 0) msg.tool_calls = toolCalls
          if (reasoningContent) msg.reasoning = reasoningContent
        }

        if (m.tool_calls?.length) {
          const cleanedToolCalls = cleanToolCalls(m.tool_calls)
          if (cleanedToolCalls.length > 0) msg.tool_calls = cleanedToolCalls
        }

        if (m.role === 'assistant' && !isAssistantMessageSendable(msg)) {
          logger.warn('[chat-run-socket] skipped empty assistant message %s while loading session %s', m.id, sid)
          return null
        }

        // For tool messages, ensure tool_call_id exists
        if (m.role === 'tool') {
          let callId = m.tool_call_id
          if (!callId || callId.length === 0) {
            const prevMsg = arr[idx - 1]
            if (prevMsg?.role === 'assistant' && prevMsg.tool_calls?.length) {
              const tc = prevMsg.tool_calls.find((t: any) => t.function?.name === m.tool_name)
              if (tc?.id) callId = tc.id
            }
          }
          if (!callId || callId.length === 0) return null
          msg.tool_call_id = callId
        }

        if (m.tool_name) msg.tool_name = m.tool_name
        if (m.reasoning) msg.reasoning = m.reasoning
        return msg
      })
      .filter(m => m !== null)
  } catch (error) {
  }
  return _messages
}
