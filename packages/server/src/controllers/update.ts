import { execFileSync, spawn } from 'child_process'
import { join } from 'path'

function getNpmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function getGlobalPrefix() {
  return execFileSync(getNpmBin(), ['prefix', '-g'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

function getGlobalCliBin() {
  const prefix = getGlobalPrefix()

  if (process.platform === 'win32') {
    return join(prefix, 'hermes-web-ui.cmd')
  }

  return join(prefix, 'bin', 'hermes-web-ui')
}

function runUpdateInstall() {
  return execFileSync(getNpmBin(), ['install', '-g', 'hermes-web-ui@latest'], {
    encoding: 'utf-8',
    timeout: 10 * 60 * 1000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function spawnRestart(port: string) {
  const cli = getGlobalCliBin()

  return spawn(cli, ['restart', '--port', port], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
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
