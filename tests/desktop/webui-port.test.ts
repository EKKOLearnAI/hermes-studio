import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  canBindTcpPort,
  getWebUiPortReleaseTimeoutMs,
  releaseOccupiedWebUiPort,
} from '../../packages/desktop/src/main/webui-port'

const servers: Server[] = []

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
  return address.port
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })))
})

describe('Desktop Web UI port recovery', () => {
  it('asks an orphaned Desktop server to shut down and waits for the port', async () => {
    let server!: Server
    server = createServer((request, response) => {
      if (request.url === '/api/desktop/shutdown' && request.method === 'POST') {
        response.statusCode = request.headers.authorization === 'Bearer desktop-token' ? 202 : 401
        response.end()
        if (response.statusCode === 202) setImmediate(() => server.close())
        return
      }
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server)

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(true)
    expect(server.listening).toBe(false)
  })

  it('recovers a Desktop server bound to all local interfaces', async () => {
    let server!: Server
    server = createServer((request, response) => {
      if (request.url === '/api/desktop/shutdown' && request.method === 'POST') {
        response.statusCode = request.headers.authorization === 'Bearer desktop-token' ? 202 : 401
        response.end()
        if (response.statusCode === 202) setImmediate(() => server.close())
        return
      }
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server, '0.0.0.0')

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(true)
    expect(server.listening).toBe(false)
  })

  it('waits for a delayed IPv4 wildcard shutdown before reporting success', async () => {
    vi.stubEnv('BIND_HOST', '0.0.0.0')
    vi.stubEnv('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS', '100')
    let server!: Server
    server = createServer((request, response) => {
      if (request.url === '/api/desktop/shutdown' && request.method === 'POST') {
        response.statusCode = request.headers.authorization === 'Bearer desktop-token' ? 202 : 401
        response.end()
        if (response.statusCode === 202) setTimeout(() => server.close(), 150)
        return
      }
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server, '0.0.0.0')

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(true)
    expect(server.listening).toBe(false)
  })

  it('uses the configured loopback bind host for delayed shutdown recovery', async () => {
    vi.stubEnv('BIND_HOST', '127.0.0.1')
    vi.stubEnv('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS', '100')
    let server!: Server
    server = createServer((request, response) => {
      if (request.url === '/api/desktop/shutdown' && request.method === 'POST') {
        response.statusCode = request.headers.authorization === 'Bearer desktop-token' ? 202 : 401
        response.end()
        if (response.statusCode === 202) setTimeout(() => server.close(), 150)
        return
      }
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server, '127.0.0.1')

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(true)
    expect(server.listening).toBe(false)
  })

  it('reports an occupied IPv4 wildcard port as unavailable to a matching probe', async () => {
    const server = createServer()
    const port = await listen(server, '0.0.0.0')

    await expect(canBindTcpPort(port, '0.0.0.0')).resolves.toBe(false)
    expect(server.listening).toBe(true)
  })

  it('waits through the configured shutdown budget plus cleanup grace', async () => {
    vi.stubEnv('BIND_HOST', '0.0.0.0')
    vi.stubEnv('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS', '100')
    let server!: Server
    server = createServer((request, response) => {
      if (request.url === '/api/desktop/shutdown' && request.method === 'POST') {
        response.statusCode = request.headers.authorization === 'Bearer desktop-token' ? 202 : 401
        response.end()
        if (response.statusCode === 202) setTimeout(() => server.close(), 900)
        return
      }
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server, '0.0.0.0')

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(true)
    expect(server.listening).toBe(false)
  })

  it('throws when the server misses the shutdown budget and cleanup grace', async () => {
    vi.stubEnv('BIND_HOST', '0.0.0.0')
    vi.stubEnv('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS', '100')
    const server = createServer((request, response) => {
      if (request.url === '/api/desktop/shutdown' && request.method === 'POST') {
        response.statusCode = request.headers.authorization === 'Bearer desktop-token' ? 202 : 401
        response.end()
        return
      }
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server, '0.0.0.0')

    const startedAt = Date.now()
    await expect(releaseOccupiedWebUiPort(port, 'desktop-token'))
      .rejects.toThrow(`Existing Web UI server did not release port ${port} after shutdown`)
    const elapsedMs = Date.now() - startedAt
    expect(elapsedMs).toBeGreaterThanOrEqual(1_000)
    expect(elapsedMs).toBeLessThan(1_500)
    expect(server.listening).toBe(true)
  })

  it('derives the release timeout from the shutdown budget plus grace', () => {
    expect(getWebUiPortReleaseTimeoutMs({ HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS: '100' })).toBe(1_100)
    expect(getWebUiPortReleaseTimeoutMs({ HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS: 'not-a-number' })).toBe(11_000)
  })

  it('does not stop a non-Desktop service on the requested port', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server)

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(false)
    expect(server.listening).toBe(true)
  })

  it('does not affect an available port', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const server = createServer()
    const port = await listen(server)
    await new Promise<void>(resolve => server.close(() => resolve()))

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token', fetchImpl)).resolves.toBe(false)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})
