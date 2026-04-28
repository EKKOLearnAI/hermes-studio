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
import { GroupChatServer } from './services/hermes/group-chat'
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

export async function bootstrap() {
  console.log(`hermes-web-ui v${APP_VERSION} starting...`)
  await mkdir(config.uploadDir, { recursive: true })
  await mkdir(config.dataDir, { recursive: true })

  const authToken = await getToken()
  const app = new Koa()

  await initGatewayManager()
  console.log('[bootstrap] gateway manager initialized')

  // Initialize web-ui SQLite tables
  const { initUsageStore } = await import('./db/hermes/usage-store')
  initUsageStore()
  console.log('[bootstrap] usage store initialized')

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

  // Start server
  console.log(`[bootstrap] listening on port ${config.port}`)
  server = app.listen(config.port, '0.0.0.0')
  console.log('[bootstrap] app.listen called')

  setupTerminalWebSocket(server)
  console.log('[bootstrap] terminal websocket setup')

  // Group chat Socket.IO (must be after server is created)
  const groupChatServer = new GroupChatServer(server)
  setGroupChatServer(groupChatServer)
  groupChatServer.setGatewayManager(getGatewayManagerInstance())

  // Catch-all: destroy upgrade requests not handled by terminal or Socket.IO
  server.on('upgrade', (req: any, socket: any) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    if (url.pathname !== '/api/hermes/terminal' && !url.pathname.startsWith('/socket.io/')) {
      socket.destroy()
    }
  })

  server.on('listening', () => {
    const interfaces = os.networkInterfaces()
    const localIp = Object.values(interfaces).flat().find(i => i?.family === 'IPv4' && !i?.internal)?.address || 'localhost'
    console.log(`Server: http://localhost:${config.port} (LAN: http://${localIp}:${config.port})`)
    console.log(`Upstream: ${config.upstream}`)
    console.log(`Log: ~/.hermes-web-ui/logs/server.log`)
    logger.info('Server: http://localhost:%d (LAN: http://%s:%d)', config.port, localIp, config.port)
    logger.info('Upstream: %s', config.upstream)

    // Restore group chat agents after server is ready
    groupChatServer.restoreWhenReady()
  })

  server.on('error', (err: any) => {
    console.error('[bootstrap] server error:', err.code || err.message)
    logger.error({ err }, 'Server error')
  })

  bindShutdown(server, groupChatServer)
  startVersionCheck()
}

bootstrap()
