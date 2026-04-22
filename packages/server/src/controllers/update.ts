import { execFileSync, spawn } from 'child_process'
import { dirname, join } from 'path'

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

function quoteForWindowsCommand(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function runUpdateInstall() {
  if (process.platform === 'win32') {
    return execFileSync(getWindowsShell(), ['/d', '/s', '/c', `${quoteForWindowsCommand(getNpmBin())} install -g hermes-web-ui@latest`], {
      encoding: 'utf-8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  return execFileSync(getNpmBin(), ['install', '-g', 'hermes-web-ui@latest'], {
    encoding: 'utf-8',
    timeout: 120000,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function spawnRestart(port: string) {
  if (process.platform === 'win32') {
    return spawn(getWindowsShell(), ['/d', '/s', '/c', `${quoteForWindowsCommand(getCliBin())} restart --port ${port}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  }

  return spawn(getCliBin(), ['restart', '--port', port], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
}

export async function handleUpdate(ctx: any) {
  try {
    const output = runUpdateInstall()
    ctx.body = { success: true, message: output.trim() }
    setTimeout(() => {
      spawnRestart(process.env.PORT || '8648').unref()
      process.exit(0)
    }, 2000)
  } catch (err: any) {
    ctx.status = 500
    ctx.body = { success: false, message: err.stderr || err.message }
  }
}
