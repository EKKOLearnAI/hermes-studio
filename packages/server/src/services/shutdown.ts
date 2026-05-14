import { logger } from './logger'
import { closeDb } from '../db'
import { getGatewayManagerInstance } from './gateway-bootstrap'

function shouldStopGatewaysOnShutdown(signal: string): boolean {
  // nodemon may use SIGTERM on Windows restarts, so dev mode opts out via env.
  // Production keeps stopping owned gateways by default.
  const override = process.env.HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN?.trim()

  console.log(`[shutdown] Signal: ${signal}, HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN: ${override}`)

  // Explicit '0' or 'false' means dev mode: never stop gateways
  if (override === '0' || override === 'false') {
    console.log('[shutdown] Dev mode detected: NOT stopping gateways')
    return false
  }

  // Explicit '1' or 'true' means always stop gateways
  if (override === '1' || override === 'true') {
    console.log('[shutdown] Explicit gateway shutdown enabled: stopping gateways')
    return true
  }

  // Default behavior: only stop gateways on explicit termination, not on reload
  const shouldStop = signal !== 'SIGUSR2'
  console.log(`[shutdown] Default behavior: ${shouldStop ? 'STOPPING' : 'NOT stopping'} gateways (signal: ${signal})`)
  return shouldStop
}

export function bindShutdown(server: any, groupChatServer?: any, chatRunServer?: any, agentBridgeManager?: any): void {
  let isShuttingDown = false

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    // Force exit after 3s no matter what
    setTimeout(() => process.exit(0), 3000)

    logger.info('Shutting down (%s)...', signal)
    console.log(`[shutdown] Received signal: ${signal}`)
    console.log(`[shutdown] HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN = ${process.env.HERMES_WEB_UI_STOP_GATEWAYS_ON_SHUTDOWN}`)
    console.log(`[shutdown] shouldStopGatewaysOnShutdown = ${shouldStopGatewaysOnShutdown(signal)}`)

    try {
      if (shouldStopGatewaysOnShutdown(signal)) {
        // Stop gateway processes owned by this Web UI instance first.
        try {
          const gatewayManager = getGatewayManagerInstance()
          if (gatewayManager) {
            await gatewayManager.stopAll()
            logger.info('All gateways stopped')
          }
        } catch (err) {
          logger.warn(err, 'Failed to stop gateways (non-fatal)')
        }
      } else {
        logger.info('Skipping gateway shutdown for %s', signal)
      }

      if (agentBridgeManager) {
        try {
          await agentBridgeManager.stop()
          logger.info('Agent bridge stopped')
        } catch (err) {
          logger.warn(err, 'Failed to stop agent bridge (non-fatal)')
        }
      }

      // Close ChatRunSocket first to abort all active runs and close EventSource connections
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
