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
import { hermesRoutes, setupTerminalWebSocket, proxyMiddleware } from './routes/hermes'
import { uploadRoutes } from './routes/upload'
import { webhookRoutes } from './routes/webhook'
import { updateRoutes } from './routes/update'
import { healthRoutes, startVersionCheck } from './routes/health'
import { getToken, authMiddleware } from './services/auth'
import { initGatewayManager } from './services/gateway-bootstrap'
import { bindShutdown } from './services/shutdown'
import { logger } from './services/logger'

// Injected by esbuild at build time; fallback to reading package.json in dev mode
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version } catch { return 'dev' } } )()

// Global error handlers — ensure all uncaught errors are logged
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

  if (authToken) {
    app.use(await authMiddleware(authToken))
    logger.info('Auth enabled — token: %s', authToken)
  }

  await initGatewayManager()
  app.use(cors({ origin: config.corsOrigins }))
  app.use(bodyParser())

  // Shared routes (no agent prefix)
  app.use(webhookRoutes.routes())
  app.use(uploadRoutes.routes())
  app.use(updateRoutes.routes())

  // Hermes routes (must be after update — proxy catch-all matches everything)
  app.use(hermesRoutes.routes())
  app.use(proxyMiddleware)

  // Health check
  app.use(healthRoutes.routes())

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

  // Start server
  server = app.listen(config.port, '0.0.0.0')

  setupTerminalWebSocket(server)

  server.on('listening', () => {
    const interfaces = os.networkInterfaces()
    const localIp = Object.values(interfaces).flat().find(i => i?.family === 'IPv4' && !i?.internal)?.address || 'localhost'
    console.log(`Server: http://localhost:${config.port} (LAN: http://${localIp}:${config.port})`)
    console.log(`Upstream: ${config.upstream}`)
    console.log(`Log: ~/.hermes-web-ui/logs/server.log`)
    logger.info('Server: http://localhost:%d (LAN: http://%s:%d)', config.port, localIp, config.port)
    logger.info('Upstream: %s', config.upstream)
  })

  server.on('error', (err: any) => {
    logger.error({ err }, 'Server error')
  })

  bindShutdown(server)
  startVersionCheck()
}

bootstrap()
