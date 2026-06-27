import { logger } from './logger'
import { closeDb } from '../db'
import { stopPreviewRuntime } from '../controllers/update'
import { codingAgentRunManager } from './agent-runner/coding-agent-run-manager'
import { ompSessionManager } from './hermes/run-chat/omp-session-manager'
import { shutdownManagedGateways } from './hermes/gateway-runner'
import { stopOutboundRelayClient } from './global-agent/outbound-relay-client'
import { getCronScheduler } from './hermes/cron/scheduler'

const DEFAULT_SHUTDOWN_FORCE_EXIT_MS = 15_000
const DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS = 15_000

function envPositiveInt(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export function getShutdownForceExitMs(): number {
  const override = envPositiveInt('HERMES_WEB_UI_SHUTDOWN_FORCE_EXIT_MS')
  if (override) return override
  const desktop = String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
  return desktop ? DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS : DEFAULT_SHUTDOWN_FORCE_EXIT_MS
}

export function shouldStopAgentBridgeOnShutdown(_signal: string): boolean {
  const raw = String(process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  // Restart now defaults to a fresh bridge so package/runtime upgrades do not
  // attach to stale brokers. Operators can opt back into restart resume with
  // HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN=0.
  return true
}

export function shouldStopManagedGatewaysOnShutdown(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  return String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
}

export type ShutdownHandler = (signal: string) => Promise<void>

export function createShutdownHandler(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any): ShutdownHandler {
  let isShuttingDown = false

  return async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    // Force exit only if graceful cleanup hangs. The bridge can take up to 10s
    // to stop worker subprocesses, so this cap must be longer than that.
    setTimeout(() => process.exit(0), getShutdownForceExitMs())

    logger.info('Shutting down (%s)...', signal)
    console.log(`[shutdown] Received signal: ${signal}`)

    try {
      try {
        await stopPreviewRuntime()
        logger.info('Preview runtime stopped')
      } catch (err) {
        logger.warn(err, 'Failed to stop preview runtime (non-fatal)')
      }

      if (shouldStopManagedGatewaysOnShutdown()) {
        try {
          const result = await shutdownManagedGateways()
          logger.info('[shutdown] managed gateways stopped result=%j', result)
        } catch (err) {
          logger.warn(err, 'Failed to stop managed gateways (non-fatal)')
        }
      } else {
        logger.info('[shutdown] leaving managed gateways running')
      }

      if (agentBridgeManager && shouldStopAgentBridgeOnShutdown(signal)) {
        try {
          await agentBridgeManager.stop()
          logger.info('Agent bridge stopped')
        } catch (err) {
          logger.warn(err, 'Failed to stop agent bridge (non-fatal)')
        }
      } else if (agentBridgeManager) {
        logger.info('Leaving agent bridge running across Web UI shutdown')
      }

      // Close ChatRunSocket first to release WebSocket state.
      if (chatRunServer) {
        chatRunServer.close()
        logger.info('ChatRunSocket closed')
      }

      stopOutboundRelayClient()
      logger.info('Outbound relay clients closed')

      codingAgentRunManager.shutdown()
      logger.info('Coding agent hidden sessions closed')

      ompSessionManager.stopAll()
      logger.info('omp sessions closed')

      getCronScheduler().stop()
      logger.info('Cron scheduler stopped')

      // Disconnect Socket.IO before HTTP server to prevent hanging
      if (groupChatServer) {
        groupChatServer.agentClients.disconnectAll()
        groupChatServer.getIO().close()
        logger.info('Socket.IO closed')
      }

      const servers = Array.isArray(server) ? server : [server].filter(Boolean)
      if (servers.length) {
        await Promise.all(servers.map((httpServer) => (
          new Promise<void>((resolve) => {
            httpServer.close(() => {
              logger.info('HTTP server closed')
              resolve()
            })
          })
        )))
      }
    } catch (err) {
      logger.error(err, 'Shutdown error')
    }

    closeDb()
    process.exit(0)
  }
}

export function bindShutdown(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any): ShutdownHandler {
  const shutdown = createShutdownHandler(server, groupChatServer, chatRunServer, agentBridgeManager)

  process.once('SIGUSR2', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return shutdown
}
