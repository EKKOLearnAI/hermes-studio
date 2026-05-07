import Koa from 'koa'
import cors from '@koa/cors'
import bodyParser from '@koa/bodyparser'
import serve from 'koa-static'
import send from 'koa-send'
import os from 'os'
import { resolve } from 'path'
import { mkdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { config } from './config'
import { getToken, requireAuth } from './services/auth'
import { initGatewayManager, getGatewayManagerInstance } from './services/gateway-bootstrap'
import { bindShutdown } from './services/shutdown'
import { setupTerminalWebSocket } from './routes/hermes/terminal'
import { startVersionCheck } from './routes/health'
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

// Global error handlers
process.on('uncaughtException', (err) => {
  logger.fatal(err, 'Uncaught exception')
  process.exit(1)
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

function probeIPv4(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = require('http').get(`http://127.0.0.1:${port}/health`, (res: any) => {
      res.resume()
      resolve(true)
    })
    req.once('error', () => resolve(false))
    req.setTimeout(1000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Try listening on IPv6 dual-stack (::) first. If IPv4 is not reachable through
 * that socket, keep IPv6 and add a separate IPv4 listener. Fall back to IPv4
 * only when IPv6 is unavailable. Skips fallback when BIND_HOST is explicitly set.
 *
 * On some systems (e.g. WSL2), binding to :: succeeds but the dual-stack
 * doesn't actually accept IPv4 connections. We detect this by probing
 * 127.0.0.1 after binding.
 */
async function listenWithFallback(app: Koa, port: number, host?: string): Promise<ListenResult> {
  // Explicit host: use it directly.
  if (host) {
    console.log(`[bootstrap] listening on ${host}:${port}`)
    const explicit = await listen(app, port, host)
    return { primary: explicit, servers: [explicit] }
  }

  console.log(`[bootstrap] trying IPv6 dual-stack on ::${port}`)
  try {
    const s6 = await listen(app, port, '::')
    if (await probeIPv4(port)) {
      console.log(`[bootstrap] IPv6 dual-stack verified (IPv4 probe ok) on ::${port}`)
      return { primary: s6, servers: [s6] }
    }

    console.log('[bootstrap] IPv6 listener is IPv6-only, adding IPv4 listener on 0.0.0.0')
    try {
      const s4 = await listen(app, port, '0.0.0.0')
      console.log(`[bootstrap] listening on ::${port} and 0.0.0.0:${port}`)
      return { primary: s6, servers: [s6, s4] }
    } catch (err) {
      console.log('[bootstrap] IPv4 listener failed; keeping IPv6 listener')
      logger.warn({ err }, 'Could not add IPv4 listener after IPv6-only bind')
      return { primary: s6, servers: [s6] }
    }
  } catch (err: any) {
    if (err.code !== 'EADDRNOTAVAIL' && err.code !== 'EAFNOSUPPORT' && err.code !== 'EPROTONOSUPPORT') {
      throw err
    }

    console.log(`[bootstrap] IPv6 not available (${err.code}), falling back to 0.0.0.0`)
    const s4 = await listen(app, port, '0.0.0.0')
    console.log(`[bootstrap] listening on 0.0.0.0:${port}`)
    return { primary: s4, servers: [s4] }
  }
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
  await mkdir(config.uploadDir, { recursive: true })
  await mkdir(config.dataDir, { recursive: true })

  const authToken = await getToken()
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

  app.use(cors({ origin: config.corsOrigins }))
  app.use(bodyParser())
  console.log('[bootstrap] cors + bodyParser registered')

  // Register all routes (handles auth internally)
  const proxyMiddleware = registerRoutes(app, requireAuth(authToken))
  app.use(proxyMiddleware)
  console.log('[bootstrap] routes registered')

  if (authToken) {
    console.log(`Auth enabled — token: ${authToken}`)
    logger.info('Auth enabled — token: %s', authToken)
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

  // Start server — try IPv6 dual-stack first, fall back to IPv4
  const listenResult = await listenWithFallback(app, config.port, config.host)
  server = listenResult.primary
  servers = listenResult.servers
  console.log('[bootstrap] app.listen called')

  setupTerminalWebSocket(servers)
  console.log('[bootstrap] terminal websocket setup')

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
      if (url.pathname !== '/api/hermes/terminal' && !url.pathname.startsWith('/socket.io/')) {
        socket.destroy()
      }
    })
  })

  const interfaces = safeNetworkInterfaces()
  const localIp = Object.values(interfaces).flat().find(i => i?.family === 'IPv4' && !i?.internal)?.address || 'localhost'
  console.log(`Server: http://localhost:${config.port} (LAN: http://${localIp}:${config.port})`)
  console.log(`Upstream: ${config.upstream}`)
  console.log(`Log: ~/.hermes-web-ui/logs/server.log`)
  logger.info('Server: http://localhost:%d (LAN: http://%s:%d)', config.port, localIp, config.port)
  logger.info('Upstream: %s', config.upstream)

  // Restore group chat agents after server is ready.
  groupChatServer.restoreWhenReady()

  servers.forEach((httpServer) => {
    httpServer.on('error', (err: any) => {
      console.error('[bootstrap] server error:', err.code || err.message)
      logger.error({ err }, 'Server error')
    })
  })

  bindShutdown(servers, groupChatServer, chatRunServer)
  startVersionCheck()
}

bootstrap()
