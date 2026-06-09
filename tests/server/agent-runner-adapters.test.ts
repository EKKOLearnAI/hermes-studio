import { describe, expect, it } from 'vitest'
import {
  anthropicMessageToResponses,
  openAiChatToResponses,
  responsesToAnthropicMessages,
  responsesToOpenAiChat,
} from '../../packages/server/src/services/agent-runner/adapters/responses'
import {
  anthropicToOpenAiChat,
  anthropicToOpenAiResponses,
  openAiResponsesToAnthropicMessage,
  openAiToAnthropicMessage,
} from '../../packages/server/src/services/agent-runner/adapters/anthropic'
import {
  openAiChatSseToAnthropicEvents,
  openAiResponsesSseToAnthropicEvents,
  type AnthropicStreamEvent,
} from '../../packages/server/src/services/agent-runner/adapters/anthropic-stream'
import {
  anthropicMessagesSseToResponsesEvents,
  openAiChatSseToResponsesEvents,
  openAiResponsesSseToResponsesEvents,
  type CanonicalResponsesEvent,
} from '../../packages/server/src/services/agent-runner/adapters/responses-stream'

const target = { model: 'test-model' }
const anthropicTarget = { provider: 'deepseek', model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' }

describe('agent runner Responses adapters', () => {
  it('converts Responses input to OpenAI Chat messages and tools', () => {
    const body = {
      instructions: 'be terse',
      max_output_tokens: 16,
      temperature: 0.2,
      top_p: 0.9,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'developer', content: [{ type: 'input_text', text: 'rules' }] },
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
      ],
      tools: [{ type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' } }],
    }

    expect(responsesToOpenAiChat(body, target)).toMatchObject({
      model: 'test-model',
      max_tokens: 16,
      temperature: 0.2,
      top_p: 0.9,
      stream: false,
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'rules' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'search', arguments: '{"q":"x"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'found' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'search', description: 'Search', parameters: { type: 'object' } },
      }],
    })
  })

  it('converts Responses input to Anthropic messages', () => {
    const body = {
      instructions: 'system text',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
        { type: 'function_call_output', call_id: 'call_1', output: [{ text: 'ok' }] },
      ],
      tools: [{ type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
    }

    expect(responsesToAnthropicMessages(body, target, true)).toMatchObject({
      model: 'test-model',
      system: 'system text',
      max_tokens: 4096,
      stream: true,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
    })
  })

  it('converts OpenAI Chat responses to Responses output', () => {
    expect(openAiChatToResponses({
      id: 'chatcmpl_1',
      created: 123,
      choices: [{
	        message: {
	          reasoning_content: 'think',
	          content: 'hi',
	          tool_calls: [{
            id: 'call_1',
            function: { name: 'lookup', arguments: '{"id":1}' },
          }],
        },
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }, target)).toMatchObject({
      id: 'chatcmpl_1',
      object: 'response',
      created_at: 123,
	      model: 'test-model',
	      output: [
	        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      ],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    })
  })

  it('converts Anthropic messages to Responses output', () => {
    expect(anthropicMessageToResponses({
	      id: 'msg_1',
	      content: [
	        { type: 'thinking', thinking: 'anthropic think' },
	        { type: 'text', text: 'hi' },
	        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } },
      ],
      usage: { input_tokens: 4, output_tokens: 5 },
    }, target)).toMatchObject({
      id: 'msg_1',
	      object: 'response',
	      model: 'test-model',
	      output: [
	        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'anthropic think' }] },
	        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi', annotations: [] }] },
	        { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"id":1}' },
      ],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    })
  })
})

async function* encodedChunks(chunks: string[]): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  for (const chunk of chunks) yield encoder.encode(chunk)
}

