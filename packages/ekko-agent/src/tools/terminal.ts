import { spawn } from 'node:child_process'
import type { AgentTool, AgentToolContext, AgentToolResult } from './types'
import { resolveToolPath } from './path-safety'

export interface TerminalExecInput extends Record<string, unknown> {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
}

export class TerminalExecTool implements AgentTool<TerminalExecInput> {
  readonly definition = {
    name: 'terminal_exec',
    description: 'Run a terminal command. Prefer command as the executable and args as the argument array; shell string execution is not used.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable command to run. Prefer a bare executable such as "node", "ls", or "/bin/sh".' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
        cwd: { type: 'string', description: 'Working directory relative to the workspace.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }

  async execute(input: TerminalExecInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const normalized = normalizeTerminalCommand(input.command, input.args)
    const args = normalized.args
    const cwd = input.cwd ? resolveToolPath(input.cwd, context) : context.cwd || context.workspaceRoot || process.cwd()
    const timeoutMs = input.timeoutMs ?? context.timeoutMs ?? 30_000
    if (context.signal?.aborted) {
      return {
        ok: false,
        content: 'Command aborted.',
        error: 'Command aborted.',
        data: { command: normalized.command, args, cwd, originalCommand: input.command, aborted: true },
      }
    }

    return new Promise<AgentToolResult>((resolve) => {
      const child = spawn(normalized.command, args, {
        cwd,
        shell: false,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let aborted = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)
      const onAbort = () => {
        aborted = true
        child.kill('SIGTERM')
      }
      context.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      child.on('error', error => {
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', onAbort)
        resolve({
          ok: false,
          content: error.message,
          error: error.message,
          data: { command: normalized.command, args, cwd, originalCommand: input.command },
        })
      })
      child.on('close', code => {
        clearTimeout(timer)
        context.signal?.removeEventListener('abort', onAbort)
        const content = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
        resolve({
          ok: code === 0 && !timedOut && !aborted,
          content: content || (aborted ? 'Command aborted.' : content),
          error: aborted ? 'Command aborted.' : timedOut ? `Command timed out after ${timeoutMs}ms` : code === 0 ? undefined : `Command exited with code ${code}`,
          data: {
            command: normalized.command,
            args,
            cwd,
            originalCommand: input.command,
            exitCode: code,
            stdout,
            stderr,
            timedOut,
            aborted,
          },
        })
      })
    })
  }
}

export function createTerminalTools(): AgentTool[] {
  return [new TerminalExecTool()]
}

function normalizeTerminalCommand(command: string, args?: string[]): { command: string; args: string[] } {
  const normalizedArgs = Array.isArray(args) ? args.map(String) : []
  if (normalizedArgs.length > 0 || !/\s/.test(command.trim())) {
    return { command, args: normalizedArgs }
  }

  const parts = splitCommandLine(command)
  if (parts.length <= 1) return { command, args: normalizedArgs }
  return {
    command: parts[0],
    args: parts.slice(1),
  }
}

function splitCommandLine(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command.trim()) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaped) current += '\\'
  if (current) parts.push(current)
  return parts
}
