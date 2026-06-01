import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'
import { bundledPython, hermesBin, hermesHome, pythonDir, webUiHome } from './paths'
import { HERMES_CLI_ARG } from './cli-constants'

export function parseHermesCliArgs(argv: string[] = process.argv): string[] | null {
  const index = argv.indexOf(HERMES_CLI_ARG)
  if (index < 0) return null
  return argv.slice(index + 1)
}

export async function runBundledHermesCli(args: string[]): Promise<number> {
  const command = hermesBin()
  if (!existsSync(command)) {
    console.error(`hermes binary missing at ${command}`)
    console.error('Run: npm run prepare:python (to bundle Python + hermes-agent)')
    return 127
  }

  mkdirSync(webUiHome(), { recursive: true })
  mkdirSync(hermesHome(), { recursive: true })

  const binDir = dirname(command)
  const pathValue = process.env.PATH ? `${binDir}${delimiter}${process.env.PATH}` : binDir
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_DESKTOP: 'true',
    HERMES_BIN: command,
    HERMES_AGENT_BRIDGE_PYTHON: bundledPython(),
    HERMES_AGENT_CLI_PYTHON: bundledPython(),
    HERMES_AGENT_ROOT: pythonDir(),
    HERMES_HOME: hermesHome(),
    HERMES_WEB_UI_HOME: webUiHome(),
    HERMES_WEBUI_STATE_DIR: webUiHome(),
    PATH: pathValue,
  }

  return await new Promise(resolve => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
      windowsHide: false,
    })
    child.once('error', (err) => {
      console.error(`Failed to run bundled Hermes CLI: ${err.message}`)
      resolve(1)
    })
    child.once('exit', (code, signal) => {
      if (typeof code === 'number') {
        resolve(code)
        return
      }
      console.error(`Bundled Hermes CLI exited from signal ${signal || 'unknown'}`)
      resolve(1)
    })
  })
}
