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
    description: 'Run a terminal command with an argument array. Shell string execution is not used.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable command to run.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command arguments.' },
        cwd: { type: 'string', description: 'Working directory relative to the workspace.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }

  async execute(input: TerminalExecInput, context: AgentToolContext = {}): Promise<AgentToolResult> {
    const args = Array.isArray(input.args) ? input.args.map(String) : []
    const cwd = input.cwd ? resolveToolPath(input.cwd, context) : context.cwd || context.workspaceRoot || process.cwd()
    const timeoutMs = input.timeoutMs ?? context.timeoutMs ?? 30_000

    return new Promise<AgentToolResult>((resolve) => {
      const child = spawn(input.command, args, {
        cwd,
        shell: false,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, timeoutMs)

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', chunk => { stdout += chunk })
      child.stderr?.on('data', chunk => { stderr += chunk })
      child.on('error', error => {
        clearTimeout(timer)
        resolve({
          ok: false,
          content: error.message,
          error: error.message,
          data: { command: input.command, args, cwd },
        })
      })
      child.on('close', code => {
        clearTimeout(timer)
        const content = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
        resolve({
          ok: code === 0 && !timedOut,
          content,
          error: timedOut ? `Command timed out after ${timeoutMs}ms` : code === 0 ? undefined : `Command exited with code ${code}`,
          data: {
            command: input.command,
            args,
            cwd,
            exitCode: code,
            stdout,
            stderr,
            timedOut,
          },
        })
      })
    })
  }
}

export function createTerminalTools(): AgentTool[] {
  return [new TerminalExecTool()]
}
