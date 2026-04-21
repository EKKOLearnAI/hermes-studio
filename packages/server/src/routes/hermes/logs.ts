import Router from '@koa/router'
import { existsSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import * as hermesCli from '../../services/hermes/hermes-cli'

export const logRoutes = new Router()

const WEBUI_LOG_FILE = join(homedir(), '.hermes-web-ui', 'logs', 'server.log')

// List available log files
logRoutes.get('/api/hermes/logs', async (ctx) => {
  const files = await hermesCli.listLogFiles()

  if (existsSync(WEBUI_LOG_FILE)) {
    try {
      const stat = statSync(WEBUI_LOG_FILE)
      const size = stat.size > 1024 * 1024
        ? `${(stat.size / 1024 / 1024).toFixed(1)}MB`
        : `${(stat.size / 1024).toFixed(1)}KB`
      const modified = stat.mtime.toLocaleString()
      files.push({ name: 'webui', size, modified })
    } catch { }
  }

  ctx.body = { files }
})

interface LogEntry {
  timestamp: string
  level: string
  logger: string
  message: string
  raw: string
}

// Parse a single log line into structured entry
function parseLine(line: string): LogEntry {
  // Try pino JSON format first (webui logs)
  try {
    const obj = JSON.parse(line)
    if (obj.level && obj.time) {
      const ts = new Date(obj.time).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-')
      const levelMap: Record<number, string> = { 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR', 50: 'FATAL' }
      return {
        timestamp: ts,
        level: levelMap[obj.level] || 'INFO',
        logger: obj.msg || '',
        message: typeof obj.msg === 'string' ? obj.msg : JSON.stringify(obj.msg),
        raw: line,
      }
    }
  } catch {}
  // Match: 2026-04-11 20:16:16,289 INFO aiohttp.access: message (agent log format)
  let match = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\s+(DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+(\S+?):\s(.*)$/)
  if (match) {
    return { timestamp: match[1], level: match[2], logger: match[3], message: match[4], raw: line }
  }
  // Match: [Lark] [2026-04-19 18:46:54,864] [INFO] message (gateway log format)
  match = line.match(/^\[(\S+?)\]\s+\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})\]\s+\[(DEBUG|INFO|WARNING|ERROR|CRITICAL)\]\s(.*)$/)
  if (match) {
    return { timestamp: match[2], level: match[3], logger: match[1], message: match[4], raw: line }
  }
  // Unparseable line — keep as raw entry so nothing is lost
  return { timestamp: '', level: '', logger: '', message: line, raw: line }
}

// Read log lines (parsed)
logRoutes.get('/api/hermes/logs/:name', async (ctx) => {
  const logName = ctx.params.name
  const lines = ctx.query.lines ? parseInt(ctx.query.lines as string, 10) : 100
  const level = (ctx.query.level as string) || undefined
  const session = (ctx.query.session as string) || undefined
  const since = (ctx.query.since as string) || undefined

  // Handle hermes-web-ui's own server log
  if (logName === 'webui') {
    try {
      if (!existsSync(WEBUI_LOG_FILE)) {
        ctx.body = { entries: [] }
        return
      }
      const content = await readFile(WEBUI_LOG_FILE, 'utf-8')
      const rawLines = content.split('\n')
      const sliced = rawLines.length > lines ? rawLines.slice(-lines) : rawLines
      const entries: LogEntry[] = []
      for (const line of sliced) {
        if (!line.trim()) continue
        entries.push(parseLine(line))
      }
      ctx.body = { entries: entries.reverse() }
    } catch (err: any) {
      ctx.status = 500
      ctx.body = { error: err.message }
    }
    return
  }

  try {
    const content = await hermesCli.readLogs(logName, lines, level, session, since)
    const rawLines = content.split('\n')

    const entries: (LogEntry | null)[] = []
    for (const line of rawLines) {
      // Skip header lines like "--- ~/.hermes/logs/agent.log (last 100) ---"
      if (line.startsWith('---') || line.trim() === '') continue
      entries.push(parseLine(line))
    }

    ctx.body = { entries: entries.reverse() }
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { error: err.message }
  }
})
