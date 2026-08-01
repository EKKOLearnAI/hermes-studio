#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCachedRuntime } from './desktop-runtime-detection.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmArgs = ['--prefix', 'packages/desktop', 'run', 'dev']

function webUiHome() {
  return process.env.HERMES_WEB_UI_HOME?.trim() || resolve(homedir(), '.hermes-web-ui')
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
const cachedRuntime = process.env.HERMES_DESKTOP_RUNTIME_DIR?.trim() || findCachedRuntime(webUiHome())
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
