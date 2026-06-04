import { logger } from './logger'
import { closeDb } from '../db'
import { stopPreviewRuntime } from '../controllers/update'

const DEFAULT_SHUTDOWN_FORCE_EXIT_MS = 15_000
const DEFAULT_DESKTOP_SHUTDOWN_FORCE_EXIT_MS = 3_000

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

export function shouldStopAgentBridgeOnShutdown(signal: string): boolean {
  const raw = String(process.env.HERMES_AGENT_BRIDGE_STOP_ON_SHUTDOWN || '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false

  // The CLI uses SIGUSR2 for an intentional Web UI restart so active bridge
  // runs survive and can be reattached. SIGTERM/SIGINT represent real service
  // shutdown and should stop the bridge broker/workers.
  return signal !== 'SIGUSR2'
}

export function bindShutdown(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any): void {
  let isShuttingDown = false

  const shutdown = async (signal: string) => {
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

      // Close ChatRunSocket first to release WebSocket state. CLI bridge runs
      // keep running in the external bridge and are reattached after restart.
      if (chatRunServer) {
        chatRunServer.close()
        logger.info('ChatRunSocket closed')
      }

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

  process.once('SIGUSR2', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
