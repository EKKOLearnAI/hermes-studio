import Koa from 'koa'
import type { Context } from 'koa'
import cors from '@koa/cors'
import bodyParser from '@koa/bodyparser'
import serve from 'koa-static'
import send from 'koa-send'
import os from 'os'
import { resolve } from 'path'
import { mkdir } from 'fs/promises'
import { readFileSync } from 'fs'
import { config, shouldCreateWebUiDataDir } from './config'
import { initLoginLimiter } from './services/login-limiter'
import { bindShutdown } from './services/shutdown'
import { setupTerminalWebSocket } from './routes/hermes/terminal'
import { setupKanbanEventsWebSocket } from './routes/hermes/kanban-events'
import { startVersionCheck } from './routes/health'
import { registerRoutes } from './routes'
import { setGroupChatServer } from './routes/hermes/group-chat'
import { setChatRunServer } from './routes/hermes/chat-run'
import { GroupChatServer } from './services/hermes/group-chat'
import { ChatRunSocket } from './services/hermes/run-chat'
import { getAgentBridgeManager, startAgentBridgeManager } from './services/hermes/agent-bridge'
import { HermesSkillInjector } from './services/hermes/skill-injector'
import { injectBundledMcpServer } from './services/hermes/studio-mcp-autoinject'
import { ensureProfileGatewaysRunning } from './services/hermes/gateway-autostart'
import { refreshConfiguredProviderModelCatalogsInBackground } from './services/hermes/model-catalog-cache'
import { scanLanDevices, startLanDiscoveryResponder } from './services/lan-discovery'
import { getLanPeerSocketManager, getLanPeerSocketPath } from './services/lan-peer-socket'
import { startGlobalAgentServer } from './services/global-agent/server'
import { startOutboundRelayClient } from './services/global-agent/outbound-relay-client'
import { logger } from './services/logger'
import { createStaticCompressionMiddleware } from './middleware/static-compression'
import { requireUserJwt, resolveUserProfile } from './middleware/user-auth'
import { createCorsOriginResolver, securityHeaders } from './security'
import type { ShutdownHandler } from './services/shutdown'

