import { execFileSync, spawn } from 'child_process'
import { existsSync } from 'fs'
import { delimiter, dirname, join } from 'path'

function getNodeBinDir() {
  return dirname(process.execPath)
}

function getNodePrefix() {
  return process.platform === 'win32' ? getNodeBinDir() : dirname(getNodeBinDir())
}

function getNpmCliPath() {
  const prefix = getNodePrefix()
  const candidates = process.platform === 'win32'
    ? [
        join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        join(getNodeBinDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      ]
    : [join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const npmCli = candidates.find(existsSync)

  if (!npmCli) {
    throw new Error(`Unable to locate npm CLI for ${process.execPath}; checked ${candidates.join(', ')}`)
  }

  return npmCli
}

function getGlobalPackageBin(prefix: string) {
  return process.platform === 'win32'
    ? join(prefix, 'node_modules', 'hermes-web-ui', 'bin', 'hermes-web-ui.mjs')
    : join(prefix, 'lib', 'node_modules', 'hermes-web-ui', 'bin', 'hermes-web-ui.mjs')
}

function getCurrentNodeEnv() {
  return {
    ...process.env,
    PATH: [getNodeBinDir(), process.env.PATH].filter(Boolean).join(delimiter),
    npm_node_execpath: process.execPath,
  }
}

function runNpm(args: string[], options: { timeout?: number } = {}) {
  return execFileSync(process.execPath, [getNpmCliPath(), ...args], {
    encoding: 'utf-8',
    timeout: options.timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: getCurrentNodeEnv(),
  }).trim()
}

function getGlobalPrefix() {
  return runNpm(['prefix', '-g'])
}

function getGlobalCliScript() {
  return getGlobalPackageBin(getGlobalPrefix())
}

function runUpdateInstall() {
  return runNpm(['install', '-g', 'hermes-web-ui@latest'], { timeout: 10 * 60 * 1000 })
}

function spawnRestart(port: string) {
  const cli = getGlobalCliScript()

  return spawn(process.execPath, [cli, 'restart', '--port', port], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: getCurrentNodeEnv(),
  })
}

export async function handleUpdate(ctx: any) {
  try {
    const output = runUpdateInstall()

    ctx.body = {
      success: true,
      message: output.trim() || 'hermes-web-ui updated successfully',
    }

    setTimeout(() => {
      try {
        spawnRestart(process.env.PORT || '8648').unref()
      } finally {
        process.exit(0)
      }
    }, 3000)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = {
      success: false,
      message: err.stderr?.toString() || err.message || String(err),
    }
  }
}
