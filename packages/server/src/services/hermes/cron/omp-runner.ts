/**
 * One-shot omp execution for scheduled jobs.
 *
 * Cron is fire-and-forget, so each run spawns a fresh `omp -p "<prompt>"`
 * (print mode: final assistant text to stdout, then exit) rather than reusing a
 * persistent `--mode rpc` process. This keeps runs isolated and leak-free. omp
 * owns its own provider auth/config (`~/.omp`), so no Hermes profile state is
 * injected here. Script/`no_agent` jobs bypass omp and run the script directly.
 *
 * Binary resolves from `HERMES_OMP_COMMAND` (default `omp`), matching the
 * interactive chat integration in `omp-session-manager.ts`.
 */

import { spawn, type SpawnOptions } from 'child_process'
import { logger } from '../../logger'
import {
  normalizeWindowsCommandPath,
  windowsCmdShimExecution,
  windowsCommandNeedsShell,
} from '../../windows-command'

function envPositiveInt(name: string): number | undefined {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const DEFAULT_OMP_COMMAND = process.env.HERMES_OMP_COMMAND || 'omp'
const DEFAULT_TIMEOUT_MS = envPositiveInt('HERMES_CRON_OMP_TIMEOUT_MS') ?? 10 * 60 * 1000
const STDOUT_MAX_CHARS = 256 * 1024
const STDERR_TAIL_CHARS = 8 * 1024

export interface RunInvocation {
  prompt: string
  model?: string | null
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface ScriptInvocation {
  script: string
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

export interface RunOutcome {
  status: 'success' | 'error'
  output: string
  error?: string
  exitCode: number | null
}

interface SpawnPlan {
  command: string
  args: string[]
  windowsVerbatimArguments: boolean
}

function planSpawn(command: string, args: string[]): SpawnPlan {
  if (process.platform === 'win32' && windowsCommandNeedsShell(command)) {
    const exec = windowsCmdShimExecution(normalizeWindowsCommandPath(command), args)
    return { command: exec.command, args: exec.args, windowsVerbatimArguments: true }
  }
  return { command, args, windowsVerbatimArguments: false }
}

function runProcess(command: string, args: string[], options: SpawnOptions, timeoutMs: number): Promise<RunOutcome> {
  const plan = planSpawn(command, args)
  return new Promise<RunOutcome>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const child = spawn(plan.command, plan.args, {
      ...options,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }, timeoutMs)
    timer.unref?.()

    const finish = (outcome: RunOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < STDOUT_MAX_CHARS) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })

    child.on('error', (err) => {
      finish({ status: 'error', output: stdout, error: err.message, exitCode: null })
    })

    child.on('close', (code) => {
      if (timedOut) {
        finish({ status: 'error', output: stdout, error: `Run timed out after ${timeoutMs}ms`, exitCode: code })
        return
      }
      if (code === 0) {
        finish({ status: 'success', output: stdout, exitCode: code })
        return
      }
      const detail = stderr.trim() || stdout.trim() || `exited with code ${code}`
      finish({ status: 'error', output: stdout, error: detail, exitCode: code })
    })
  })
}

/** Run a prompt through one-shot `omp -p`. */
export function runOmpPrompt(invocation: RunInvocation): Promise<RunOutcome> {
  const args = ['-p', invocation.prompt, '--no-session']
  if (invocation.model) args.push('--model', invocation.model)

  logger.info('[cron] running omp job in %s (model=%s)', invocation.cwd, invocation.model || 'default')
  return runProcess(DEFAULT_OMP_COMMAND, args, {
    cwd: invocation.cwd,
    env: invocation.env ?? process.env,
  }, invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

/** Run a script-only / no-agent job directly via the system shell. */
export function runScript(invocation: ScriptInvocation): Promise<RunOutcome> {
  const isWindows = process.platform === 'win32'
  const command = isWindows ? (process.env.comspec || 'cmd.exe') : '/bin/sh'
  const args = isWindows ? ['/d', '/s', '/c', invocation.script] : ['-c', invocation.script]

  logger.info('[cron] running script job in %s', invocation.cwd)
  return runProcess(command, args, {
    cwd: invocation.cwd,
    env: invocation.env ?? process.env,
  }, invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}
