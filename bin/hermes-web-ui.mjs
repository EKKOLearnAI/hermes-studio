#!/usr/bin/env node
import { spawn, execSync } from 'child_process'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, chmodSync, statSync } from 'fs'
import { randomBytes } from 'crypto'
import { homedir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverEntry = resolve(__dirname, '..', 'dist', 'server', 'index.js')
const pkgDir = resolve(__dirname, '..')
const pkg = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))
const VERSION = pkg.version
const PID_DIR = resolve(homedir(), '.hermes-web-ui')
const PID_FILE = join(PID_DIR, 'server.pid')
const LOG_FILE = join(PID_DIR, 'server.log')
const TOKEN_FILE = join(PID_DIR, '.token')
const DEFAULT_PORT = 8648

// ─── Auto-fix node-pty native module ──────────────────────────
function ensureNativeModules() {
  const prebuildDir = join(pkgDir, 'node_modules', 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`)
  const helper = join(prebuildDir, 'spawn-helper')
  try {
    chmodSync(helper, 0o755)
  } catch {}
}

function getToken() {
  try {
    return readFileSync(TOKEN_FILE, 'utf-8').trim()
  } catch {
    return null
  }
}

function ensureToken() {
  // If AUTH_DISABLED or AUTH_TOKEN is set, let server handle it
  if (process.env.AUTH_DISABLED === '1' || process.env.AUTH_DISABLED === 'true') return null
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN

  let token = getToken()
  if (!token) {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true })
    token = randomBytes(32).toString('hex')
    writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 })
  }
  return token
}

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNpmBin() {
  return join(getNodeBinDir(), process.platform === 'win32' ? 'npm.cmd' : 'npm')
}

function getCliBin() {
  return join(getNodeBinDir(), process.platform === 'win32' ? 'hermes-web-ui.cmd' : 'hermes-web-ui')
}

function getWindowsShell() {
  return process.env.ComSpec || 'cmd.exe'
}

function quoteForWindowsCommand(value) {
  return `"${value.replace(/"/g, '""')}"`
}

function spawnCli(command, args, options) {
  if (process.platform === 'win32') {
    const commandLine = `${quoteForWindowsCommand(command)} ${args.map(arg => String(arg)).join(' ')}`
    return spawn(getWindowsShell(), ['/d', '/s', '/c', commandLine], options)
  }

  return spawn(command, args, options)
}

function getPortFromArgs() {
  if (process.argv[3] && !isNaN(process.argv[3])) return parseInt(process.argv[3])
  if (process.argv.includes('--port')) return parseInt(process.argv[process.argv.indexOf('--port') + 1])
  return null
}