// Injected by esbuild at build time; fallback to reading package.json in dev mode
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : (() => { try { return JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8')).version } catch { return 'dev' } })()

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('FATAL: Uncaught exception')
  console.error(err)
  logger.fatal(err, 'Uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection')
  console.error(reason)
  logger.error(reason, 'Unhandled rejection')
})

let server: any = null
let servers: any[] = []
let chatRunServer: any = null
let agentBridgeManager: any = null
let desktopShutdownHandler: ShutdownHandler | null = null

const LOCAL_GLOBAL_AGENT_CONNECTION_ID = 'local-global-agent'

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

function getLoopbackBaseUrl(httpServer: any): string {
  const address = httpServer?.address?.()
  const port = typeof address === 'object' && address?.port ? address.port : config.port
  return `http://127.0.0.1:${port}`
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

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function isLoopbackAddress(address?: string | null): boolean {
  if (!address) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.')
}

function bearerToken(ctx: Context): string {
  const header = ctx.get('authorization')
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function registerDesktopShutdownRoute(app: Koa): void {
  app.use(async (ctx, next) => {
    if (ctx.method !== 'POST' || ctx.path !== '/api/desktop/shutdown') {
      await next()
      return
    }

    if (!isDesktopRuntime()) {
      ctx.status = 404
      ctx.body = { error: 'not_found' }
      return
    }

    const remoteAddress = ctx.req.socket.remoteAddress
    if (!isLoopbackAddress(remoteAddress)) {
      ctx.status = 403
      ctx.body = { error: 'forbidden' }
      return
    }

    const expectedToken = String(process.env.AUTH_TOKEN || '').trim()
    if (!expectedToken || bearerToken(ctx) !== expectedToken) {
      ctx.status = 401
      ctx.body = { error: 'unauthorized' }
      return
    }

    if (!desktopShutdownHandler) {
      ctx.status = 503
      ctx.body = { error: 'shutdown_not_ready' }
      return
    }

    ctx.status = 202
    ctx.body = { ok: true }
    setTimeout(() => {
      void desktopShutdownHandler?.('desktop-api')
    }, 50).unref?.()
  })
}

function envFlagEnabled(name: string): boolean {
  const value = String(process.env[name] || '').trim().toLowerCase()
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function gatewayAutostartDisabled(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
}

function skillInjectionDisabled(): boolean {
  return envFlagEnabled('HERMES_WEB_UI_DISABLE_SKILL_INJECTION')
}

async function startRuntimeServicesBeforeListen(): Promise<void> {
  if (gatewayAutostartDisabled()) {
    console.log('[bootstrap] profile gateway check disabled by HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
  } else {
    void ensureProfileGatewaysRunning()
      .then(() => console.log('[bootstrap] profile gateways checked'))
      .catch((err) => {
        logger.warn(err, '[bootstrap] failed to ensure profile gateways')
        console.warn('[bootstrap] failed to ensure profile gateways:', err instanceof Error ? err.message : err)
      })
  }

  try {
    agentBridgeManager = await startAgentBridgeManager()
    console.log('[bootstrap] agent bridge started')
  } catch (err) {
    logger.warn(err, '[bootstrap] agent bridge failed to start')
    console.warn('[bootstrap] agent bridge failed to start:', err instanceof Error ? err.message : err)
  }
}

function startRuntimeServicesAfterListen(): void {
  if (gatewayAutostartDisabled()) {
    console.log('[bootstrap] profile gateway check disabled by HERMES_WEB_UI_DISABLE_GATEWAY_AUTOSTART')
  } else {
    void (async () => {
      try {
        await ensureProfileGatewaysRunning()
        console.log('[bootstrap] profile gateways checked')
      } catch (err) {
        logger.warn(err, '[bootstrap] failed to ensure profile gateways')
        console.warn('[bootstrap] failed to ensure profile gateways:', err instanceof Error ? err.message : err)
      }
    })()
  }

  void (async () => {
    try {
      agentBridgeManager = await startAgentBridgeManager()
      console.log('[bootstrap] agent bridge started')
    } catch (err) {
      logger.warn(err, '[bootstrap] agent bridge failed to start')
      console.warn('[bootstrap] agent bridge failed to start:', err instanceof Error ? err.message : err)
      return
    }
  })()
}

function startLanDiscovery(): void {
  const discoverySocket = startLanDiscoveryResponder({ httpPort: config.port })
  let initialScanStarted = false
  const runInitialScan = () => {
    if (initialScanStarted) return
    initialScanStarted = true
    void scanLanDevices().catch(err => logger.warn(err, '[lan-discovery] initial scan failed'))
  }

  if (discoverySocket) {
    discoverySocket.once('listening', runInitialScan)
    const fallbackTimer = setTimeout(runInitialScan, 500)
    fallbackTimer.unref?.()
  } else {
    runInitialScan()
  }
}

export async function bootstrap() {
  console.log(`hermes-web-ui v${APP_VERSION} starting...`)
  await mkdir(config.uploadDir, { recursive: true })
  if (shouldCreateWebUiDataDir()) {
    await mkdir(config.dataDir, { recursive: true })
  }

  await initLoginLimiter()
  if (skillInjectionDisabled()) {
    console.log('[bootstrap] bundled skill injection disabled by HERMES_WEB_UI_DISABLE_SKILL_INJECTION')
  } else {
    try {
      const skillInjector = new HermesSkillInjector()
      const injectionResult = await skillInjector.injectMissingSkills()
      if (injectionResult.injected.length > 0) {
        logger.info({
          injected: [...new Set(injectionResult.injected)],
          targetCount: injectionResult.targets.length,
        }, '[bootstrap] bundled skills injected')
      }
      if (injectionResult.updated.length > 0) {
        logger.info({
          updated: [...new Set(injectionResult.updated)],
          targetCount: injectionResult.targets.length,
        }, '[bootstrap] bundled skills updated')
      }
    } catch (err) {
      logger.warn(err, '[bootstrap] failed to inject bundled skills')
      console.warn('[bootstrap] failed to inject bundled skills:', err instanceof Error ? err.message : err)
    }
  }

  try {
    await injectBundledMcpServer()
  } catch (err) {
    logger.warn(err, '[bootstrap] failed to inject bundled MCP server')
    console.warn('[bootstrap] failed to inject bundled MCP server:', err instanceof Error ? err.message : err)
  }

  if (!isDesktopRuntime()) {
    await startRuntimeServicesBeforeListen()
  }

  const app = new Koa()
  // Initialize all web-ui SQLite tables
  const { initAllStores } = await import('./db/hermes/init')
  initAllStores()
  console.log('[bootstrap] all stores initialized')

  app.use(securityHeaders())
  app.use(cors({ origin: createCorsOriginResolver(config.corsOrigins) }))
  // Raise body limits above the default 1mb: profile avatars and MiMo voice-clone
  // reference audio are posted as base64 data URLs before reaching handlers.
  app.use(bodyParser({
    encoding: 'utf-8',
    jsonLimit: '20mb',
    formLimit: '20mb',
    textLimit: '20mb',
    parsedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  }))
  console.log('[bootstrap] cors + bodyParser registered')

  registerDesktopShutdownRoute(app)

  // Register all routes (handles auth internally)
  registerRoutes(app, [requireUserJwt, resolveUserProfile])
  console.log('[bootstrap] routes registered')

  // SPA fallback
  const distDir = resolve(__dirname, '..', 'client')
  app.use(createStaticCompressionMiddleware())
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
  getLanPeerSocketManager().setupServer(servers)
  console.log('[bootstrap] terminal + kanban + LAN peer websocket setup')

  // Group chat Socket.IO (must be after server is created)
  const groupChatServer = new GroupChatServer(servers)
  setGroupChatServer(groupChatServer)

  // Chat run Socket.IO — shares the same Server instance, just adds /chat-run namespace
  chatRunServer = new ChatRunSocket(groupChatServer.getIO())
  setChatRunServer(chatRunServer)
  chatRunServer.init()

  const loopbackBaseUrl = getLoopbackBaseUrl(server)
  const globalAgentServer = startGlobalAgentServer(groupChatServer.getIO())
  startOutboundRelayClient({
    connectionId: LOCAL_GLOBAL_AGENT_CONNECTION_ID,
    relayUrl: `${loopbackBaseUrl}${globalAgentServer.getNamespace()}`,
    relayToken: globalAgentServer.getAuthToken(),
    instanceId: LOCAL_GLOBAL_AGENT_CONNECTION_ID,
    localBaseUrl: loopbackBaseUrl,
  })
  console.log('[bootstrap] local global agent connected')

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
      if (url.pathname !== '/api/hermes/terminal' &&
        url.pathname !== '/api/hermes/kanban/events' &&
        url.pathname !== getLanPeerSocketPath() &&
        !url.pathname.startsWith('/socket.io/')) {
        socket.destroy()
      }
    })
  })

  const interfaces = safeNetworkInterfaces()
  const localIp = Object.values(interfaces).flat().find(i => i?.family === 'IPv4' && !i?.internal)?.address || 'localhost'
  console.log(`Server: http://localhost:${config.port} (LAN: http://${localIp}:${config.port})`)
  console.log(`Log: ${config.appHome}/logs/server.log`)
  logger.info('Server: http://localhost:%d (LAN: http://%s:%d)', config.port, localIp, config.port)
  startLanDiscovery()
  refreshConfiguredProviderModelCatalogsInBackground('bootstrap')

  if (isDesktopRuntime()) {
    agentBridgeManager = getAgentBridgeManager()
    startRuntimeServicesAfterListen()
  }

  // Restore group chat agents after server is ready.
  groupChatServer.restoreWhenReady()

  servers.forEach((httpServer) => {
    httpServer.on('error', (err: any) => {
      console.error('[bootstrap] server error:', err.code || err.message)
      logger.error({ err }, 'Server error')
    })
  })

  desktopShutdownHandler = bindShutdown(servers, groupChatServer, chatRunServer, agentBridgeManager)
  startVersionCheck()
}

bootstrap().catch((error) => {
  console.error('FATAL: Failed to start Hermes Web UI')
  console.error(error)
  logger.fatal(error, 'Fatal error during bootstrap')
  process.exit(1)
})
