import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  HomeAssistantClient,
  HomeAssistantClientError,
} from '../../packages/server/src/services/hermes/home/home-assistant-client'
import { resolveHomeAssistantConfigMaterial } from '../../packages/server/src/services/hermes/home/home-assistant-config'

interface Harness {
  server: Server
  sockets: WebSocketServer
  baseUrl: string
  commands: Array<Record<string, unknown>>
  requests: Array<{ method: string; url: string; body: unknown }>
  close(): Promise<void>
}

describe('home assistant protocol client', () => {
  const harnesses: Harness[] = []

  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map(harness => harness.close()))
  })

  it('bootstraps states and completes auth, state subscription, event, and ping/pong', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const client = new HomeAssistantClient(config(harness.baseUrl))

    const states = await client.fetchStates()
    expect(states).toEqual([expect.objectContaining({ entity_id: 'light.office', state: 'off' })])

    let resolveEvent!: (event: unknown) => void
    const received = new Promise<unknown>(resolve => { resolveEvent = resolve })
    const subscription = await client.subscribeStateChanged(event => resolveEvent(event))
    expect(subscription.haVersion).toBe('2026.7.1')
    await subscription.ping()
    await expect(received).resolves.toMatchObject({
      event_type: 'state_changed', data: { entity_id: 'light.office' },
    })
    expect(harness.commands).toEqual(expect.arrayContaining([
      { type: 'auth', access_token: 'test-home-assistant-access-token' },
      { id: 1, type: 'subscribe_events', event_type: 'state_changed' },
      { id: 2, type: 'ping' },
    ]))
    await subscription.close()
  })

  it('fails with a stable code when websocket authentication is rejected', async () => {
    const harness = await createHarness({ rejectAuth: true })
    harnesses.push(harness)
    const client = new HomeAssistantClient(config(harness.baseUrl))

    await expect(client.subscribeStateChanged(() => undefined)).rejects.toMatchObject({
      code: 'HOME_ASSISTANT_WS_AUTH_FAILED',
    })
  })

  it('rejects a REST body beyond the configured byte limit', async () => {
    const harness = await createHarness({ oversizedRest: true })
    harnesses.push(harness)
    const resolved = resolveHomeAssistantConfigMaterial('home', {
      home_assistant: {
        base_url: harness.baseUrl, token: 'test-home-assistant-access-token', max_rest_response_bytes: 65_536,
      },
    }, {})!
    const client = new HomeAssistantClient(resolved)

    await expect(client.fetchStates()).rejects.toMatchObject({ code: 'HOME_ASSISTANT_RESPONSE_TOO_LARGE' })
  })

  it('reads one exact state and calls only an allowlisted service with bounded JSON', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const client = new HomeAssistantClient(config(harness.baseUrl))

    await expect(client.fetchState('light.office')).resolves.toMatchObject({ entity_id: 'light.office', state: 'off' })
    await expect(client.callService('light', 'turn_on', { entity_id: 'light.office' })).resolves.toEqual([
      expect.objectContaining({ entity_id: 'light.office', state: 'on' }),
    ])
    expect(harness.requests).toContainEqual({
      method: 'POST', url: '/api/services/light/turn_on', body: { entity_id: 'light.office' },
    })
    await expect(client.callService('lock', 'unlock', { entity_id: 'lock.front' }))
      .rejects.toMatchObject({ code: 'HOME_ASSISTANT_SERVICE_DENIED' })
  })

  it('closes a subscribed socket on malformed protocol JSON without leaking raw material', async () => {
    const harness = await createHarness({ malformedEvent: true })
    harnesses.push(harness)
    const client = new HomeAssistantClient(config(harness.baseUrl))
    const subscription = await client.subscribeStateChanged(() => undefined)

    await expect(subscription.closed).resolves.toEqual({
      clean: false, code: 'HOME_ASSISTANT_WS_PROTOCOL_INVALID',
    })
    expect(JSON.stringify(await subscription.closed)).not.toContain('malformed-secret')
  })

  it('aborts an established subscription with a stable close code', async () => {
    const harness = await createHarness()
    harnesses.push(harness)
    const client = new HomeAssistantClient(config(harness.baseUrl))
    const controller = new AbortController()
    const subscription = await client.subscribeStateChanged(() => undefined, controller.signal)

    controller.abort()
    await expect(subscription.closed).resolves.toEqual({ clean: false, code: 'HOME_ASSISTANT_ABORTED' })
  })

  it('exports only stable client error codes', () => {
    const error = new HomeAssistantClientError('HOME_ASSISTANT_REST_FAILED')
    expect(error.message).toBe('HOME_ASSISTANT_REST_FAILED')
    expect(JSON.stringify(error)).not.toContain('token')
  })
})

