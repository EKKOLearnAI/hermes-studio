import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((item: any) => item?.type === 'text')
    .map((item: any) => String(item.text || ''))
    .join('\n')
}

function lastUserText(context: any): string {
  const messages = Array.isArray(context?.messages) ? context.messages : []
  return textFromContent([...messages].reverse().find((message: any) => message?.role === 'user')?.content)
}

function imageCount(context: any): number {
  const messages = Array.isArray(context?.messages) ? context.messages : []
  return messages.reduce((count: number, message: any) => (
    count + (Array.isArray(message?.content)
      ? message.content.filter((item: any) => item?.type === 'image').length
      : 0)
  ), 0)
}

function assistantMessage(model: any) {
  return {
    role: 'assistant',
    content: [] as any[],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'pending',
    timestamp: Date.now(),
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'e2e_local_tool',
    label: 'E2E local tool',
    description: 'Returns its input for Pi RPC integration tests.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    } as any,
    async execute(_id, params: any) {
      return {
        content: [{ type: 'text', text: `local:${String(params.text || '')}` }],
        details: {},
      }
    },
  } as any)

  pi.registerProvider('hermes-e2e', {
    name: 'Hermes Pi RPC E2E',
    baseUrl: 'http://127.0.0.1',
    api: 'hermes-e2e-api',
    apiKey: 'test-only',
    models: [{
      id: 'e2e-model',
      name: 'E2E Model',
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32_000,
      maxTokens: 4_096,
    }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream()
      ;(async () => {
        const output: any = assistantMessage(model)
        try {
          stream.push({ type: 'start', partial: output })
          const prompt = lastUserText(context)
          const messages = Array.isArray(context?.messages) ? context.messages : []
          const lastMessage = messages.at(-1)

          if (prompt.includes('E2E_FAIL')) throw new Error('intentional Pi provider failure')
          if (prompt.includes('E2E_ABORT')) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, 10_000)
              options?.signal?.addEventListener('abort', () => {
                clearTimeout(timer)
                reject(new Error('aborted by test'))
              }, { once: true })
            })
          }

          if (lastMessage?.role !== 'toolResult' && prompt.includes('E2E_LOCAL_TOOL')) {
            const toolCall = {
              type: 'toolCall',
              id: `local_${Date.now()}`,
              name: 'e2e_local_tool',
              arguments: { text: 'works' },
            }
            output.content.push(toolCall)
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output })
            stream.push({
              type: 'toolcall_end',
              contentIndex: 0,
              toolCall,
              partial: output,
            })
            output.stopReason = 'toolUse'
          } else if (lastMessage?.role !== 'toolResult' && prompt.includes('E2E_MCP_TOOL')) {
            const toolCall = {
              type: 'toolCall',
              id: `mcp_${Date.now()}`,
              name: 'mcp',
              arguments: {
                tool: 'fixture_fixture_echo',
                server: 'fixture',
                args: { text: 'mcp-works' },
              },
            }
            output.content.push(toolCall)
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: output })
            stream.push({
              type: 'toolcall_end',
              contentIndex: 0,
              toolCall,
              partial: output,
            })
            output.stopReason = 'toolUse'
          } else {
            const toolResultText = lastMessage?.role === 'toolResult'
              ? textFromContent(lastMessage.content)
              : ''
            const text = toolResultText
              ? `tool-result:${toolResultText}`
              : `reply:${prompt};messages=${messages.length};images=${imageCount(context)}`
            output.content.push({ type: 'text', text })
            stream.push({ type: 'text_start', contentIndex: 0, partial: output })
            stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: output })
            stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: output })
            output.stopReason = 'stop'
          }

          stream.push({ type: 'done', reason: output.stopReason, message: output })
          stream.end()
        } catch (error) {
          output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
          output.errorMessage = error instanceof Error ? error.message : String(error)
          stream.push({ type: 'error', reason: output.stopReason, error: output })
          stream.end()
        }
      })()
      return stream
    },
  } as any)
}