async function collectEvents(events: AsyncIterable<CanonicalResponsesEvent>): Promise<CanonicalResponsesEvent[]> {
  const collected: CanonicalResponsesEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function collectAnthropicEvents(events: AsyncIterable<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
  const collected: AnthropicStreamEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('agent runner Responses stream adapters', () => {
	  it('normalizes OpenAI Chat SSE text and tool calls to Responses events', async () => {
	    const events = await collectEvents(openAiChatSseToResponsesEvents(encodedChunks([
	      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
	      'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
	      'data: {"choices":[{"delta":{"content":"llo"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"id\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), target))

	    expect(events.map(event => event.type)).toEqual([
	      'response.created',
	      'response.reasoning.delta',
	      'response.output_item.added',
	      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.done',
	      'response.completed',
	    ])
	    expect(events[1].data).toMatchObject({ delta: 'think' })
	    expect(events[4].data).toMatchObject({ delta: 'he' })
	    expect(events[5].data).toMatchObject({ delta: 'llo' })
	    expect(events[6].data).toMatchObject({
	      item: { type: 'function_call', call_id: 'call_1', name: 'lookup' },
	    })
	    expect(events[13].data).toMatchObject({
	      response: {
	        model: 'test-model',
	        status: 'completed',
	        output: [
	          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	          { type: 'message', content: [{ type: 'output_text', text: 'hello' }] },
	          { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
        ],
      },
    })
  })

  it('normalizes Anthropic Messages SSE text and tool calls to Responses events', async () => {
	    const events = await collectEvents(anthropicMessagesSseToResponsesEvents(encodedChunks([
	      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
	      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"think"}}\n\n',
	      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}\r\n\r\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"id\\":1}"}}\n\n',
    ]), target))

	    expect(events.map(event => event.type)).toEqual([
	      'response.created',
	      'response.reasoning.delta',
	      'response.output_item.added',
	      'response.content_part.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.done',
	      'response.completed',
	    ])
	    expect(events[1].data).toMatchObject({ delta: 'think' })
	    expect(events[2].data).toMatchObject({ item: { id: 'msg_msg_1' } })
	    expect(events[5].data).toMatchObject({
	      item: { type: 'function_call', call_id: 'toolu_1', name: 'lookup' },
	    })
	    expect(events[11].data).toMatchObject({
	      response: {
	        id: 'msg_1',
	        output: [
	          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'think' }] },
	          { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
          { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"id":1}' },
        ],
      },
    })
  })

  it('passes native Responses SSE events through as canonical events', async () => {
    const events = await collectEvents(openAiResponsesSseToResponsesEvents(encodedChunks([
      'event: response.created\r\ndata: {"response":{"id":"resp_1"}}\r\n\r\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: [DONE]\n\n',
    ])))

    expect(events).toEqual([
      {
        type: 'response.created',
        data: { type: 'response.created', response: { id: 'resp_1' } },
      },
      {
        type: 'response.output_text.delta',
        data: { type: 'response.output_text.delta', delta: 'hi' },
      },
    ])
  })
})

describe('agent runner Anthropic adapters', () => {
  it('converts Anthropic messages to OpenAI Chat with reasoning_content', () => {
    const body = {
      system: 'system text',
      max_tokens: 32,
      temperature: 0.1,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'need tool' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
    }

    expect(anthropicToOpenAiChat(body, anthropicTarget)).toMatchObject({
      model: 'deepseek-reasoner',
      max_tokens: 32,
      temperature: 0.1,
      stream: false,
      messages: [
        { role: 'system', content: 'system text' },
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'need tool',
          tool_calls: [{
            id: 'toolu_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":1}' },
          }],
        },
        { role: 'tool', tool_call_id: 'toolu_1', content: 'ok' },
      ],
      tools: [{
        type: 'function',
        function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
      }],
    })
  })

  it('converts Anthropic messages to Responses input', () => {
    expect(anthropicToOpenAiResponses({
      system: 'system text',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      ],
      tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    }, anthropicTarget, true)).toMatchObject({
      model: 'deepseek-reasoner',
      instructions: 'system text',
      max_output_tokens: 64,
      stream: true,
      store: false,
      input: [
        { role: 'user', content: 'hello' },
        { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"id":1}' },
        { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
    })
  })

  it('converts OpenAI Chat responses to Anthropic messages', () => {
    expect(openAiToAnthropicMessage({
      id: 'chatcmpl_1',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          reasoning_content: 'thinking',
          content: 'hi',
          tool_calls: [{ id: 'call_1', function: { name: 'lookup', arguments: '{"id":1}' } }],
        },
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }, anthropicTarget)).toMatchObject({
      id: 'chatcmpl_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-reasoner',
      content: [
        { type: 'thinking', thinking: 'thinking' },
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
    })
  })

  it('converts Responses output to Anthropic messages', () => {
    expect(openAiResponsesToAnthropicMessage({
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      ],
      usage: { input_tokens: 5, output_tokens: 6 },
    }, anthropicTarget)).toMatchObject({
      id: 'resp_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-reasoner',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { id: 1 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 6 },
    })
  })
})

describe('agent runner Anthropic stream adapters', () => {
  it('normalizes OpenAI Chat SSE to Anthropic Messages events', async () => {
    const events = await collectAnthropicEvents(openAiChatSseToAnthropicEvents(encodedChunks([
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"id\\":"}}]}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":"tool_calls"}],"usage":{"completion_tokens":7}}\n\n',
    ]), anthropicTarget))

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[1].data).toMatchObject({ content_block: { type: 'thinking' } })
    expect(events[2].data).toMatchObject({ delta: { type: 'thinking_delta', thinking: 'think' } })
    expect(events[5].data).toMatchObject({ delta: { type: 'text_delta', text: 'hi' } })
    expect(events[7].data).toMatchObject({ content_block: { type: 'tool_use', id: 'call_1', name: 'lookup' } })
    expect(events[11].data).toMatchObject({
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 7 },
    })
  })

  it('normalizes Responses SSE to Anthropic Messages events', async () => {
    const events = await collectAnthropicEvents(openAiResponsesSseToAnthropicEvents(encodedChunks([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'data: {"type":"response.output_text.done"}\n\n',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
      'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"id\\":1}"}\n\n',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"id\\":1}"}}\n\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":3}}}\n\n',
    ]), anthropicTarget))

    expect(events.map(event => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ])
    expect(events[2].data).toMatchObject({ delta: { type: 'text_delta', text: 'hi' } })
    expect(events[4].data).toMatchObject({ content_block: { type: 'tool_use', id: 'call_1', name: 'lookup' } })
    expect(events[5].data).toMatchObject({ delta: { type: 'input_json_delta', partial_json: '{"id":1}' } })
    expect(events[7].data).toMatchObject({
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 3 },
    })
  })
})
