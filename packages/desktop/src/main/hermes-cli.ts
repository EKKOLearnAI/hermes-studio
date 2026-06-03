import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import {
  bundledBrowserExecutable,
  bundledGit,
  bundledNode,
  bundledPython,
  gitPathDirs,
  hermesBin,
  hermesHome,
  nodeBinDir,
  pythonDir,
  webUiHome,
} from './paths'
import { HERMES_CLI_ARG } from './cli-constants'
import { ensureDesktopRuntime } from './runtime-manager'
import { resolveDesktopHermesCliInvocation } from './hermes-cli-invocation'

export function parseHermesCliArgs(argv: string[] = process.argv): string[] | null {
  const index = argv.indexOf(HERMES_CLI_ARG)
  if (index < 0) return null
  return argv.slice(index + 1)
}

export async function runBundledHermesCli(args: string[]): Promise<number> {
  try {
    await ensureDesktopRuntime()
  } catch (err) {
    console.error(`Failed to prepare Hermes runtime: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  const hermesCommand = hermesBin()
  const pythonCommand = bundledPython()
  const invocation = resolveDesktopHermesCliInvocation(process.platform, hermesCommand, pythonCommand)
  if (!existsSync(hermesCommand)) {
    console.error(`hermes binary missing at ${hermesCommand}`)
    console.error('Run: npm run prepare:runtime (to build a local Hermes runtime)')
    return 127
  }
  if (!existsSync(invocation.command)) {
    console.error(`Hermes CLI runtime missing at ${invocation.command}`)
    console.error('Run: npm run prepare:runtime (to build a local Hermes runtime)')
    return 127
  }

  mkdirSync(webUiHome(), { recursive: true })
  mkdirSync(hermesHome(), { recursive: true })

  const binDir = dirname(hermesCommand)
  const bundledNodeBin = nodeBinDir()
  const bundledAgentBrowserBin = process.platform === 'win32'
    ? join(pythonDir(), 'node')
    : join(pythonDir(), 'node', 'bin')
  const inheritedPath = process.env.PATH || process.env.Path || ''
  const pathValue = [
    binDir,
    bundledAgentBrowserBin,
    bundledNodeBin,
    gitPathDirs().join(delimiter),
    inheritedPath,
  ].filter(Boolean).join(delimiter)
  const gitBin = bundledGit()
  const browserExecutable = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim() || bundledBrowserExecutable()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_DESKTOP: 'true',
    HERMES_BIN: hermesCommand,
    HERMES_AGENT_BRIDGE_PYTHON: pythonCommand,
    HERMES_AGENT_CLI_PYTHON: pythonCommand,
    HERMES_AGENT_ROOT: pythonDir(),
    HERMES_AGENT_NODE: bundledNode(),
    HERMES_AGENT_NODE_ROOT: process.platform === 'win32' ? bundledNodeBin : dirname(bundledNodeBin),
    AGENT_BROWSER_HOME: process.env.AGENT_BROWSER_HOME?.trim() || join(hermesHome(), 'agent-browser'),
    ...(browserExecutable ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutable } : {}),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || join(pythonDir(), 'ms-playwright'),
    ...(gitBin ? { HERMES_AGENT_GIT: gitBin } : {}),
    HERMES_HOME: hermesHome(),
    HERMES_WEB_UI_HOME: webUiHome(),
    HERMES_WEBUI_STATE_DIR: webUiHome(),
    PATH: pathValue,
  }

  return await new Promise(resolve => {
    const child = spawn(invocation.command, [...invocation.argsPrefix, ...args], {
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
