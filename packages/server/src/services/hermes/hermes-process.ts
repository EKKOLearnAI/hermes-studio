import { execFile, spawn } from 'child_process'
import type { ChildProcess, ExecFileOptions, SpawnOptions } from 'child_process'
import { existsSync } from 'fs'
import { basename, dirname, resolve } from 'path'

export interface HermesInvocation {
  command: string
  argsPrefix: string[]
}

export interface HermesExecResult {
  stdout: string
  stderr: string
}

export function resolveHermesBin(customBin?: string): string {
  return customBin?.trim() || process.env.HERMES_BIN?.trim() || 'hermes'
}

function bundledPythonForWindows(hermesBin: string): string | null {
  const envPython = process.env.HERMES_AGENT_BRIDGE_PYTHON?.trim()
  if (envPython) return envPython

  if (basename(hermesBin).toLowerCase() !== 'hermes.exe') return null
  const python = resolve(dirname(hermesBin), '..', 'python.exe')
  return existsSync(python) ? python : null
}

export function resolveHermesInvocation(hermesBin = resolveHermesBin()): HermesInvocation {
  if (process.platform === 'win32') {
    const python = bundledPythonForWindows(hermesBin)
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
      { ...options, encoding: 'utf8' },
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
  return spawn(invocation.command, [...invocation.argsPrefix, ...args], options || {})
}

export function spawnHermes(args: readonly string[], options?: SpawnOptions): ChildProcess {
  return spawnHermesWithBin(resolveHermesBin(), args, options)
}
