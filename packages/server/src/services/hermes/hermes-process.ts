import { execFile, spawn } from 'child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { basename, delimiter, dirname, join, resolve } from 'path'

export interface HermesInvocation {
  command: string
  argsPrefix: string[]
}

export interface HermesExecResult {
  stdout: string
  stderr: string
}

/**
 * Well-known launcher locations, tried in order when the bare name is not
 * resolvable on PATH. Studio shells out to the CLI for kanban, sessions,
 * profiles and more, and a Docker install keeps `hermes` inside a venv that is
 * not on the service PATH — without this every one of those calls would fail
 * with a bare ENOENT that reads like a missing install.
 */
function launcherCandidates(env: NodeJS.ProcessEnv, name: string): string[] {
  const installDir = env.HERMES_INSTALL_DIR?.trim()
  const home = env.HOME?.trim()
  return [
    installDir ? join(installDir, '.venv', 'bin', name) : '',
    // Docker image layout.
    join('/opt', 'hermes', '.venv', 'bin', name),
    // Managed install created by the hermes installer.
    home ? join(home, '.hermes', 'hermes-agent', 'venv', 'bin', name) : '',
    home ? join(home, '.local', 'bin', name) : '',
  ].filter(Boolean)
}

/**
 * Resolve the launcher to hand to execFile/spawn. Exported for testing; callers
 * should use `resolveHermesBin`, which caches the disk probing.
 */
export function findHermesLauncher(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  isWindows: boolean = process.platform === 'win32',
): string {
  const explicit = env.HERMES_BIN?.trim()
  if (explicit) return explicit

  const name = isWindows ? 'hermes.exe' : 'hermes'
  // Prefer PATH resolution when it works, so an operator's chosen install wins
  // over the well-known locations below.
  for (const dir of String(env.PATH || '').split(delimiter)) {
    if (dir && exists(join(dir, name))) return name
  }

  for (const candidate of launcherCandidates(env, name)) {
    if (exists(candidate)) return candidate
  }
  // Nothing found — return the bare name so the failure names the command.
  return name
}

let cachedLauncher: string | null = null

export function resolveHermesBin(customBin?: string): string {
  const explicit = customBin?.trim()
  if (explicit) return explicit
  if (cachedLauncher === null) cachedLauncher = findHermesLauncher()
  return cachedLauncher
}

function bundledCliPythonForWindows(hermesBin: string): string | null {
  const envPython = process.env.HERMES_AGENT_CLI_PYTHON?.trim()
  if (envPython) return envPython

  const launcher = basename(hermesBin).toLowerCase()
  if (launcher !== 'hermes.exe' && launcher !== 'hermes.cmd') return null
  const python = resolve(dirname(hermesBin), '..', 'python.exe')
  return existsSync(python) ? python : null
}

function withWindowsHide<T extends ExecFileOptions | SpawnOptions>(options?: T): T {
  if (process.platform !== 'win32') return (options || {}) as T
  return { windowsHide: true, ...(options || {}) } as T
}

export function resolveHermesInvocation(hermesBin = resolveHermesBin()): HermesInvocation {
  if (process.platform === 'win32') {
    const python = bundledCliPythonForWindows(hermesBin)
    if (python) return { command: python, argsPrefix: ['-m', 'hermes_cli.main'] }
  }

  return { command: hermesBin, argsPrefix: [] }
}

export function execHermesWithBin(
  hermesBin: string,
  args: readonly string[],
  options?: ExecFileOptions,
): Promise<HermesExecResult> {
  const invocation = resolveHermesInvocation(hermesBin)
  return new Promise((resolveExec, rejectExec) => {
    execFile(
      invocation.command,
      [...invocation.argsPrefix, ...args],
      { ...withWindowsHide(options), encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          rejectExec(Object.assign(error, { stdout, stderr }))
          return
        }
        resolveExec({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      },
    )
  })
}

export function execHermes(args: readonly string[], options?: ExecFileOptions) {
  return execHermesWithBin(resolveHermesBin(), args, options)
}

export function spawnHermesWithBin(
  hermesBin: string,
  args: readonly string[],
  options?: SpawnOptions,
): ChildProcess {
  const invocation = resolveHermesInvocation(hermesBin)
  return spawn(invocation.command, [...invocation.argsPrefix, ...args], withWindowsHide(options))
}

export function spawnHermes(args: readonly string[], options?: SpawnOptions): ChildProcess {
  return spawnHermesWithBin(resolveHermesBin(), args, options)
}
