import { mkdir, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  deleteProfile: vi.fn(),
  renameProfile: vi.fn(),
  destroyProfile: vi.fn(),
  prepareGatewayForProfileDelete: vi.fn(),
  renameMappings: vi.fn(),
  removeMappings: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  deleteProfile: mocks.deleteProfile,
  renameProfile: mocks.renameProfile,
}))
vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn(() => ({ destroyProfile: mocks.destroyProfile })),
}))
vi.mock('../../packages/server/src/services/hermes/gateway-autostart', () => ({
  prepareGatewayForProfileDelete: mocks.prepareGatewayForProfileDelete,
  getGatewayRuntimeStatusForProfile: vi.fn(),
  restartGatewayForProfile: vi.fn(),
}))
vi.mock('../../packages/server/src/services/hermes/personal-twin/assistant-roles', () => ({
  renameAssistantRoleProfileMappings: mocks.renameMappings,
  removeAssistantRoleProfileMappings: mocks.removeMappings,
}))
vi.mock('../../packages/server/src/services/logger', () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}))

describe('Profile controller assistant role mapping lifecycle', () => {
  const originalHermesHome = process.env.HERMES_HOME
  let hermesHome = ''

  beforeEach(async () => {
    vi.clearAllMocks()
    hermesHome = await mkdtemp(join(tmpdir(), 'profiles-controller-mappings-'))
    process.env.HERMES_HOME = hermesHome
    mocks.destroyProfile.mockResolvedValue({ destroyed: 0 })
    mocks.prepareGatewayForProfileDelete.mockResolvedValue(undefined)
  })

  afterEach(async () => {
    if (originalHermesHome === undefined) delete process.env.HERMES_HOME
    else process.env.HERMES_HOME = originalHermesHome
    await rm(hermesHome, { recursive: true, force: true })
  })

  it('renames mappings only after the Profile rename succeeds', async () => {
    mocks.renameProfile.mockResolvedValue(true)
    const { rename } = await import('../../packages/server/src/controllers/hermes/profiles')
    const ctx: any = { params: { name: 'OldCase' }, request: { body: { new_name: 'NewCase' } }, status: 200 }

    await rename(ctx)

    expect(mocks.renameProfile).toHaveBeenCalledWith('OldCase', 'NewCase')
    expect(mocks.renameMappings).toHaveBeenCalledWith('OldCase', 'NewCase')
    expect(mocks.renameProfile.mock.invocationCallOrder[0]).toBeLessThan(mocks.renameMappings.mock.invocationCallOrder[0])
    expect(ctx.body).toEqual({ success: true })
  })

  it('does not touch mappings when the Profile rename fails', async () => {
    mocks.renameProfile.mockResolvedValue(false)
    const { rename } = await import('../../packages/server/src/controllers/hermes/profiles')
    const ctx: any = { params: { name: 'Old' }, request: { body: { new_name: 'New' } }, status: 200 }

    await rename(ctx)

    expect(mocks.renameMappings).not.toHaveBeenCalled()
    expect(ctx.status).toBe(500)
  })

  it('keeps a successful rename successful when mapping cleanup fails and logs no error details', async () => {
    mocks.renameProfile.mockResolvedValue(true)
    mocks.renameMappings.mockImplementation(() => { throw new Error('D:\\secret\\twin.db') })
    const { rename } = await import('../../packages/server/src/controllers/hermes/profiles')
    const ctx: any = { params: { name: 'Old' }, request: { body: { new_name: 'New' } }, status: 200 }

    await rename(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mocks.warn).toHaveBeenCalledWith('[profiles] failed to rename assistant role mappings')
  })

  it('removes mappings only after Profile deletion succeeds', async () => {
    const profileDir = join(hermesHome, 'profiles', 'Work')
    await mkdir(profileDir, { recursive: true })
    mocks.deleteProfile.mockImplementation(async () => {
      await rm(profileDir, { recursive: true, force: true })
      return true
    })
    const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
    const ctx: any = { params: { name: 'Work' }, status: 200 }

    await remove(ctx)

    expect(mocks.removeMappings).toHaveBeenCalledWith('Work')
    expect(mocks.deleteProfile.mock.invocationCallOrder[0]).toBeLessThan(mocks.removeMappings.mock.invocationCallOrder[0])
    expect(ctx.body).toEqual({ success: true })
  })

  it('does not remove mappings when Profile deletion fails', async () => {
    await mkdir(join(hermesHome, 'profiles', 'Work'), { recursive: true })
    mocks.deleteProfile.mockResolvedValue(false)
    const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
    const ctx: any = { params: { name: 'Work' }, status: 200 }

    await remove(ctx)

    expect(mocks.removeMappings).not.toHaveBeenCalled()
    expect(ctx.status).toBe(500)
  })

  it('keeps a successful deletion successful when mapping cleanup fails', async () => {
    const profileDir = join(hermesHome, 'profiles', 'Work')
    await mkdir(profileDir, { recursive: true })
    mocks.deleteProfile.mockImplementation(async () => {
      await rm(profileDir, { recursive: true, force: true })
      return true
    })
    mocks.removeMappings.mockImplementation(() => { throw new Error('D:\\secret\\twin.db') })
    const { remove } = await import('../../packages/server/src/controllers/hermes/profiles')
    const ctx: any = { params: { name: 'Work' }, status: 200 }

    await remove(ctx)

    expect(ctx.body).toEqual({ success: true })
    expect(mocks.warn).toHaveBeenCalledWith('[profiles] failed to remove assistant role mappings')
  })
})
