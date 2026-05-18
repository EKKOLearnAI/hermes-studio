import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from '@koa/bodyparser'
import serve from 'koa-static'
import send from 'koa-send'
import os from 'os'
import { resolve } from 'path'
import { mkdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { config, isAuthDisabled } from './config'
import { getToken, requireAuth } from './services/auth'
import { initLoginLimiter } from './services/login-limiter'
import { initGatewayManager, getGatewayManagerInstance } from './services/gateway-bootstrap'
import { bindShutdown } from './services/shutdown'
import { setupTerminalWebSocket } from './routes/hermes/terminal'
import { setupKanbanEventsWebSocket } from './routes/hermes/kanban-events'
import { registerRoutes } from './routes'
import { setGroupChatServer } from './routes/hermes/group-chat'
import { setChatRunServer } from './routes/hermes/chat-run'
import { GroupChatServer } from './services/hermes/group-chat'
import { ChatRunSocket } from './services/hermes/chat-run-socket'
import { logger } from './services/logger'

// Injected by esbuild at build time; fallback to reading package.json in dev mode
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version } catch { return 'dev' } })()

// Global error handlers.
// We exit on uncaughtException so a process supervisor (Docker `restart`,
// systemd, pm2, launchd) restarts us into a known-good state — see the
// "Operations" section of README.md for the supervisor expectations.
// The 200ms grace lets pino flush its sync destination before exit.
process.on('uncaughtException', (err) => {
  logger.fatal(err, 'Uncaught exception — exiting for supervisor restart')
  setTimeout(() => process.exit(1), 200).unref()
})

process.on('unhandledRejection', (reason) => {
  logger.error(reason, 'Unhandled rejection')
})

let server: any = null
let servers: any[] = []
let chatRunServer: any = null

interface ListenResult {
  primary: any
  servers: any[]
}

function listen(app: Koa, port: number, host: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = app.listen(port, host)
    s.once('listening', () => resolve(s))
    s.once('error', reject)
  })
}

async function listenWithFallback(app: Koa, port: number, host?: string): Promise<ListenResult> {
  const bindHost = host || '0.0.0.0'
  console.log(`[bootstrap] listening on ${bindHost}:${port}`)
  const primary = await listen(app, port, bindHost)
  return { primary, servers: [primary] }
}

/**
 * 安全获取网络接口信息（兼容 Termux/proot 环境）
 * 在 proot 环境中 os.networkInterfaces() 会抛出权限错误（errno 13）
 */
function safeNetworkInterfaces() {
  try {
    return os.networkInterfaces()
  } catch {
    return {}
  }
}

