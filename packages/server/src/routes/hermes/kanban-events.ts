import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import { getToken } from '../../services/auth'
import { logger } from '../../services/logger'
import * as kanbanCli from '../../services/hermes/hermes-kanban'

interface KanbanEventsRequest extends IncomingMessage {
  kanbanBoard?: string
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function streamLines(onLine: (line: string) => void) {
  let buffer = ''
  return (chunk: Buffer | string) => {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed) onLine(trimmed)
    }
  }
}

export function setupKanbanEventsWebSocket(httpServers: HttpServer | HttpServer[]) {
  const wss = new WebSocketServer({ noServer: true })
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

  servers.forEach((httpServer) => {
    httpServer.on('upgrade', async (req: KanbanEventsRequest, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (url.pathname !== '/api/hermes/kanban/events') return

      const authToken = await getToken()
      if (authToken) {
        const token = url.searchParams.get('token') || ''
        if (token !== authToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
      }

      try {
        req.kanbanBoard = kanbanCli.normalizeBoardSlug(url.searchParams.get('board'))
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })
  })

  wss.on('connection', (ws, req: KanbanEventsRequest) => {
    const board = req.kanbanBoard || 'default'
    const child = kanbanCli.watchEvents({ board, interval: 0.5 })
    let closed = false

    sendJson(ws, { type: 'connected', board })

    const closeChild = () => {
      if (closed) return
      closed = true
      if (!child.killed) child.kill()
    }

    child.stdout?.on('data', streamLines((line) => {
      if (line.toLowerCase().startsWith('watching kanban events')) return
      sendJson(ws, { type: 'event', board, line })
    }))

    child.stderr?.on('data', streamLines((line) => {
      sendJson(ws, { type: 'error', board, message: line })
    }))

    child.on('error', (err) => {
      logger.error(err, 'Hermes CLI: kanban watch failed')
      sendJson(ws, { type: 'error', board, message: err.message })
      if (ws.readyState === ws.OPEN) ws.close()
    })

    child.on('exit', (code, signal) => {
      sendJson(ws, { type: 'stopped', board, code, signal })
      if (ws.readyState === ws.OPEN) ws.close()
    })

    ws.on('close', closeChild)
    ws.on('error', closeChild)
  })

  logger.info('WebSocket ready at /api/hermes/kanban/events (kanban watch bridge)')
}
