import { logger } from './logger'

export function bindShutdown(server: any, groupChatServer?: any, chatRunServer?: any): void {
  let isShuttingDown = false

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info('Shutting down (%s)...', signal)

    try {
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

      if (server) {
        await new Promise<void>((resolve) => {
          server.close(() => {
            logger.info('HTTP server closed')
            resolve()
          })
        })
      }
    } catch (err) {
      logger.error(err, 'Shutdown error')
    }

    process.exit(0)
  }

  process.once('SIGUSR2', shutdown)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
