import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const execFileCalls = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: any }>)

vi.mock('child_process', () => ({
  execFile: vi.fn((command: string, args: string[], options: any, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    execFileCalls.push({ command, args, options })
    callback(null, 'ok\n', '')
  }),
  spawn: vi.fn(),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

afterEach(() => {
  execFileCalls.length = 0
  delete process.env.HERMES_AGENT_BRIDGE_PYTHON
  delete process.env.HERMES_AGENT_CLI_PYTHON
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform)
  vi.resetModules()
})

describe('Hermes process invocation', () => {
  it('bypasses the uv hermes.exe trampoline on Windows packaged installs', async () => {
    setPlatform('win32')
    process.env.HERMES_AGENT_CLI_PYTHON = 'C:\\Users\\me\\AppData\\Local\\Programs\\Hermes Studio\\resources\\python\\pythonw.exe'
    const { execHermesWithBin } = await import('../../packages/server/src/services/hermes/hermes-process')

    const result = await execHermesWithBin(
      'C:\\Users\\me\\AppData\\Local\\Programs\\Hermes Studio\\resources\\python\\Scripts\\hermes.exe',
      ['kanban', '--board', 'default', 'create', 'demo', '--json'],
      { windowsHide: true },
    )

    expect(result.stdout).toBe('ok\n')
    expect(execFileCalls[0]).toMatchObject({
      command: process.env.HERMES_AGENT_CLI_PYTHON,
      args: ['-m', 'hermes_cli.main', 'kanban', '--board', 'default', 'create', 'demo', '--json'],
    })
  })

  it('prefers sibling pythonw.exe for a Windows hermes.exe launcher', async () => {
    setPlatform('win32')
    const root = mkdtempSync(join(tmpdir(), 'hermes-process-'))
    try {
      const scripts = join(root, 'Scripts')
      mkdirSync(scripts)
      writeFileSync(join(root, 'python.exe'), '')
      writeFileSync(join(root, 'pythonw.exe'), '')
      writeFileSync(join(scripts, 'hermes.exe'), '')
      const { execHermesWithBin } = await import('../../packages/server/src/services/hermes/hermes-process')

      await execHermesWithBin(join(scripts, 'hermes.exe'), ['--version'], { windowsHide: true })

      expect(execFileCalls[0]).toMatchObject({
        command: join(root, 'pythonw.exe'),
        args: ['-m', 'hermes_cli.main', '--version'],
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps normal Hermes command execution unchanged on non-Windows platforms', async () => {
    setPlatform('darwin')
    const { execHermesWithBin } = await import('../../packages/server/src/services/hermes/hermes-process')

    await execHermesWithBin('/opt/hermes/bin/hermes', ['--version'], { windowsHide: true })

    expect(execFileCalls[0]).toMatchObject({
      command: '/opt/hermes/bin/hermes',
      args: ['--version'],
    })
  })
})