function getRunningPort() {
  const pid = getPid()
  if (!pid || !isRunning(pid)) return null

  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -aon -p tcp | findstr LISTENING | findstr " ${pid}$"`, { encoding: 'utf-8' }).trim()
      const line = out.split('\n').find(Boolean)
      const address = line?.trim().split(/\s+/)[1]
      const port = address?.split(':').pop()
      return port ? parseInt(port, 10) : null
    }

    const out = execSync(`lsof -Pan -p ${pid} -iTCP -sTCP:LISTEN`, { encoding: 'utf-8' }).trim()
    const lines = out.split('\n').slice(1)
    for (const line of lines) {
      const match = line.match(/:(\d+)\s+\(LISTEN\)$/)
      if (match) return parseInt(match[1], 10)
    }
  } catch {}

  return null
}

function getUpdatePort() {
  const argPort = getPortFromArgs()
  if (argPort !== null) return argPort

  const runningPort = getRunningPort()
  if (runningPort !== null) return runningPort

  if (process.env.PORT && !isNaN(process.env.PORT)) return parseInt(process.env.PORT)
  return DEFAULT_PORT
}

function getPort() {
  const argPort = getPortFromArgs()
  return argPort ?? DEFAULT_PORT
}

function getPid() {
  try {
    return parseInt(readFileSync(PID_FILE, 'utf-8').trim())
  } catch {
    return null
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function writePid(pid) {
  writeFileSync(PID_FILE, String(pid))
}

function removePid() {
  try { unlinkSync(PID_FILE) } catch {}
}

function startDaemon(port) {
  const existing = getPid()
  if (existing && isRunning(existing)) {
    console.log(`  ✗ hermes-web-ui is already running (PID: ${existing})`)
    console.log(`    Use "hermes-web-ui stop" to stop it first`)
    process.exit(1)
  }
  removePid()

  // Check if port is already in use
  try {
    const isWin = process.platform === 'win32'
    let pids = ''
    if (isWin) {
      const out = execSync(`netstat -aon | findstr :${port}`, { encoding: 'utf-8' }).trim()
      const lines = out.split('\n').filter(l => l.includes('LISTENING'))
      pids = [...new Set(lines.map(l => l.trim().split(/\s+/).pop()).filter(Boolean))].join(' ')
    } else {
      pids = execSync(`lsof -ti:${port}`, { encoding: 'utf-8' }).trim()
    }
    if (pids) {
      console.log(`  ⚠ Port ${port} is in use by PID(s): ${pids}, killing...`)
      if (isWin) {
        execSync(`taskkill /F /PID ${pids.split(' ').join(' /PID ')}`, { encoding: 'utf-8' })
      } else {
        execSync(`kill -9 ${pids}`, { encoding: 'utf-8' })
      }
      // Brief wait for port to be released
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  } catch {
    // Port is free
  }

  mkdirSync(PID_DIR, { recursive: true })

  ensureNativeModules()
  const token = ensureToken()

  // Rotate log if over 3MB — keep last 2000 lines
  const MAX_LOG_SIZE = 3 * 1024 * 1024
  const MAX_LOG_LINES = 2000
  try {
    const stat = statSync(LOG_FILE)
    if (stat.size > MAX_LOG_SIZE) {
      const content = readFileSync(LOG_FILE, 'utf-8')
      const lines = content.split('\n')
      const kept = lines.slice(-MAX_LOG_LINES)
      writeFileSync(LOG_FILE, kept.join('\n'), 'utf-8')
      console.log(`  ↻ Log rotated (${(stat.size / 1024 / 1024).toFixed(1)}MB → ${kept.length} lines)`)
    }
  } catch { }

  const logStream = openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [serverEntry], {
    detached: true,
    stdio: ['ignore', logStream, logStream],
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), AUTH_TOKEN: token },
    windowsHide: true,
  })

  child.on('error', (err) => {
    console.error(`  ✗ Failed to start: ${err.message}`)
    removePid()
    process.exit(1)
  })

  child.unref()
  writePid(child.pid)

  // Poll health endpoint until server is ready (setTimeout to avoid overlapping requests)
  const healthUrl = `http://127.0.0.1:${port}/health`
  const maxWait = 30000
  const interval = 500
  let waited = 0

  console.log(`  ⏳ Starting hermes-web-ui (PID: ${child.pid}, port: ${port})...`)

  function poll() {
    waited += interval
    if (!isRunning(child.pid)) {
      console.log('  ✗ Failed to start hermes-web-ui')
      console.log(`    Check log: ${LOG_FILE}`)
      removePid()
      process.exit(1)
      return
    }

    fetch(healthUrl).then(res => {
      if (res.ok) {
        const url = token
          ? `http://localhost:${port}/#/?token=${token}`
          : `http://localhost:${port}`
        console.log(`  ✓ hermes-web-ui started`)
        console.log(`    ${url}`)
        console.log(`    Log: ${LOG_FILE}`)
        const isWin = process.platform === 'win32'
        const cmd = isWin ? `start ${url}` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`
        try { execSync(cmd, { stdio: 'ignore' }) } catch {}
      } else if (waited < maxWait) {
        setTimeout(poll, interval)
      } else {
        console.log(`  ⚠ Server process is running but health check failed after ${maxWait / 1000}s`)
        console.log(`    Check log: ${LOG_FILE}`)
        const url = token
          ? `http://localhost:${port}/#/?token=${token}`
          : `http://localhost:${port}`
        console.log(`    ${url}`)
      }
    }).catch(() => {
      if (waited < maxWait) {
        setTimeout(poll, interval)
      } else {
        console.log(`  ⚠ Server process is running but health check failed after ${maxWait / 1000}s`)
        console.log(`    Check log: ${LOG_FILE}`)
        const url = token
          ? `http://localhost:${port}/#/?token=${token}`
          : `http://localhost:${port}`
        console.log(`    ${url}`)
      }
    })
  }

  setTimeout(poll, interval)
}

