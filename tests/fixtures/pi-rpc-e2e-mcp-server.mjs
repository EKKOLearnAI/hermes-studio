import { createInterface } from 'node:readline'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.id == null) return

  if (request.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'hermes-pi-rpc-e2e', version: '1.0.0' },
      },
    })
    return
  }
  if (request.method === 'ping') {
    send({ jsonrpc: '2.0', id: request.id, result: {} })
    return
  }
  if (request.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        tools: [{
          name: 'fixture_echo',
          description: 'Echoes text for the real Pi MCP regression.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        }],
      },
    })
    return
  }
  if (request.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        content: [{
          type: 'text',
          text: `mcp:${String(request.params?.arguments?.text || '')}`,
        }],
      },
    })
    return
  }
  send({
    jsonrpc: '2.0',
    id: request.id,
    error: { code: -32601, message: `Method not found: ${request.method}` },
  })
})
