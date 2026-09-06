import { createServer } from 'node:net'

const PORT_RELEASE_TIMEOUT_MS = 10_000
const PORT_POLL_INTERVAL_MS = 100

export async function canBindTcpPort(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

async function waitForTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canBindTcpPort(port)) return true
    await new Promise(resolve => setTimeout(resolve, PORT_POLL_INTERVAL_MS))
  }
  return canBindTcpPort(port)
}

/**
 * Recover a Desktop Web UI orphaned after its Electron parent exited.
 * Only the authenticated Desktop shutdown endpoint can authorize this action.
 */
export async function releaseOccupiedWebUiPort(
  port: number,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (await canBindTcpPort(port)) return false

  let response: Response
  try {
    response = await fetchImpl(`http://127.0.0.1:${port}/api/desktop/shutdown`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PORT_RELEASE_TIMEOUT_MS),
    })
  } catch {
    return false
  }

  if (response.status !== 202) return false
  if (!await waitForTcpPort(port, PORT_RELEASE_TIMEOUT_MS)) {
    throw new Error(`Existing Web UI server did not release port ${port} after shutdown`)
  }
  return true
}
