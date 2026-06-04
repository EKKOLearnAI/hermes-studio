import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { scryptSync, timingSafeEqual } from 'crypto'
import { DatabaseSync } from 'node:sqlite'

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

function verifyPassword(password: string, passwordHash: string): boolean {
  const [scheme, salt, expectedHex] = passwordHash.split(':')
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false
  const expected = Buffer.from(expectedHex, 'hex')
  const actual = scryptSync(password, salt, expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

describe('CLI port detection', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
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

  it('clears the login lock file from the configured Web UI home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-cli-locks-'))
    process.env.HERMES_WEB_UI_HOME = home
    const lockFile = join(home, '.login-lock.json')
    writeFileSync(lockFile, '{"passwordIpMap":{}}\n')

    try {
      const { clearLoginLocks } = await loadCli()
      const result = clearLoginLocks({ silent: true, checkRunning: false })

      expect(result).toEqual({ path: lockFile, removed: true, serverRunning: false })
      expect(existsSync(lockFile)).toBe(false)

      const second = clearLoginLocks({ silent: true, checkRunning: false })
      expect(second).toEqual({ path: lockFile, removed: false, serverRunning: false })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('cleans a stale server PID file during stop', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-cli-stale-pid-'))
    process.env.HERMES_WEB_UI_HOME = home
    const pidFile = join(home, 'server.pid')
    writeFileSync(pidFile, '999999999\n')

    try {
      const { stopDaemon } = await loadCli()
      stopDaemon()

      expect(existsSync(pidFile)).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('keeps restart grace short while allowing stop to wait for bridge cleanup', async () => {
    const { getDaemonStopGraceMs } = await loadCli()

    expect(getDaemonStopGraceMs({ restart: true })).toBe(5_000)
    expect(getDaemonStopGraceMs()).toBe(15_000)
  })

  it('allows CLI stop and restart grace periods to be overridden separately', async () => {
    process.env.HERMES_WEB_UI_RESTART_GRACE_MS = '2500'
    process.env.HERMES_WEB_UI_STOP_GRACE_MS = '9000'
    const { getDaemonStopGraceMs } = await loadCli()

    expect(getDaemonStopGraceMs({ restart: true })).toBe(2_500)
    expect(getDaemonStopGraceMs()).toBe(9_000)
  })

  it('resets an existing admin user to the default password', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-web-ui-cli-default-login-'))
    process.env.HERMES_WEB_UI_HOME = home
    const dbPath = join(home, 'hermes-web-ui.db')

    try {
      const { resetDefaultLogin } = await loadCli()
      const created = await resetDefaultLogin({ silent: true })
      expect(created.action).toBe('created')

      const db = new DatabaseSync(dbPath)
      try {
        const initial = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get('admin') as any
        expect(verifyPassword('123456', initial.password_hash)).toBe(true)
        db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run('scrypt:bad:bad', 'admin')
      } finally {
        db.close()
      }

      const updated = await resetDefaultLogin({ silent: true })
      expect(updated.action).toBe('updated')

      const verifyDb = new DatabaseSync(dbPath)
      try {
        const rows = verifyDb.prepare('SELECT id, username, password_hash, role, status FROM users WHERE username = ?').all('admin') as any[]
        expect(rows).toHaveLength(1)
        expect(verifyPassword('123456', rows[0].password_hash)).toBe(true)
        expect(rows[0].role).toBe('super_admin')
        expect(rows[0].status).toBe('active')
      } finally {
        verifyDb.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
