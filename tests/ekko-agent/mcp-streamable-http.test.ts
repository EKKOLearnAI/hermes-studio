import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMcpToolProvider } from '../../packages/ekko-agent/src/tools/mcp'

let server: ReturnType<typeof createServer>
let endpoint = ''
let initializeCount = 0
let apiKeyHeaders: Array<string | undefined> = []

async function readJson(request: IncomingMessage): Promise<any> {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return body ? JSON.parse(body) : {}
}

function json(response: ServerResponse, payload: unknown, session = false) {
  response.statusCode = 200
  response.setHeader('content-type', 'application/json')
  if (session) response.setHeader('mcp-session-id', 'ekko-test-session')
  response.end(JSON.stringify(payload))
}

beforeEach(async () => {
  initializeCount = 0
  apiKeyHeaders = []
  server = createServer(async (request, response) => {
    apiKeyHeaders.push(request.headers['x-api-key'] as string | undefined)
    if (request.method === 'DELETE') {
      response.statusCode = 200
      response.end()
      return
    }
    if (request.method !== 'POST') {
      response.statusCode = 405
      response.end()
      return
    }

    const message = await readJson(request)
    if (message.method === 'initialize') {
      initializeCount++
      json(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
        },
      }, true)
      return
    }
    if (message.method === 'notifications/initialized') {
      response.statusCode = 202
      response.end()
      return
    }
    if (message.method === 'tools/list') {
      expect(request.headers['mcp-session-id']).toBe('ekko-test-session')
      json(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [{
            name: 'remote_echo',
            description: 'Echo over Streamable HTTP',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          }],
        },
      })
      return
    }
    if (message.method === 'tools/call') {
      expect(request.headers['mcp-session-id']).toBe('ekko-test-session')
      json(response, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: `http:${String(message.params.arguments?.text || '')}` }],
        },
      })
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP MCP fixture failed to listen')
  endpoint = `http://127.0.0.1:${address.port}/mcp`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('Ekko Streamable HTTP MCP', () => {
  it('discovers and calls remote tools through the official MCP client', async () => {
    const provider = createMcpToolProvider()
    const context = {
      mcpServers: {
        fetch: {
          type: 'streamable_http',
          url: endpoint,
          headers: { 'x-api-key': 'test-key' },
        },
      },
      timeoutMs: 5_000,
    }

    const tools = await provider.listTools(context)
    expect(tools.map(tool => tool.definition.name)).toEqual(['remote_echo'])
    expect(await tools[0].execute({ text: 'hello' }, context)).toMatchObject({
      ok: true,
      content: 'http:hello',
    })

    await provider.listTools(context)
    expect(initializeCount).toBe(1)
    expect(apiKeyHeaders.every(value => value === 'test-key')).toBe(true)
    await provider.listTools({ mcpServers: {} })
  })
})