function stopDaemon() {
  const pid = getPid()
  if (!pid) {
    console.log('  ✗ hermes-web-ui is not running')
    process.exit(1)
  }

  if (!isRunning(pid)) {
    removePid()
    console.log(`  ✓ hermes-web-ui was not running (cleaned stale PID)`)
    return
  }

  try {
    try {
      process.kill(pid, 'SIGTERM')
      // Wait briefly for graceful shutdown
      for (let i = 0; i < 10; i++) {
        if (!isRunning(pid)) break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
      }
    } catch {}
    // Force kill if still alive
    if (isRunning(pid)) {
      process.kill(pid, 'SIGKILL')
    }
    removePid()
    console.log(`  ✓ hermes-web-ui stopped (PID: ${pid})`)
  } catch (err) {
    console.log(`  ✗ Failed to stop: ${err.message}`)
    process.exit(1)
  }
}

function showStatus() {
  const pid = getPid()
  if (pid && isRunning(pid)) {
    console.log(`  ✓ hermes-web-ui is running (PID: ${pid})`)
    console.log(`    PID file: ${PID_FILE}`)
  } else {
    if (pid) removePid()
    console.log('  ✗ hermes-web-ui is not running')
  }
}

const command = process.argv[2] || 'start'

if (['-v', '--version', 'version'].includes(command)) {
  console.log(`hermes-web-ui v${VERSION}`)
  process.exit(0)
}

if (['-h', '--help', 'help'].includes(command)) {
  console.log(`
hermes-web-ui v${VERSION}

Usage: hermes-web-ui <command> [options]

Commands:
  start [port]       Start the server (default port: ${DEFAULT_PORT})
  stop               Stop the server
  restart [port]     Restart the server
  status             Show server status
  update             Update to latest version and restart
  version            Show version number

Options:
  -v, --version      Show version number
  -h, --help         Show this help message
  --port <port>      Specify port (used with start/restart)
`)
  process.exit(0)
}

function doUpdate() {
  console.log('  ⬆ Updating hermes-web-ui...')

  const child = spawnCli(getNpmBin(), ['install', '-g', 'hermes-web-ui@latest'], {
    stdio: 'inherit',
    windowsHide: true,
  })

  child.on('exit', (code) => {
    if (code === 0) {
      console.log('  ✓ Update complete, restarting...')
      const restart = spawnCli(getCliBin(), ['restart', '--port', String(getUpdatePort())], {
        stdio: 'inherit',
        windowsHide: true,
      })
      restart.on('exit', (restartCode) => process.exit(restartCode ?? 1))
    } else {
      console.log('  ✗ Update failed')
    }
  })
}

switch (command) {
  case 'start':
    startDaemon(getPort())
    break
  case 'stop':
    stopDaemon()
    break
  case 'restart':
    stopDaemon()
    setTimeout(() => startDaemon(getPort()), 500)
    break
  case 'status':
    showStatus()
    break
  case 'update':
  case 'upgrade':
    doUpdate()
    break
  default:
    ensureNativeModules()
    const port = !isNaN(command) ? parseInt(command) : DEFAULT_PORT
    const child = spawn(process.execPath, [serverEntry], {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port) },
      windowsHide: true,
    })
    child.on('exit', (code) => process.exit(code ?? 1))
    process.on('SIGTERM', () => child.kill('SIGTERM'))
    process.on('SIGINT', () => child.kill('SIGINT'))
}
