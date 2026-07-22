import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMcpToolProvider } from '../../packages/ekko-agent/src/tools/mcp'
import { toAnthropicMessagesPayload } from '../../packages/ekko-agent/src/model/providers/anthropic'
import { toGeminiContentsPayload } from '../../packages/ekko-agent/src/model/providers/gemini'
import { toOpenAIChatPayload } from '../../packages/ekko-agent/src/model/providers/openai-compatible'
import { toOpenAIResponsesPayload } from '../../packages/ekko-agent/src/model/providers/openai-responses'
import type { AgentMessage, ModelProviderConfig } from '../../packages/ekko-agent/src/model/types'

const server = {
  command: process.execPath,
  args: [join(process.cwd(), 'tests/fixtures/fake-mcp-server.cjs')],
}

const config: ModelProviderConfig = {
  id: 'test', type: 'openai-compatible', baseUrl: 'https://example.com/v1', apiKey: 'test', defaultModel: 'vision-model', capabilities: { vision: true },
}

const toolImage: AgentMessage = {
  role: 'tool', toolCallId: 'call-1', name: 'browser_screenshot', content: 'browser screenshot',
  contentParts: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }],
}

describe('Ekko MCP multimodal results', () => {
  it('reuses one MCP process and preserves image content blocks', async () => {
    const provider = createMcpToolProvider()
    const context = { mcpServers: { fake: server }, timeoutMs: 5000 }
    const tools = await provider.listTools(context)
    const pidTool = tools.find(tool => tool.definition.name === 'fake_pid')!
    const first = await pidTool.execute({}, context)
    const second = await pidTool.execute({}, context)
    expect(first.content).toBe(second.content)

    const image = await tools.find(tool => tool.definition.name === 'fake_image')!.execute({}, context)
    expect(image.content).toContain('image result')
    expect(image.content).not.toContain('aGVsbG8=')
    expect(image.contentParts).toEqual([
      { type: 'text', text: 'image result' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
    ])
    expect(JSON.stringify(image.data)).not.toContain('aGVsbG8=')
  })

  it('maps tool images into each visual provider wire format', () => {
    const openai = toOpenAIChatPayload(config, { messages: [toolImage] })
    expect(openai.messages).toHaveLength(2)
    expect(JSON.stringify(openai.messages[1])).toContain('data:image/png;base64,aGVsbG8=')

    const responses = toOpenAIResponsesPayload(config, { messages: [toolImage] })
    expect(JSON.stringify(responses.input)).toContain('input_image')

    const anthropic = toAnthropicMessagesPayload({ ...config, type: 'anthropic' }, { messages: [toolImage] })
    expect(JSON.stringify(anthropic.messages)).toContain('"type":"image"')

    const gemini = toGeminiContentsPayload({ ...config, type: 'gemini' }, { messages: [toolImage] })
    expect(JSON.stringify(gemini.contents)).toContain('inlineData')
  })
})
