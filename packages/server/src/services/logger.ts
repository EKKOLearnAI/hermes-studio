import pino from 'pino'
import { resolve } from 'path'
import { mkdirSync, statSync, truncateSync, openSync, readSync, closeSync, writeFileSync } from 'fs'
import { homedir } from 'os'

const MAX_LOG_SIZE = 3 * 1024 * 1024 // 3MB
const CHECK_INTERVAL = 60_000 // Check every minute

const logDir = resolve(homedir(), '.hermes-web-ui', 'logs')
mkdirSync(logDir, { recursive: true })

const logFile = resolve(logDir, 'server.log')

function rotateIfNeeded() {
  try {
    const stat = statSync(logFile)
    if (stat.size > MAX_LOG_SIZE) {
      const keepSize = Math.floor(MAX_LOG_SIZE / 2)
      const fd = openSync(logFile, 'r')
      const buf = Buffer.alloc(keepSize)
      readSync(fd, buf, 0, keepSize, stat.size - keepSize)
      closeSync(fd)
      truncateSync(logFile, 0)
      writeFileSync(logFile, buf)
    }
  } catch {}
}

// Rotate on startup
rotateIfNeeded()

// Periodic rotation check — prevents unbounded log growth
setInterval(rotateIfNeeded, CHECK_INTERVAL)

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
}, pino.destination({
  dest: logFile,
  sync: false,
}))
