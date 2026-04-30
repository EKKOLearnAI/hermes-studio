import { beforeEach, describe, expect, it, vi } from 'vitest'

const readFileSyncMock = vi.fn()
const existsSyncMock = vi.fn()
const writeFileSyncMock = vi.fn()

vi.mock('os', () => ({
  homedir: () => '/tmp/test-home',
}))

vi.mock('fs', () => ({
  readFileSync: readFileSyncMock,
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
}))

describe('hermes-profile helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    readFileSyncMock.mockReset()
    existsSyncMock.mockReset()
    writeFileSyncMock.mockReset()
  })

  it('falls back to default and repairs active_profile when the sticky profile no longer exists', async () => {
    readFileSyncMock.mockReturnValue('cog\n')
    existsSyncMock.mockReturnValue(false)

    const mod = await import('../../packages/server/src/services/hermes/hermes-profile')

    expect(mod.getActiveProfileName()).toBe('default')
    expect(mod.getActiveProfileDir()).toBe('/tmp/test-home/.hermes')
    expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/test-home/.hermes/active_profile', 'default\n', 'utf-8')
  })

  it('keeps a valid sticky profile unchanged', async () => {
    readFileSyncMock.mockReturnValue('wiki\n')
    existsSyncMock.mockImplementation((path: string) => path === '/tmp/test-home/.hermes/profiles/wiki')

    const mod = await import('../../packages/server/src/services/hermes/hermes-profile')

    expect(mod.getActiveProfileName()).toBe('wiki')
    expect(mod.getActiveProfileDir()).toBe('/tmp/test-home/.hermes/profiles/wiki')
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })
})
