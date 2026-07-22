import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

let child: ChildProcessWithoutNullStreams | null = null
let server: Server | null = null
let root = ''

afterEach(async () => {
  child?.kill()
  child = null
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  server = null
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})

function rpcClient(process: ChildProcessWithoutNullStreams) {
  let buffer = ''
  const responses = new Map<number, any>()
  const waiters = new Map<number, (value: any) => void>()
  process.stdout.on('data', chunk => {
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        const response = JSON.parse(line)
        const waiter = waiters.get(response.id)
        if (waiter) { waiters.delete(response.id); waiter(response) } else responses.set(response.id, response)
      }
      newline = buffer.indexOf('\n')
    }
  })
  return async (id: number, method: string, params: Record<string, unknown> = {}) => {
    process.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    const existing = responses.get(id)
    if (existing) { responses.delete(id); return existing }
    return await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${id} timed out`)), 5000)
      waiters.set(id, value => { clearTimeout(timer); resolve(value) })
    })
  }
}

describe('hermes-studio browser MCP toolset', () => {
  it('exposes six bounded tools and returns screenshots as MCP image content', async () => {
    root = await mkdtemp(join(tmpdir(), 'hermes-browser-mcp-'))
    const clients: string[] = []
    let failScreenshot = false
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      response.setHeader('Content-Type', 'application/json')
      if (request.url === '/v1/session') {
        response.end(JSON.stringify({ client_id: 'broker-client-1', session_token: 'session-token' }))
        return
      }
      clients.push(String(request.headers['x-hermes-browser-client'] || ''))
      if (body.method === 'screenshot' && failScreenshot) {
        response.statusCode = 400
        response.end(JSON.stringify({ error: 'capture failed' }))
        return
      }
      const result = body.method === 'screenshot'
        ? { tabId: 'tab-1', url: 'https://example.com/', title: 'Example', mediaType: 'image/png', data: 'AA==', width: 1, height: 1 }
        : body.method === 'snapshot'
          ? { tabId: 'tab-1', snapshotId: 'snapshot-1', text: '@e1 button name="Example"' }
        : { tabs: [{ id: 'tab-1' }] }
      response.end(JSON.stringify({ operation_id: body.operation_id, result }))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test broker did not bind')
    const brokerRoot = join(root, 'desktop-browser')
    await mkdir(brokerRoot, { recursive: true, mode: 0o700 })
    await writeFile(join(brokerRoot, 'broker.json'), JSON.stringify({
      schema: 1, desktopPid: process.pid, endpoint: `http://127.0.0.1:${address.port}/v1`, token: 'test-token', instanceId: 'test', createdAt: new Date().toISOString(),
    }), { mode: 0o600 })

    child = spawn(process.execPath, [join(process.cwd(), 'bin/hermes-studio-mcp.mjs'), 'browser'], {
      env: { ...process.env, HERMES_WEB_UI_HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const rpc = rpcClient(child)
    await rpc(1, 'initialize', { protocolVersion: '2024-11-05' })
    const listed = await rpc(2, 'tools/list')
    expect(listed.result.tools).toHaveLength(6)
    expect(listed.result.tools.map((tool: any) => tool.name)).toContain('hermes_studio_browser_screenshot')
    expect(listed.result.tools.every((tool: any) => !tool.inputSchema.properties.token && !tool.inputSchema.properties.profile)).toBe(true)

    await rpc(3, 'tools/call', { name: 'hermes_studio_browser_tabs', arguments: { action: 'list' } })
    const screenshot = await rpc(4, 'tools/call', { name: 'hermes_studio_browser_screenshot', arguments: { tab_id: 'tab-1' } })
    expect(screenshot.result.content[1]).toEqual({ type: 'image', data: 'AA==', mimeType: 'image/png' })
    expect(clients).toHaveLength(2)
    expect(clients[0]).toBeTruthy()
    expect(clients[0]).toBe(clients[1])

    failScreenshot = true
    const fallback = await rpc(5, 'tools/call', { name: 'hermes_studio_browser_screenshot', arguments: { tab_id: 'tab-1' } })
    expect(fallback.result.content[0].text).toContain('Accessibility snapshot')
    expect(fallback.result.content[0].text).toContain('snapshot-1')

    await rm(join(brokerRoot, 'broker.json'))
    const unavailable = await rpc(6, 'tools/list')
    expect(unavailable.result.tools).toEqual([])
  })
})
