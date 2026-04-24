import { WebSocketServer } from 'ws'
import type { Server as HttpServer } from 'http'
import { accessSync, chmodSync, constants as fsConstants, existsSync } from 'fs'
import { dirname, join } from 'path'
import { getToken } from '../../services/auth'
import { logger } from '../../services/logger'

let pty: any = null

function ensureNodePtySpawnHelperExecutable() {
  if (process.platform !== 'darwin') return

  try {
    const nodePtyRoot = dirname(require.resolve('node-pty/package.json'))
    const helperCandidates = [
      join(nodePtyRoot, 'build', 'Release', 'spawn-helper'),
      join(nodePtyRoot, 'build', 'Debug', 'spawn-helper'),
      join(nodePtyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    ]

    for (const helperPath of helperCandidates) {
      if (!existsSync(helperPath)) continue
      try {
        accessSync(helperPath, fsConstants.X_OK)
      } catch {
        chmodSync(helperPath, 0o755)
        logger.debug('Restored execute bit for node-pty helper: %s', helperPath)
      }
    }
  } catch (err: any) {
    logger.warn(err, 'Could not normalize node-pty helper permissions')
  }
}

try {
  ensureNodePtySpawnHelperExecutable()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch (err: any) {
  logger.warn(err, 'node-pty failed to load, terminal feature disabled')
}

// ─── Shell detection ────────────────────────────────────────────

function findShell(): string {
  const candidates = [
    process.env.SHELL,
    '/bin/zsh',
    '/bin/bash',
    process.platform === 'win32' ? 'powershell.exe' : null,
    process.platform === 'win32' ? 'cmd.exe' : null,
  ].filter(Boolean) as string[]

  for (const shell of candidates) {
    if (existsSync(shell)) return shell
  }
  return '/bin/bash'
}

function shellName(shell: string): string {
  return shell.split('/').pop() || 'shell'
}

// ─── Session types ──────────────────────────────────────────────

interface PtySession {
  id: string
  pty: { pid: number; onData: (cb: (data: string) => void) => void; onExit: (cb: (e: { exitCode: number }) => void) => void; write: (data: string) => void; kill: (signal?: string) => void; resize: (cols: number, rows: number) => void }
  shell: string
  pid: number
  createdAt: number
}

interface Connection {
  sessions: Map<string, PtySession>
  activeSessionId: string | null
  outputBuffers: Map<string, string[]>
}

// ─── Helpers ────────────────────────────────────────────────────

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function createSession(shell: string): PtySession {
  const id = generateId()
  let ptyProcess: PtySession['pty']
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd: process.env.HOME || undefined,
    })
  } catch (err: any) {
    throw new Error(`Failed to spawn shell "${shell}": ${err.message}`)
  }

  const session: PtySession = {
    id,
    pty: ptyProcess,
    shell,
    pid: ptyProcess.pid,
    createdAt: Date.now(),
  }

  return session
}

// ─── WebSocket server setup ─────────────────────────────────────

