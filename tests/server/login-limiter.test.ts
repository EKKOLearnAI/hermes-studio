import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

async function loadLimiter() {
  vi.resetModules()
  vi.doMock('fs/promises', () => ({
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
  }))
  vi.doMock('fs', () => ({ writeFileSync: vi.fn() }))
  vi.doMock('../../packages/server/src/config', () => ({
    config: { appHome: '/tmp/hermes-web-ui-test' },
  }))
  return import('../../packages/server/src/services/login-limiter')
}

describe('login limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-24T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('fs/promises')
    vi.doUnmock('fs')
    vi.doUnmock('../../packages/server/src/config')
    vi.resetModules()
  })

  it('locks password login on the tenth failed attempt from the same IP', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.10'

    for (let i = 0; i < 9; i++) {
      expect(limiter.checkPassword(ip)).toEqual({ allowed: true })
      limiter.recordPasswordFailure(ip)
    }

    expect(limiter.checkPassword(ip)).toEqual({ allowed: true })
    limiter.recordPasswordFailure(ip)

    expect(limiter.checkPassword(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.getLockedIps()).toEqual([
      expect.objectContaining({ ip, type: 'password', failures: 10 }),
    ])
  })

  it('locks token auth on the tenth failed attempt from the same IP', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.20'

    for (let i = 0; i < 9; i++) {
      expect(limiter.checkToken(ip)).toEqual({ allowed: true })
      limiter.recordTokenFailure(ip)
    }

    expect(limiter.checkToken(ip)).toEqual({ allowed: true })
    limiter.recordTokenFailure(ip)

    expect(limiter.checkToken(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.getLockedIps()).toEqual([
      expect.objectContaining({ ip, type: 'token', failures: 10 }),
    ])
  })

  it('locks pairing attempts and clears stale failure records after the window', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.30'

    limiter.recordPairingFailure(ip)
    expect(limiter.checkPairing(ip)).toEqual({ allowed: true })

    vi.advanceTimersByTime(16 * 60_000)

    expect(limiter.checkPairing(ip)).toEqual({ allowed: true })
    expect(limiter.getLockedIps()).toEqual([])
  })

  it('locks pairing attempts on the tenth failed attempt from the same IP', async () => {
    const limiter = await loadLimiter()
    const ip = '192.0.2.40'

    for (let i = 0; i < 9; i++) {
      expect(limiter.checkPairing(ip)).toEqual({ allowed: true })
      limiter.recordPairingFailure(ip)
    }

    expect(limiter.checkPairing(ip)).toEqual({ allowed: true })
    limiter.recordPairingFailure(ip)

    expect(limiter.checkPairing(ip)).toEqual({ allowed: false, status: 429 })
    expect(limiter.getLockedIps()).toEqual([
      expect.objectContaining({ ip, type: 'pairing', failures: 10 }),
    ])
  })
})
