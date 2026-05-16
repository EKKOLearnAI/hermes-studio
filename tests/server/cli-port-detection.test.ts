import { afterEach, describe, expect, it, vi } from 'vitest'

type ChildProcessMocks = {
  execFileSync: ReturnType<typeof vi.fn>
  execSync: ReturnType<typeof vi.fn>
  spawn: ReturnType<typeof vi.fn>
}

async function loadCli(overrides: Partial<ChildProcessMocks> = {}) {
  const execFileSync = overrides.execFileSync ?? vi.fn()
  const execSync = overrides.execSync ?? vi.fn()
  const spawn = overrides.spawn ?? vi.fn()

  vi.resetModules()
  vi.doMock('child_process', () => ({ execFileSync, execSync, spawn }))

  const mod = await import('../../bin/hermes-web-ui.mjs')
  return {
    ...mod,
    mocks: { execFileSync, execSync, spawn },
  }
}

describe('CLI port detection', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  afterEach(() => {
    vi.doUnmock('child_process')
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('falls back to lsof without executing ss when ss is unavailable', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === 'sh' && args.at(-1) === 'ss') {
        throw new Error('not found')
      }
      if (command === 'sh' && args.at(-1) === 'lsof') {
        return ''
      }
      if (command === 'lsof') {
        return '1234\n1234\n'
      }
      throw new Error(`unexpected command: ${command}`)
    })
    const { getListeningPids, mocks } = await loadCli({ execFileSync })

    expect(getListeningPids(8648)).toEqual([1234])
    expect(mocks.execFileSync).not.toHaveBeenCalledWith(
      'ss',
      expect.any(Array),
      expect.any(Object),
    )
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'lsof',
      ['-tiTCP:8648', '-sTCP:LISTEN'],
      expect.objectContaining({ encoding: 'utf-8' }),
    )
  })

  it('uses ss first when available', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })

    const execFileSync = vi.fn((command: string, args: string[]) => {
      if (command === 'sh' && args.at(-1) === 'ss') {
        return ''
      }
      if (command === 'ss') {
        return 'LISTEN 0 511 0.0.0.0:8648 0.0.0.0:* users:(("node",pid=4321,fd=20))\n'
      }
      throw new Error(`unexpected command: ${command}`)
    })
    const { getListeningPids } = await loadCli({ execFileSync })

    expect(getListeningPids(8648)).toEqual([4321])
  })

  it('parses Linux netstat listener output as a final fallback', async () => {
    const { parseUnixNetstatListeningPids } = await loadCli()

    expect(parseUnixNetstatListeningPids(
      [
        'tcp        0      0 0.0.0.0:8648            0.0.0.0:*               LISTEN      2468/node',
        'tcp        0      0 0.0.0.0:5173            0.0.0.0:*               LISTEN      1357/node',
      ].join('\n'),
      8648,
    )).toEqual([2468])
  })
})
