import pino from 'pino'
import { resolve } from 'path'
import { mkdirSync, statSync, truncateSync, openSync, readSync, closeSync, writeFileSync } from 'fs'
import { config } from '../config'

const MAX_LOG_SIZE = 3 * 1024 * 1024 // 3MB
const CHECK_INTERVAL = 60_000 // Check every minute

const logDir = resolve(config.appHome, 'logs')
mkdirSync(logDir, { recursive: true })

const logFile = resolve(logDir, 'server.log')
const bridgeLogFile = resolve(logDir, 'bridge.log')

function rotateFileIfNeeded(file: string) {
  try {
    const stat = statSync(file)
    if (stat.size > MAX_LOG_SIZE) {
      const keepSize = Math.floor(MAX_LOG_SIZE / 2)
      const fd = openSync(file, 'r')
      const buf = Buffer.alloc(keepSize)
      readSync(fd, buf, 0, keepSize, stat.size - keepSize)
      closeSync(fd)
      truncateSync(file, 0)
      writeFileSync(file, buf)
    }
  } catch { }
}

function rotateIfNeeded() {
  rotateFileIfNeeded(logFile)
  rotateFileIfNeeded(bridgeLogFile)
}

// Rotate on startup
rotateIfNeeded()

// Periodic rotation check — prevents unbounded log growth
setInterval(rotateIfNeeded, CHECK_INTERVAL)

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
}, pino.destination({
  dest: logFile,
  sync: true,
}))

export const bridgeLogger = pino({
  level: process.env.BRIDGE_LOG_LEVEL || process.env.LOG_LEVEL || 'info',
  name: 'bridge',
}, pino.destination({
  dest: bridgeLogFile,
  sync: true,
}))
