import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeReadFileMock = vi.hoisted(() => vi.fn())
const safeStatMock = vi.hoisted(() => vi.fn())
const mkdirMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock,
  writeFile: writeFileMock,
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  safeReadFile: safeReadFileMock,
  safeStat: safeStatMock,
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'default',
  getProfileDir: (profile: string) => `/profiles/${profile}`,
}))

describe('memory controller', () => {
  beforeEach(() => {
    vi.resetModules()
    safeReadFileMock.mockReset().mockResolvedValue('')
    safeStatMock.mockReset().mockResolvedValue(null)
    mkdirMock.mockReset().mockResolvedValue(undefined)
    writeFileMock.mockReset().mockResolvedValue(undefined)
  })

  it('isolates authenticated users within a shared profile', async () => {
    const { get, save } = await import('../../packages/server/src/controllers/hermes/memory')

    await get({ state: { user: { id: 1 } } } as any)
    await get({ state: { user: { id: 2 } } } as any)
    await save({
      state: { user: { id: 1 } },
      request: { body: { section: 'memory', content: 'alice private memory' } },
    } as any)

    expect(safeReadFileMock).toHaveBeenCalledWith('/profiles/default/webui-users/1/memories/MEMORY.md')
    expect(safeReadFileMock).toHaveBeenCalledWith('/profiles/default/webui-users/2/memories/MEMORY.md')
    expect(mkdirMock).toHaveBeenCalledWith('/profiles/default/webui-users/1/memories', { recursive: true })
    expect(writeFileMock).toHaveBeenCalledWith(
      '/profiles/default/webui-users/1/memories/MEMORY.md',
      'alice private memory',
      'utf-8',
    )
  })
})
