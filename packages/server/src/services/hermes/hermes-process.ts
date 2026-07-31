import { execFile, spawn } from 'child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'child_process'
import { constants, accessSync, existsSync } from 'fs'
import { homedir } from 'os'
import { basename, delimiter, dirname, join, resolve } from 'path'

export interface HermesInvocation {
  command: string
  argsPrefix: string[]
}

export interface HermesExecResult {
  stdout: string
  stderr: string
}

// Where the Hermes CLI installs itself when it is not on PATH.
const CLI_FALLBACK_PATHS = [
  ['.local', 'bin', 'hermes'],
  ['.hermes', 'node', 'bin', 'hermes'],
  ['.local', 'share', 'hermes', 'bin', 'hermes'],
]

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function onSearchPath(name: string): boolean {
  const search = process.env.PATH
  if (!search) return false
  return search
    .split(delimiter)
    .filter(Boolean)
    .some(dir => isExecutable(join(dir, name)))
}

function installedCliPath(): string | null {
  const home = homedir()
  const candidates = [
    ...CLI_FALLBACK_PATHS.map(parts => join(home, ...parts)),
    '/usr/local/bin/hermes',
    '/opt/homebrew/bin/hermes',
  ]
  return candidates.find(isExecutable) ?? null
}

let cachedBin: string | null = null

export function resolveHermesBin(customBin?: string): string {
  const explicit = customBin?.trim() || process.env.HERMES_BIN?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32') return 'hermes'
  if (cachedBin) return cachedBin

  // A `systemd --user` service inherits a minimal PATH that usually leaves out
  // ~/.local/bin, which is exactly where the CLI installs itself. Falling back
  // to the known install locations keeps every hermes call — logs, gateway,
  // profiles — working after a reboot, instead of failing with ENOENT on a
  // machine where `hermes` is plainly installed.
  cachedBin = onSearchPath('hermes') ? 'hermes' : installedCliPath() ?? 'hermes'
  return cachedBin
}

/** Test seam: the resolved path is cached for the life of the process. */
export function resetHermesBinCache(): void {
  cachedBin = null
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
