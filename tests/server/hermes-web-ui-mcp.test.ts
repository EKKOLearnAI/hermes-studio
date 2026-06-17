import { createServer } from 'http'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../../package.json'

function writeRpc(child: ChildProcessWithoutNullStreams, id: number, method: string, params?: unknown) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
}

function waitForRpc(responses: Map<number, any>, id: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      if (responses.has(id)) {
        clearInterval(timer)
        resolve(responses.get(id))
        return
      }
      if (Date.now() - started > 5000) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for MCP response ${id}`))
      }
    }, 10)
  })
}

describe('hermes-web-ui MCP server', () => {
  let child: ChildProcessWithoutNullStreams | null = null
  const homes: string[] = []

  afterEach(() => {
    child?.kill()
    child = null
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })

  it('exposes a public Web UI API requester tool', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-mcp-'))
    homes.push(home)
    mkdirSync(join(home, 'profiles', 'research'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'research', '.model-run-token'), 'profile-token\n')
    let chatRunHits = 0

    const server = createServer((req, res) => {
      if (req.url === '/api/openapi.json') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({
          openapi: '3.0.3',
          tags: [
            { name: 'Chat Run', description: 'Chat run operations' },
            { name: 'Testing', description: 'Test helper operations' },
          ],
          paths: {
            '/api/test-public-requester': {
              post: {
                tags: ['Testing'],
                requestBody: {
                  required: false,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                      },
                    },
                  },
                },
              },
            },
            '/api/chat-run/runs': {
              post: {
                tags: ['Chat Run'],
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['input'],
                        properties: {
                          input: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          authorization: req.headers.authorization || '',
          profile: req.headers['x-hermes-profile'] || '',
        }))
        return
      }
      if (req.url?.startsWith('/api/test-public-requester')) {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            method: req.method,
            url: req.url,
            body: raw ? JSON.parse(raw) : null,
            profile: req.headers['x-hermes-profile'],
            authorization: req.headers.authorization,
          }))
        })
        return
      }
      if (req.url === '/api/chat-run/runs') {
        chatRunHits += 1
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({
            ok: true,
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')

    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/hermes-web-ui-mcp.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
        HERMES_WEB_UI_HOME: home,
        HERMES_WEB_UI_PROFILE: 'research',
      },
    })
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).trim().split('\n')) {
        if (!line) continue
        const message = JSON.parse(line)
        responses.set(message.id, message)
      }
    })

    writeRpc(child, 1, 'initialize', {})
    writeRpc(child, 2, 'tools/list')
    writeRpc(child, 3, 'tools/call', {
      name: 'hermes_api_request',
      arguments: {
        method: 'POST',
        path: '/api/test-public-requester',
        query: { q: 'hello' },
        body: { ok: true },
      },
    })
    writeRpc(child, 4, 'resources/list')
    writeRpc(child, 5, 'tools/call', {
      name: 'hermes_api_request',
      arguments: {
        method: 'POST',
        path: '/api/chat-run/runs',
        body: {},
      },
    })
    writeRpc(child, 7, 'tools/call', {
      name: 'hermes_api_openapi_get',
      arguments: {
        path: '/api/chat-run/runs',
        method: 'POST',
      },
    })
    writeRpc(child, 9, 'tools/call', {
      name: 'hermes_api_openapi_get',
      arguments: {},
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({
      name: 'hermes-web-ui-mcp',
      version: pkg.version,
    })
    expect(initialized.result.capabilities).toEqual({ tools: {} })

    const list = await waitForRpc(responses, 2)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_api_request')).toBe(true)

    const response = await waitForRpc(responses, 3)
    const payload = JSON.parse(response.result.content[0].text)
    expect(payload.status).toBe(200)
    expect(payload.body).toMatchObject({
      method: 'POST',
      url: '/api/test-public-requester?q=hello',
      body: { ok: true },
      profile: 'research',
      authorization: 'Bearer profile-token',
    })
    writeRpc(child, 8, 'tools/call', {
      name: 'hermes_api_openapi_get',
      arguments: {
        path: '/api/test-public-requester',
        method: 'POST',
      },
    })

    const resource = await waitForRpc(responses, 4)
    expect(resource.error).toMatchObject({
      code: -32601,
      message: 'Method not found: resources/list',
    })

    const invalid = await waitForRpc(responses, 5)
    expect(invalid.result.isError).toBe(true)
    expect(invalid.result.content[0].text).toContain('missing required field body.input')
    expect(chatRunHits).toBe(0)

    const compactManual = await waitForRpc(responses, 7)
    const compactPayload = JSON.parse(compactManual.result.content[0].text)
    expect(compactPayload).toMatchObject({
      moduleCount: 2,
      operationCount: 1,
      operations: [{
        method: 'POST',
        path: '/api/chat-run/runs',
        requestBody: {
          fields: [
            { name: 'input', required: true, type: 'string' },
          ],
        },
      }],
    })
    expect(compactPayload.paths).toBeUndefined()

    const moduleManual = await waitForRpc(responses, 9)
    const modulePayload = JSON.parse(moduleManual.result.content[0].text)
    expect(modulePayload).toMatchObject({
      moduleCount: 2,
      operationCount: 2,
      operationsOmitted: true,
      modules: expect.arrayContaining([
        {
          tag: 'Chat Run',
          operationCount: 1,
          purpose: 'Start a chat or coding-agent run through the HTTP bridge and wait for the result.',
          keywords: expect.arrayContaining(['chat', 'run']),
          description: 'Chat run operations',
        },
        { tag: 'Testing', operationCount: 1, description: 'Test helper operations' },
      ]),
    })
    expect(modulePayload.operations).toBeUndefined()

    const optionalManual = await waitForRpc(responses, 8)
    const optionalPayload = JSON.parse(optionalManual.result.content[0].text)
    expect(optionalPayload.operations[0]).toMatchObject({
      method: 'POST',
      path: '/api/test-public-requester',
      requestBody: { required: false, fields: [] },
    })

    writeRpc(child, 6, 'tools/call', {
      name: 'hermes_api_request',
      arguments: {
        method: 'POST',
        path: '/api/chat-run/runs',
        body: { input: 'hello' },
      },
    })
    const valid = await waitForRpc(responses, 6)
    const validPayload = JSON.parse(valid.result.content[0].text)
    expect(validPayload.status).toBe(200)
    expect(validPayload.body.body).toEqual({ input: 'hello' })
    expect(chatRunHits).toBe(1)

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('reports the package version from the CLI', async () => {
    const child = spawn(process.execPath, ['bin/hermes-web-ui-mcp.mjs', '--version'], {
      cwd: process.cwd(),
      env: process.env,
    })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))

    expect(code).toBe(0)
    expect(stdout.trim()).toBe(`hermes-web-ui-mcp v${pkg.version}`)
  })
})
