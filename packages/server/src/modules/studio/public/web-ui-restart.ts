import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { config } from './config'

let restartScheduled = false

function isDesktopRuntime(): boolean {
  return String(process.env.HERMES_DESKTOP || '').trim().toLowerCase() === 'true'
}

function webUiCliPath(): string {
  const candidates = [
    process.env.HERMES_WEB_UI_CLI_BIN?.trim(),
    join(process.cwd(), 'bin', 'hermes-web-ui.mjs'),
    resolve(__dirname, '..', '..', '..', '..', '..', 'bin', 'hermes-web-ui.mjs'),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const cli = candidates.find(existsSync)
  if (!cli) throw new Error('Unable to locate bin/hermes-web-ui.mjs for restart')
  return cli
}

/** Schedule a CLI-supervised standalone Web UI restart after the API response. */
export function scheduleWebUiRestart(): void {
  if (isDesktopRuntime()) throw new Error('Desktop Runtime must restart through the desktop shell')
  if (restartScheduled) return
  const cli = webUiCliPath()
  restartScheduled = true
  setTimeout(() => {
    const child = spawn(process.execPath, [cli, 'restart', '--port', String(config.port), '--no-open'], {
      cwd: dirname(dirname(cli)),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    })
    child.unref()
  }, 250).unref?.()
}

export function resetWebUiRestartForTests(): void {
  restartScheduled = false
}
