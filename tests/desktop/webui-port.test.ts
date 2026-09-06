import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { releaseOccupiedWebUiPort } from '../../packages/desktop/src/main/webui-port'

const servers: Server[] = []

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP port')
  return address.port
}

afterEach(async () => {
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

  it('does not stop a non-Desktop service on the requested port', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })
    const port = await listen(server)

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token')).resolves.toBe(false)
    expect(server.listening).toBe(true)
  })

  it('does not probe an available port', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const server = createServer()
    const port = await listen(server)
    await new Promise<void>(resolve => server.close(() => resolve()))

    await expect(releaseOccupiedWebUiPort(port, 'desktop-token', fetchImpl)).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
