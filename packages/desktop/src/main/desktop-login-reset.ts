import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { bundledNode, webUiHome, webuiDir } from './paths'

const DEFAULT_USERNAME = 'admin'
const DEFAULT_PASSWORD = '123456'
const EXEC_MAX_BUFFER = 1024 * 1024

function resolveNodeForWebUiCli(): string {
  try {
    const node = bundledNode()
    if (existsSync(node)) return node
  } catch {
    /* fall back to the current executable */
  }
  return process.execPath
}

function webUiCliScriptPath(): string {
  return join(webuiDir(), 'bin', 'hermes-web-ui.mjs')
}

async function runWebUiCliCommand(command: string): Promise<void> {
  const node = resolveNodeForWebUiCli()
  const script = webUiCliScriptPath()
  const home = webUiHome()

  await new Promise<void>((resolve, reject) => {
    execFile(node, [script, command], {
      cwd: webuiDir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HERMES_WEB_UI_HOME: home,
        HERMES_WEBUI_STATE_DIR: home,
      },
      maxBuffer: EXEC_MAX_BUFFER,
      windowsHide: true,
    }, (error, _stdout, stderr) => {
      if (!error) {
        resolve()
        return
      }
      const detail = typeof stderr === 'string' && stderr.trim() ? stderr.trim() : error.message
      reject(new Error(detail))
    })
  })
}

export async function resetDesktopDefaultLogin(): Promise<{ username: string; password: string }> {
  await runWebUiCliCommand('reset-default-login')
  await runWebUiCliCommand('clear-login-locks')
  return { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD }
}