export async function bootstrap() {
  console.log(`hermes-web-ui v${APP_VERSION} starting...`)

  if (isAuthDisabled()) {
    const warn = '⚠️  AUTH_DISABLED is set — all API endpoints are OPEN. DO NOT expose this server to a public/untrusted network.'
    console.warn(warn)
    logger.warn(warn)
  }

  await mkdir(config.uploadDir, { recursive: true })
  await mkdir(config.dataDir, { recursive: true })

  const authToken = await getToken()
  await initLoginLimiter()
  const app = new Koa()

  await initGatewayManager()
  console.log('[bootstrap] gateway manager initialized')
  await new Promise(resolve => setTimeout(resolve, 1000))
  // Initialize all web-ui SQLite tables
  const { initAllStores } = await import('./db/hermes/init')
  // Wait 1 second before initializing stores to ensure all resources are ready
  initAllStores()
  await new Promise(resolve => setTimeout(resolve, 1000))
  console.log('[bootstrap] all stores initialized')

  // Sync Hermes sessions from all profiles (only if local DB is empty)
  const { syncAllHermesSessionsOnStartup } = await import('./services/hermes/session-sync')
  await syncAllHermesSessionsOnStartup()
  console.log('[bootstrap] Hermes session sync completed')

  // CORS: default to same-origin (no Access-Control-Allow-Origin header).
  //   ''                         → same-origin only (safe default)
  //   '*'                        → echo any origin (legacy behaviour, opt-in)
  //   'https://a.com,https://b'  → strict allowlist
  const corsRaw = config.corsOrigins.trim()
  if (corsRaw === '') {
    // No CORS middleware at all — browser enforces same-origin.
  } else if (corsRaw === '*') {
    app.use(cors({ origin: '*' }))
  } else {
    const allowed = new Set(corsRaw.split(',').map(s => s.trim()).filter(Boolean))
    app.use(cors({
      origin: (ctx) => {
        const requested = ctx.get('Origin')
        return allowed.has(requested) ? requested : ''
      },
    }))
  }
  app.use(bodyParser())
  console.log('[bootstrap] cors + bodyParser registered (mode=%s)', corsRaw || 'same-origin')

  // Register all routes (handles auth internally)
  const proxyMiddleware = registerRoutes(app, requireAuth(authToken))
  app.use(proxyMiddleware)
  console.log('[bootstrap] routes registered')

  if (authToken) {
    const tail = authToken.slice(-4)
    console.log(`Auth enabled — token: ****${tail} (run "cat ~/.hermes-web-ui/.token" to retrieve)`)
    logger.info('Auth enabled — token suffix=****%s', tail)
  }

  // SPA fallback
  const distDir = resolve(__dirname, '..', 'client')
  app.use(serve(distDir))
  app.use(async (ctx) => {
    if (!ctx.path.startsWith('/api') &&
      ctx.path !== '/health' &&
      ctx.path !== '/upload' &&
      ctx.path !== '/webhook') {
      await send(ctx, 'index.html', { root: distDir })
    }
  })
  console.log('[bootstrap] SPA fallback registered')

  // Start server using the configured bind host. Default is IPv4 for WSL stability.
  const listenResult = await listenWithFallback(app, config.port, config.host)
  server = listenResult.primary
  servers = listenResult.servers
  console.log('[bootstrap] app.listen called')

  setupTerminalWebSocket(servers)
  setupKanbanEventsWebSocket(servers)
  console.log('[bootstrap] terminal + kanban websocket setup')

  // Group chat Socket.IO (must be after server is created)
  const groupChatServer = new GroupChatServer(servers)
  setGroupChatServer(groupChatServer)
  groupChatServer.setGatewayManager(getGatewayManagerInstance())

  // Chat run Socket.IO — shares the same Server instance, just adds /chat-run namespace
  chatRunServer = new ChatRunSocket(groupChatServer.getIO(), getGatewayManagerInstance())
  setChatRunServer(chatRunServer)
  chatRunServer.init()

  // Session deleter — periodically drain pending session deletes
  const { SessionDeleter } = await import('./services/hermes/session-deleter')
  const sessionDeleter = SessionDeleter.getInstance()
  const activeProfile = process.env.PROFILE || 'default'
  sessionDeleter.start(activeProfile)
  console.log('[bootstrap] session deleter started, profile=%s', activeProfile)

  // Catch-all: destroy upgrade requests not handled by terminal or Socket.IO
  servers.forEach((httpServer) => {
    httpServer.on('upgrade', (req: any, socket: any) => {
      const url = new URL(req.url || '', `http://${req.headers.host}`)
      if (url.pathname !== '/api/hermes/terminal' && url.pathname !== '/api/hermes/kanban/events' && !url.pathname.startsWith('/socket.io/')) {
        socket.destroy()
      }
    })
  })

  const interfaces = safeNetworkInterfaces()
  const localIp = Object.values(interfaces).flat().find(i => i?.family === 'IPv4' && !i?.internal)?.address || 'localhost'
  console.log(`Server: http://localhost:${config.port} (LAN: http://${localIp}:${config.port})`)
  console.log(`Log: ~/.hermes-web-ui/logs/server.log`)
  logger.info('Server: http://localhost:%d (LAN: http://%s:%d)', config.port, localIp, config.port)

  // Restore group chat agents after server is ready.
  groupChatServer.restoreWhenReady()

  servers.forEach((httpServer) => {
    httpServer.on('error', (err: any) => {
      console.error('[bootstrap] server error:', err.code || err.message)
      logger.error({ err }, 'Server error')
    })
  })

  bindShutdown(servers, groupChatServer, chatRunServer)
}

bootstrap()