export function setupTerminalWebSocket(httpServer: HttpServer) {
  if (!pty) {
    logger.warn('node-pty not available, skipping terminal WebSocket setup')
    return
  }

  const wss = new WebSocketServer({ noServer: true })
  const defaultShell = findShell()

  httpServer.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    if (url.pathname !== '/api/hermes/terminal') {
      return
    }

    // Auth check
    const authToken = await getToken()
    if (authToken) {
      const token = url.searchParams.get('token') || ''
      if (token !== authToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws) => {
    const conn: Connection = {
      sessions: new Map(),
      activeSessionId: null,
      outputBuffers: new Map(),
    }

    // ─── PTY output → WebSocket ──────────────────────────────────

    function attachPtyOutput(session: PtySession) {
      session.pty.onData((data: string) => {
        if (ws.readyState !== ws.OPEN) return
        if (conn.activeSessionId === session.id) {
          ws.send(data)
        } else {
          // Buffer output for inactive sessions
          let buf = conn.outputBuffers.get(session.id)
          if (!buf) {
            buf = []
            conn.outputBuffers.set(session.id, buf)
          }
          buf.push(data)
          // Cap buffer at 1MB to prevent memory issues
          if (buf.length > 5000) {
            buf.splice(0, buf.length - 5000)
          }
        }
      })

      session.pty.onExit(({ exitCode }: { exitCode: number }) => {
        conn.outputBuffers.delete(session.id)
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'exited', id: session.id, exitCode }))
        }
        conn.sessions.delete(session.id)
        logger.info('Session %s exited (pid %d, code %d)', session.id, session.pid, exitCode)
      })
    }

    // ─── Message handler ────────────────────────────────────────

    ws.on('message', (raw) => {
      const msg = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)

      // JSON control message
      if (msg.charCodeAt(0) === 0x7B) {
        try {
          const parsed = JSON.parse(msg)
          handleControl(parsed)
        } catch {
          // Not valid JSON, fall through to raw input
          writeRaw(msg)
        }
        return
      }

      writeRaw(msg)
    })

    function writeRaw(data: string) {
      const session = conn.activeSessionId ? conn.sessions.get(conn.activeSessionId) : null
      if (session) {
        session.pty.write(data)
      }
    }

    function handleControl(parsed: any) {
      switch (parsed.type) {
        case 'create': {
          const shell = parsed.shell || defaultShell
          let session: PtySession
          try {
            session = createSession(shell)
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }))
            return
          }
          conn.sessions.set(session.id, session)
          conn.activeSessionId = session.id
          attachPtyOutput(session)
          ws.send(JSON.stringify({
            type: 'created',
            id: session.id,
            pid: session.pid,
            shell: shellName(shell),
          }))
          logger.info('Session created: %s (%s, pid %d)', session.id, shellName(shell), session.pid)
          break
        }

        case 'switch': {
          const { sessionId } = parsed
          const session = conn.sessions.get(sessionId)
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
            return
          }
          conn.activeSessionId = sessionId

          // Send switched first so frontend mounts the correct terminal
          ws.send(JSON.stringify({ type: 'switched', id: sessionId }))

          // Then flush buffered output for this session
          const buf = conn.outputBuffers.get(sessionId)
          if (buf && buf.length > 0) {
            for (const chunk of buf) {
              ws.send(chunk)
            }
            conn.outputBuffers.delete(sessionId)
          }

          logger.debug('Switched to session %s', sessionId)
          break
        }

        case 'close': {
          const { sessionId } = parsed
          const session = conn.sessions.get(sessionId)
          if (!session) return
          session.pty.kill()
          conn.sessions.delete(sessionId)
          conn.outputBuffers.delete(sessionId)
          if (conn.activeSessionId === sessionId) {
            // Auto-switch to the first remaining session
            const remaining = Array.from(conn.sessions.keys())
            conn.activeSessionId = remaining.length > 0 ? remaining[0] : null
          }
          logger.info('Session closed: %s', sessionId)
          break
        }

        case 'resize': {
          const session = conn.activeSessionId ? conn.sessions.get(conn.activeSessionId) : null
          if (!session) return
          const cols = Math.max(1, parsed.cols || 0)
          const rows = Math.max(1, parsed.rows || 0)
          try { session.pty.resize(cols, rows) } catch { }
          break
        }
      }
    }

    // ─── Cleanup ────────────────────────────────────────────────

    ws.on('close', () => {
      for (const session of Array.from(conn.sessions.values())) {
        try { session.pty.kill() } catch { }
      }
      conn.sessions.clear()
      logger.info('Connection closed, all sessions killed')
    })

    ws.on('error', () => {
      for (const session of Array.from(conn.sessions.values())) {
        try { session.pty.kill() } catch { }
      }
      conn.sessions.clear()
    })

    // ─── Auto-create first session ──────────────────────────────

    let firstSession: PtySession
    try {
      firstSession = createSession(defaultShell)
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }))
      logger.error(err, 'Failed to create session')
      ws.close()
      return
    }
    conn.sessions.set(firstSession.id, firstSession)
    conn.activeSessionId = firstSession.id
    attachPtyOutput(firstSession)
    ws.send(JSON.stringify({
      type: 'created',
      id: firstSession.id,
      pid: firstSession.pid,
      shell: shellName(defaultShell),
    }))
    logger.info('First session created: %s (%s, pid %d)', firstSession.id, shellName(defaultShell), firstSession.pid)
  })

  logger.info('WebSocket ready at /terminal (shell: %s, transport: node-pty)', defaultShell)
}
