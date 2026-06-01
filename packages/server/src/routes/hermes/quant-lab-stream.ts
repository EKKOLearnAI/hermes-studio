import { WebSocketServer } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { WebSocket } from 'ws'
import { getToken } from '../../services/auth'
import { logger } from '../../services/logger'
import { buildQuantLabSnapshot } from './quant-lab'

interface QuantStreamRequest extends IncomingMessage {
  intervalMs?: number
}

interface StreamTick {
  ticker: string
  price: number
  previousPrice: number
  change: number
  changePercent: number
  volume: number
  source: string
  updatedAt: string
}

function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload))
}

function parseInterval(value: string | null): number {
  const parsed = Number.parseInt(value || '', 10)
  if (!Number.isFinite(parsed)) return 1200
  return Math.max(500, Math.min(parsed, 10_000))
}

function parseTrendPercent(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value.replace('%', '').replace('+', '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function makeTicks(
  snapshot: Awaited<ReturnType<typeof buildQuantLabSnapshot>>,
  previousPrices: Map<string, number>
): StreamTick[] {
  const now = snapshot.dataHealth?.updatedAt || new Date().toISOString()
  return snapshot.topPicks.slice(0, 12).map((pick) => {
    const price = Number(pick.price.toFixed(2))
    const trendPercent = parseTrendPercent(pick.trend)
    const fallbackPreviousPrice = previousPrices.get(pick.ticker) ?? price
    const previousPrice = trendPercent !== null && trendPercent !== -100
      ? Number((price / (1 + (trendPercent / 100))).toFixed(2))
      : fallbackPreviousPrice
    const change = Number((price - previousPrice).toFixed(2))
    const changePercent = trendPercent ?? (previousPrice > 0 ? Number(((change / previousPrice) * 100).toFixed(3)) : 0)
    previousPrices.set(pick.ticker, price)

    return {
      ticker: pick.ticker,
      price,
      previousPrice,
      change,
      changePercent,
      volume: 0,
      source: snapshot.dataHealth?.quoteSource || snapshot.source,
      updatedAt: now,
    }
  })
}

export function setupQuantLabStreamWebSocket(httpServers: HttpServer | HttpServer[]) {
  const wss = new WebSocketServer({ noServer: true })
  const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

  servers.forEach((httpServer) => {
    httpServer.on('upgrade', async (req: QuantStreamRequest, socket, head) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (url.pathname !== '/api/hermes/quant-lab/stream') return

      const authToken = await getToken()
      if (authToken) {
        const token = url.searchParams.get('token') || ''
        if (token !== authToken) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
      }

      req.intervalMs = parseInterval(url.searchParams.get('intervalMs'))
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })
  })

  wss.on('connection', async (ws, req: QuantStreamRequest) => {
    const intervalMs = req.intervalMs || 1200
    let snapshot = await buildQuantLabSnapshot()
    let sequence = 0
    const previousPrices = new Map<string, number>()
    let snapshotRefresh: ReturnType<typeof setInterval> | null = null
    let tickTimer: ReturnType<typeof setInterval> | null = null

    sendJson(ws, {
      type: 'connected',
      source: snapshot.source,
      mode: 'snapshot-refresh',
      dataHealth: snapshot.dataHealth,
      intervalMs,
      updatedAt: new Date().toISOString(),
    })

    const pushTicks = () => {
      sequence += 1
      sendJson(ws, {
        type: 'batch',
        sequence,
        source: snapshot.source,
        mode: 'snapshot-refresh',
        dataHealth: snapshot.dataHealth,
        ticks: makeTicks(snapshot, previousPrices),
      })
    }

    pushTicks()
    tickTimer = setInterval(pushTicks, intervalMs)
    snapshotRefresh = setInterval(async () => {
      try {
        snapshot = await buildQuantLabSnapshot()
      } catch (err) {
        logger.warn(err, 'Quant Lab stream snapshot refresh failed')
      }
    }, 30_000)

    const cleanup = () => {
      if (tickTimer) clearInterval(tickTimer)
      if (snapshotRefresh) clearInterval(snapshotRefresh)
      tickTimer = null
      snapshotRefresh = null
    }

    ws.on('close', cleanup)
    ws.on('error', cleanup)
  })

  logger.info('WebSocket ready at /api/hermes/quant-lab/stream')
}
