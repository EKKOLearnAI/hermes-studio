import { arch, hostname, platform, release, type } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadSystemInfoWithInjectedVersion(version?: string) {
  vi.resetModules()
  if (version === undefined) {
    delete (globalThis as any).__APP_VERSION__
  } else {
    ;(globalThis as any).__APP_VERSION__ = version
  }

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.15.2\n'),
  }))

  return import('../../packages/server/src/services/system-info')
}

describe('public system info', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = 'test'
  })

  it('returns host, os, Hermes Agent, and Web UI versions', async () => {
    const { getPublicSystemInfo } = await loadSystemInfoWithInjectedVersion('9.9.9-test')

    await expect(getPublicSystemInfo()).resolves.toEqual({
      computer_name: hostname(),
      os: {
        type: type(),
        platform: platform(),
        release: release(),
        arch: arch(),
      },
      hermes_agent_version: 'v0.15.2',
      hermes_web_ui_version: '9.9.9-test',
    })
  })
})
