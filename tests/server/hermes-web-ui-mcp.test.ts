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
    child = spawn(process.execPath, ['bin/hermes-studio-mcp.mjs'], {
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
      name: 'hermes_studio_api_request',
      arguments: {
        method: 'POST',
        path: '/api/test-public-requester',
        query: { q: 'hello' },
        body: { ok: true },
      },
    })
    writeRpc(child, 4, 'resources/list')
    writeRpc(child, 5, 'tools/call', {
      name: 'hermes_studio_api_request',
      arguments: {
        method: 'POST',
        path: '/api/chat-run/runs',
        body: {},
      },
    })
    writeRpc(child, 7, 'tools/call', {
      name: 'hermes_studio_api_openapi_get',
      arguments: {
        path: '/api/chat-run/runs',
        method: 'POST',
      },
    })
    writeRpc(child, 9, 'tools/call', {
      name: 'hermes_studio_api_openapi_get',
      arguments: {},
    })
    writeRpc(child, 10, 'tools/call', {
      name: 'hermes_api_request',
      arguments: {
        method: 'POST',
        path: '/api/test-public-requester',
        body: { legacy: true },
      },
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({
      name: 'hermes-studio-mcp',
      version: pkg.version,
    })
    expect(initialized.result.capabilities).toEqual({ tools: {} })

    const list = await waitForRpc(responses, 2)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_api_request')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_lan_devices_list')).toBe(false)

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
    const legacyResponse = await waitForRpc(responses, 10)
    const legacyPayload = JSON.parse(legacyResponse.result.content[0].text)
    expect(legacyPayload.status).toBe(200)
    expect(legacyPayload.body.body).toEqual({ legacy: true })
    writeRpc(child, 8, 'tools/call', {
      name: 'hermes_studio_api_openapi_get',
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
      name: 'hermes_studio_api_request',
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

  it.each([
    'bin/hermes-studio-mcp.mjs',
    'bin/hermes-web-ui-mcp.mjs',
  ])('reports the package version from the CLI entry %s', async (entry) => {
    const child = spawn(process.execPath, [entry, '--version'], {
      cwd: process.cwd(),
      env: process.env,
    })
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))

    expect(code).toBe(0)
    expect(stdout.trim()).toBe(`hermes-studio-mcp v${pkg.version}`)
  })

  it('exposes curated Hermes Studio use tools in the use toolset', async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/api/chat-run/runs') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({
            ok: true,
            session_id: 'session-1',
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      if (req.url === '/api/hermes/sessions?limit=2&source=coding_agent') {
        res.end(JSON.stringify({ sessions: [{ id: 'session-1' }] }))
        return
      }
      if (req.url === '/api/hermes/sessions/count?source=coding_agent') {
        res.end(JSON.stringify({ count: 7 }))
        return
      }
      if (req.url === '/api/hermes/usage/stats?days=7') {
        res.end(JSON.stringify({
          total_input_tokens: 100,
          total_output_tokens: 40,
          total_cache_read_tokens: 10,
          total_cache_write_tokens: 2,
          total_reasoning_tokens: 5,
          total_sessions: 3,
          total_cost: 0.0123,
          total_api_calls: 4,
          period_days: 7,
          model_usage: [{ model: 'gpt-5.1', input_tokens: 100, output_tokens: 40, cache_read_tokens: 10, cache_write_tokens: 2, reasoning_tokens: 5, sessions: 3 }],
          daily_usage: [],
        }))
        return
      }
      if (req.url === '/api/hermes/sessions/session-1' && req.method === 'GET') {
        res.end(JSON.stringify({ id: 'session-1', title: 'Session 1' }))
        return
      }
      if (req.url === '/api/hermes/sessions/session-1/context') {
        res.end(JSON.stringify({
          session_id: 'session-1',
          title: 'Session 1',
          messages: [
            { id: 1, role: 'user', content: 'older', timestamp: 1 },
            { id: 2, role: 'assistant', content: 'tool call shell', timestamp: 2, tool_calls: [{ id: 'call-1' }] },
            { id: 3, role: 'tool', content: 'secret tool result', timestamp: 3, tool_call_id: 'call-1', tool_name: 'read_file' },
            { id: 4, role: 'user', content: 'hello', timestamp: 4 },
            { id: 5, role: 'assistant', content: 'hi', timestamp: 5 },
            { id: 6, role: 'user', content: 'next', timestamp: 6 },
            { id: 7, role: 'assistant', content: 'done', timestamp: 7 },
          ],
          message_count: 7,
        }))
        return
      }
      if (req.url === '/api/hermes/sessions/session-1' && req.method === 'DELETE') {
        res.end(JSON.stringify({ ok: true, deleted: true }))
        return
      }
      if (req.url === '/api/hermes/sessions/conversations/session-1/messages?humanOnly=0') {
        res.end(JSON.stringify({ messages: [{ role: 'system', content: 'internal' }] }))
        return
      }
      if (req.url === '/api/hermes/sessions/session-1/rename' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({ ok: true, body: raw ? JSON.parse(raw) : null }))
        })
        return
      }
      if (req.url === '/api/hermes/profiles') {
        res.end(JSON.stringify({ profiles: ['default'] }))
        return
      }
      if (req.url === '/api/hermes/available-models') {
        res.end(JSON.stringify({
          default: 'gpt-5.1',
          default_provider: 'openai',
          providers: [
            { id: 'openai', label: 'OpenAI', models: ['gpt-5.1'] },
            { id: 'openrouter', label: 'OpenRouter', models: ['gpt-5.1', 'claude-sonnet'], model_meta: { 'claude-sonnet': { alias: 'Claude Sonnet' } } },
          ],
        }))
        return
      }
      if (req.url === '/api/hermes/config/providers' && req.method === 'POST') {
        let raw = ''
        req.on('data', chunk => { raw += chunk })
        req.on('end', () => {
          res.end(JSON.stringify({
            success: true,
            body: raw ? JSON.parse(raw) : null,
          }))
        })
        return
      }
      if (req.url === '/api/hermes/config/providers/custom%3Aedge-router?source=providers&providerKey=edge-router' && req.method === 'DELETE') {
        res.end(JSON.stringify({ success: true, deleted: 'custom:edge-router' }))
        return
      }
      if (req.url === '/api/hermes/performance/runtime') {
        res.end(JSON.stringify({
          timestamp: 123456,
          bridge: {
            reachable: true,
            workers: [
              { profile: 'default', pid: 101, running: true, sessionCount: 3, runningSessionCount: 1, lastUsedAt: 123400, endpoint: 'ipc://default' },
              { profile: 'research', pid: 102, running: true, sessionCount: 2, runningSessionCount: 0, lastUsedAt: 123300, endpoint: 'ipc://research' },
            ],
          },
          sessions: { active: 5, running: 1, byProfile: { default: 3, research: 2 } },
        }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')

    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/hermes-studio-mcp.mjs', 'use'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
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
      name: 'hermes_studio_use_chat_run',
      arguments: { input: 'hello', session_id: 'session-1', include_events: true },
    })
    writeRpc(child, 4, 'tools/call', {
      name: 'hermes_studio_use_sessions_list',
      arguments: { limit: 2, source: 'coding_agent' },
    })
    writeRpc(child, 5, 'tools/call', {
      name: 'hermes_studio_use_session_get',
      arguments: { session_id: 'session-1' },
    })
    writeRpc(child, 10, 'tools/call', {
      name: 'hermes_studio_use_sessions_count',
      arguments: { source: 'coding_agent' },
    })
    writeRpc(child, 6, 'tools/call', {
      name: 'hermes_studio_use_session_messages',
      arguments: { session_id: 'session-1', include_internal: true },
    })
    writeRpc(child, 11, 'tools/call', {
      name: 'hermes_studio_use_session_rename',
      arguments: { session_id: 'session-1', title: 'Renamed session' },
    })
    writeRpc(child, 12, 'tools/call', {
      name: 'hermes_studio_use_session_delete',
      arguments: { session_id: 'session-1' },
    })
    writeRpc(child, 7, 'tools/call', {
      name: 'hermes_studio_use_profiles_list',
      arguments: {},
    })
    writeRpc(child, 8, 'tools/call', {
      name: 'hermes_studio_use_available_models',
      arguments: {},
    })
    writeRpc(child, 13, 'tools/call', {
      name: 'hermes_studio_use_model_provider_get',
      arguments: { model: 'gpt-5.1' },
    })
    writeRpc(child, 14, 'tools/call', {
      name: 'hermes_studio_use_model_provider_get',
      arguments: { model: 'Claude Sonnet' },
    })
    writeRpc(child, 15, 'tools/call', {
      name: 'hermes_studio_use_provider_add',
      arguments: {
        name: 'Edge Router',
        base_url: 'https://edge.example/v1',
        api_key: 'secret-key',
        model: 'edge-model',
        context_length: 128000,
        api_mode: 'chat_completions',
      },
    })
    writeRpc(child, 16, 'tools/call', {
      name: 'hermes_studio_use_provider_delete',
      arguments: {
        pool_key: 'custom:edge-router',
        source: 'providers',
        providerKey: 'edge-router',
      },
    })
    writeRpc(child, 17, 'tools/call', {
      name: 'hermes_studio_use_usage_stats',
      arguments: { days: 7 },
    })
    writeRpc(child, 18, 'tools/call', {
      name: 'hermes_studio_use_session_context',
      arguments: { session_id: 'session-1', turns: 1 },
    })
    writeRpc(child, 19, 'tools/call', {
      name: 'hermes_studio_use_worker_status',
      arguments: {},
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({ toolset: 'use' })

    const list = await waitForRpc(responses, 2)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_chat_run')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_sessions_count')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_usage_stats')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_session_context')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_session_delete')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_session_rename')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_model_provider_get')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_provider_add')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_provider_delete')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_use_worker_status')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_api_request')).toBe(false)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_lan_devices_list')).toBe(false)

    const chatRun = JSON.parse((await waitForRpc(responses, 3)).result.content[0].text)
    expect(chatRun.body).toMatchObject({ input: 'hello', session_id: 'session-1', include_events: true })
    const sessions = JSON.parse((await waitForRpc(responses, 4)).result.content[0].text)
    expect(sessions.sessions[0].id).toBe('session-1')
    const sessionCount = JSON.parse((await waitForRpc(responses, 10)).result.content[0].text)
    expect(sessionCount.count).toBe(7)
    const session = JSON.parse((await waitForRpc(responses, 5)).result.content[0].text)
    expect(session.title).toBe('Session 1')
    const messages = JSON.parse((await waitForRpc(responses, 6)).result.content[0].text)
    expect(messages.messages[0].role).toBe('system')
    const renamed = JSON.parse((await waitForRpc(responses, 11)).result.content[0].text)
    expect(renamed).toEqual({ ok: true, body: { title: 'Renamed session' } })
    const deleted = JSON.parse((await waitForRpc(responses, 12)).result.content[0].text)
    expect(deleted).toEqual({ ok: true, deleted: true })
    const profiles = JSON.parse((await waitForRpc(responses, 7)).result.content[0].text)
    expect(profiles.profiles).toEqual(['default'])
    const models = JSON.parse((await waitForRpc(responses, 8)).result.content[0].text)
    expect(models.providers[0].models).toEqual(['gpt-5.1'])
    const modelProvider = JSON.parse((await waitForRpc(responses, 13)).result.content[0].text)
    expect(modelProvider).toMatchObject({
      model: 'gpt-5.1',
      found: true,
      provider: 'openai',
      ambiguous: true,
    })
    expect(modelProvider.providers.map((entry: any) => entry.provider)).toEqual(['openai', 'openrouter'])
    const aliasProvider = JSON.parse((await waitForRpc(responses, 14)).result.content[0].text)
    expect(aliasProvider).toMatchObject({
      model: 'Claude Sonnet',
      found: true,
      provider: 'openrouter',
      ambiguous: false,
    })
    const addedProvider = JSON.parse((await waitForRpc(responses, 15)).result.content[0].text)
    expect(addedProvider).toEqual({
      success: true,
      body: {
        name: 'Edge Router',
        base_url: 'https://edge.example/v1',
        api_key: 'secret-key',
        model: 'edge-model',
        context_length: 128000,
        api_mode: 'chat_completions',
      },
    })
    const deletedProvider = JSON.parse((await waitForRpc(responses, 16)).result.content[0].text)
    expect(deletedProvider).toEqual({ success: true, deleted: 'custom:edge-router' })
    const usage = JSON.parse((await waitForRpc(responses, 17)).result.content[0].text)
    expect(usage).toMatchObject({ total_input_tokens: 100, total_output_tokens: 40, period_days: 7 })
    const context = JSON.parse((await waitForRpc(responses, 18)).result.content[0].text)
    expect(context).toMatchObject({
      session_id: 'session-1',
      message_count: 2,
      clean_message_count: 5,
      requested_turns: 1,
      messages: [
        { id: 6, role: 'user', content: 'next', timestamp: 6 },
        { id: 7, role: 'assistant', content: 'done', timestamp: 7 },
      ],
    })
    expect(JSON.stringify(context)).not.toContain('tool_calls')
    expect(JSON.stringify(context)).not.toContain('secret tool result')
    const workerStatus = JSON.parse((await waitForRpc(responses, 19)).result.content[0].text)
    expect(workerStatus).toMatchObject({
      bridge_reachable: true,
      worker_count: 2,
      running_worker_count: 2,
      session_count: 5,
      interacting_session_count: 1,
      completed_interaction_count: 4,
    })
    expect(workerStatus.interacting_workers.map((worker: any) => worker.profile)).toEqual(['default'])
    expect(workerStatus.completed_workers.map((worker: any) => worker.profile)).toEqual(['research'])

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('filters exposed tools by MCP toolset argument', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/devices') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ devices: [{ id: 'device-1' }] }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP server address')

    const responses = new Map<number, any>()
    child = spawn(process.execPath, ['bin/hermes-studio-mcp.mjs', 'devices'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HERMES_WEB_UI_URL: `http://127.0.0.1:${address.port}`,
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
      name: 'hermes_studio_api_request',
      arguments: { path: '/health' },
    })
    writeRpc(child, 4, 'tools/call', {
      name: 'hermes_lan_devices_list',
      arguments: {},
    })

    const initialized = await waitForRpc(responses, 1)
    expect(initialized.result.serverInfo).toMatchObject({ toolset: 'devices' })

    const list = await waitForRpc(responses, 2)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_lan_devices_list')).toBe(true)
    expect(list.result.tools.some((tool: any) => tool.name === 'hermes_studio_api_request')).toBe(false)

    const hiddenCall = await waitForRpc(responses, 3)
    expect(hiddenCall.result.isError).toBe(true)
    expect(hiddenCall.result.content[0].text).toContain("active 'devices' MCP toolset")

    const legacyDevicesCall = await waitForRpc(responses, 4)
    const legacyDevicesPayload = JSON.parse(legacyDevicesCall.result.content[0].text)
    expect(legacyDevicesPayload.devices[0].id).toBe('device-1')

    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
