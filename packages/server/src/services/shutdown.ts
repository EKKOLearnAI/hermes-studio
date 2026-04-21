import { logger } from './logger'

export function bindShutdown(server: any): void {
  let isShuttingDown = false

  const shutdown = async (signal: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info('Shutting down (%s)...', signal)

    try {
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
