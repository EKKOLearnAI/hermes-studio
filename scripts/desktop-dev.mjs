#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmArgs = ['--prefix', 'packages/desktop', 'run', 'dev']

function runtimePlatformKey() {
  const osLabel = platform() === 'win32' ? 'win' : platform() === 'darwin' ? 'mac' : platform()
  return `${osLabel}-${arch()}`
}

function runtimeReady(runtimeRoot) {
  const isWin = platform() === 'win32'
  const required = isWin
    ? [
        join(runtimeRoot, 'python', 'python.exe'),
        join(runtimeRoot, 'python', 'Scripts', 'hermes.cmd'),
        join(runtimeRoot, 'node', 'node.exe'),
        join(runtimeRoot, 'git', 'cmd', 'git.exe'),
      ]
    : [
        join(runtimeRoot, 'python', 'bin', 'python3'),
        join(runtimeRoot, 'python', 'bin', 'hermes'),
        join(runtimeRoot, 'node', 'bin', 'node'),
      ]
  return required.every(existsSync)
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

function webUiHome() {
  return process.env.HERMES_WEB_UI_HOME?.trim() || resolve(homedir(), '.hermes-web-ui')
}

function findCachedRuntime() {
  const runtimeRoot = join(webUiHome(), 'desktop-runtime')
  const platformKey = runtimePlatformKey()
  const active = readJson(join(runtimeRoot, 'active-version.json'))
  const activeRuntime = typeof active?.runtimeDirectory === 'string' ? active.runtimeDirectory.trim() : ''
  if (active?.platform === platformKey && activeRuntime && runtimeReady(activeRuntime)) {
    return activeRuntime
  }

  const hermesRoot = join(runtimeRoot, 'hermes')
  if (!existsSync(hermesRoot)) return ''
  try {
    return readdirSync(hermesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(hermesRoot, entry.name, platformKey))
      .filter(runtimeReady)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      [0] || ''
  } catch {
    return ''
  }
}

function quoteCmdArg(arg) {
  return /^[A-Za-z0-9_./:=\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`
}

function npmCommand() {
  const npmExecPath = process.env.npm_execpath?.trim()
  const npmCliPath = npmExecPath && existsSync(npmExecPath)
    ? npmExecPath
    : resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

  if (existsSync(npmCliPath)) {
    return {
      command: process.execPath,
      args: [npmCliPath, ...npmArgs],
    }
  }

  if (process.platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', ['npm', ...npmArgs].map(quoteCmdArg).join(' ')],
    }
  }

  return {
    command: 'npm',
    args: npmArgs,
  }
}

const { command, args } = npmCommand()
const cachedRuntime = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim() || findCachedRuntime()
const child = spawn(command, args, {
  cwd: root,
  env: {
    ...process.env,
    HERMES_WEB_UI_DIR: root,
    ...(cachedRuntime ? { HERMES_DESKTOP_RUNTIME_DIR: cachedRuntime } : {}),
  },
  stdio: 'inherit',
})

child.on('error', error => {
  console.error(`Failed to start desktop dev server: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
