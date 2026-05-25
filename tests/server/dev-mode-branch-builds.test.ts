import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ctrl from '../../packages/server/src/controllers/hermes/dev-mode-branch-builds'

const isDevModeEnabled = vi.fn()
const listRepositoryBranches = vi.fn()
const startBranchBuild = vi.fn()
const resetPreviewTarget = vi.fn()
const getBranchBuildSummary = vi.fn()
const getBranchPreviewCapabilities = vi.fn()
const getActiveProfileName = vi.fn()

vi.mock('../../packages/server/src/services/hermes/dev-mode-branch-builds', () => ({
  isDevModeEnabled: (...args: any[]) => isDevModeEnabled(...args),
  listRepositoryBranches: (...args: any[]) => listRepositoryBranches(...args),
  startBranchBuild: (...args: any[]) => startBranchBuild(...args),
  resetPreviewTarget: (...args: any[]) => resetPreviewTarget(...args),
  getBranchBuildSummary: (...args: any[]) => getBranchBuildSummary(...args),
  getBranchPreviewCapabilities: (...args: any[]) => getBranchPreviewCapabilities(...args),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: (...args: any[]) => getActiveProfileName(...args),
}))

const disabledSummary = {
  status: 'idle',
  previewId: null,
  previewUrl: null,
  previewBranch: 'main',
  previewWorktreePath: null,
  buildBranch: null,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  signal: null,
  error: null,
  reviewBase: 'main',
  logTail: [],
}

const enabledSummary = {
  ...disabledSummary,
  previewId: 'preview-1',
  previewUrl: '/preview/preview-1/',
  previewBranch: 'feature/a',
  buildBranch: 'feature/a',
}

function makeCtx(state: any = {}) {
  return {
    state,
    request: { body: {} },
    status: 0,
    body: undefined as any,
  }
}

beforeEach(() => {
  isDevModeEnabled.mockReset()
  listRepositoryBranches.mockReset()
  startBranchBuild.mockReset()
  resetPreviewTarget.mockReset()
  getBranchBuildSummary.mockReset()
  getBranchPreviewCapabilities.mockReset()
  getActiveProfileName.mockReset()
  getActiveProfileName.mockReturnValue('default')
})

describe('dev-mode branch build controller', () => {
  it('returns explicit branch preview capabilities', async () => {
    const capabilities = {
      isSuperAdmin: true,
      devModeAvailable: true,
      branchPreviewAvailable: true,
      branchPreviewConfigured: true,
      canListBranches: true,
      canBuild: false,
      reason: null,
    }
    getBranchPreviewCapabilities.mockResolvedValue(capabilities)
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.getCapabilities(ctx)

    expect(getBranchPreviewCapabilities).toHaveBeenCalledWith('profile-a', true)
    expect(ctx.status).toBe(0)
    expect(ctx.body).toEqual(capabilities)
  })

  it('lists branches even when dev mode is disabled', async () => {
    listRepositoryBranches.mockResolvedValue(['feature/a', 'feature/b'])
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.listBranches(ctx)

    expect(isDevModeEnabled).not.toHaveBeenCalled()
    expect(listRepositoryBranches).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe(0)
    expect(ctx.body).toEqual({ branches: ['feature/a', 'feature/b'] })
  })

  it('returns a disabled status summary instead of rejecting status reads', async () => {
    getBranchBuildSummary.mockResolvedValue(disabledSummary)
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.getStatus(ctx)

    expect(getBranchBuildSummary).toHaveBeenCalledWith('profile-a')
    expect(ctx.status).toBe(0)
    expect(ctx.body).toEqual(disabledSummary)
  })

  it('validates branch input before building', async () => {
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.buildBranch(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Missing branch' })
    expect(startBranchBuild).not.toHaveBeenCalled()
  })

  it('rejects build requests when dev mode is disabled', async () => {
    isDevModeEnabled.mockResolvedValue(false)
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    ctx.request.body = { branch: 'feature/a' }

    await ctrl.buildBranch(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Dev Mode is disabled' })
    expect(startBranchBuild).not.toHaveBeenCalled()
  })

  it('builds the requested branch and returns a flattened status summary', async () => {
    isDevModeEnabled.mockResolvedValue(true)
    startBranchBuild.mockResolvedValue({ state: { status: 'success' }, worktreePath: '/tmp/worktree' })
    getBranchBuildSummary.mockResolvedValue(enabledSummary)
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    ctx.request.body = { branch: '  feature/a  ' }

    await ctrl.buildBranch(ctx)

    expect(startBranchBuild).toHaveBeenCalledWith('profile-a', 'feature/a')
    expect(getBranchBuildSummary).toHaveBeenCalledWith('profile-a')
    expect(ctx.body).toEqual({ ...enabledSummary, worktreePath: '/tmp/worktree' })
  })

  it('rejects reset requests when dev mode is disabled', async () => {
    isDevModeEnabled.mockResolvedValue(false)
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.resetBranchPreview(ctx)

    expect(ctx.status).toBe(403)
    expect(ctx.body).toEqual({ error: 'Dev Mode is disabled' })
    expect(resetPreviewTarget).not.toHaveBeenCalled()
  })

  it('resets the preview target when enabled', async () => {
    isDevModeEnabled.mockResolvedValue(true)
    resetPreviewTarget.mockResolvedValue(enabledSummary)
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.resetBranchPreview(ctx)

    expect(resetPreviewTarget).toHaveBeenCalledWith('profile-a')
    expect(ctx.body).toEqual(enabledSummary)
  })
})