function config(baseUrl: string) {
  return resolveHomeAssistantConfigMaterial('home', {
    home_assistant: { base_url: baseUrl, token: 'test-home-assistant-access-token' },
  }, {})!
}

async function createHarness(options: {
  rejectAuth?: boolean
  oversizedRest?: boolean
  malformedEvent?: boolean
} = {}): Promise<Harness> {
  const commands: Array<Record<string, unknown>> = []
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer test-home-assistant-access-token') {
      response.writeHead(401).end('{}')
      return
    }
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET' && request.url === '/api/states/light.office') {
      response.end(JSON.stringify({
        entity_id: 'light.office', state: 'off', attributes: { friendly_name: 'Office' },
        last_changed: '2026-07-15T00:00:00.000Z', last_updated: '2026-07-15T00:00:00.000Z',
      }))
      return
    }
    if (request.method === 'POST' && request.url === '/api/services/light/turn_on') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      requests.push({ method: request.method, url: request.url, body })
      response.end(JSON.stringify([{
        entity_id: 'light.office', state: 'on', attributes: { friendly_name: 'Office' },
        last_changed: '2026-07-15T00:00:01.000Z', last_updated: '2026-07-15T00:00:01.000Z',
      }]))
      return
    }
    if (request.url !== '/api/states') {
      response.writeHead(404).end('{}')
      return
    }
    if (options.oversizedRest) {
      response.end(JSON.stringify([{ entity_id: 'sensor.large', state: 'x'.repeat(70_000), attributes: {} }]))
      return
    }
    response.end(JSON.stringify([{
      entity_id: 'light.office', state: 'off', attributes: { friendly_name: 'Office' },
      last_changed: '2026-07-15T00:00:00.000Z', last_updated: '2026-07-15T00:00:00.000Z',
    }]))
  })
  const sockets = new WebSocketServer({ server, path: '/api/websocket' })
  sockets.on('connection', socket => {
    socket.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.7.1' }))
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>
      commands.push(message)
      if (message.type === 'auth') {
        if (options.rejectAuth) {
          socket.send(JSON.stringify({ type: 'auth_invalid', message: 'malformed-secret should never escape' }))
          return
        }
        socket.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.7.1' }))
        return
      }
      if (message.type === 'subscribe_events') {
        socket.send(JSON.stringify({ id: message.id, type: 'result', success: true, result: null }))
        setTimeout(() => {
          if (options.malformedEvent) socket.send('{"malformed-secret":')
          else socket.send(JSON.stringify({
            id: message.id,
            type: 'event',
            event: {
              event_type: 'state_changed', time_fired: '2026-07-15T00:00:01.000Z',
              data: { entity_id: 'light.office', old_state: null, new_state: { entity_id: 'light.office', state: 'on' } },
            },
          }))
        }, 10)
        return
      }
      if (message.type === 'ping') socket.send(JSON.stringify({ id: message.id, type: 'pong' }))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    server,
    sockets,
    baseUrl: `http://127.0.0.1:${port}`,
    commands,
    requests,
    close: async () => {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>(resolve => sockets.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
