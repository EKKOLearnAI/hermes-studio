import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as ctrl from '../../packages/server/src/controllers/hermes/dev-mode-branch-builds'

const isDevModeEnabled = vi.fn()
const listRepositoryBranches = vi.fn()
const startBranchBuild = vi.fn()
const resetPreviewTarget = vi.fn()
const removePreviewTarget = vi.fn()
const promotePreviewTarget = vi.fn()
const restoreLatestUpstreamRelease = vi.fn()
const getBranchBuildSummary = vi.fn()
const getBranchPreviewCapabilities = vi.fn()
const getAvailableReleases = vi.fn()
const getActiveProfileName = vi.fn()

vi.mock('../../packages/server/src/services/hermes/dev-mode-branch-builds', () => ({
  isDevModeEnabled: (...args: any[]) => isDevModeEnabled(...args),
  listRepositoryBranches: (...args: any[]) => listRepositoryBranches(...args),
  startBranchBuild: (...args: any[]) => startBranchBuild(...args),
  resetPreviewTarget: (...args: any[]) => resetPreviewTarget(...args),
  removePreviewTarget: (...args: any[]) => removePreviewTarget(...args),
  promotePreviewTarget: (...args: any[]) => promotePreviewTarget(...args),
  restoreLatestUpstreamRelease: (...args: any[]) => restoreLatestUpstreamRelease(...args),
  getBranchBuildSummary: (...args: any[]) => getBranchBuildSummary(...args),
  getBranchPreviewCapabilities: (...args: any[]) => getBranchPreviewCapabilities(...args),
  getAvailableReleases: (...args: any[]) => getAvailableReleases(...args),
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
  previewId: 'preview-slot',
  previewUrl: '/preview/',
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
  removePreviewTarget.mockReset()
  promotePreviewTarget.mockReset()
  restoreLatestUpstreamRelease.mockReset()
  getBranchBuildSummary.mockReset()
  getBranchPreviewCapabilities.mockReset()
  getAvailableReleases.mockReset()
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
      providers: [
        {
          provider: 'release',
          available: true,
          configured: true,
          devOnly: false,
          canListTargets: true,
          canBuild: true,
          reason: null,
        },
        {
          provider: 'branch',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: false,
          reason: null,
        },
        {
          provider: 'commit',
          available: true,
          configured: true,
          devOnly: true,
          canListTargets: true,
          canBuild: false,
          reason: null,
        },
      ],
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

  it('lists releases even when dev mode is disabled', async () => {
    getAvailableReleases.mockResolvedValue(['1.2.3', '1.2.2'])
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.listReleases(ctx)

    expect(getAvailableReleases).toHaveBeenCalledTimes(1)
    expect(ctx.status).toBe(0)
    expect(ctx.body).toEqual({ releases: ['1.2.3', '1.2.2'] })
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

  it('removes the preview target when requested', async () => {
    isDevModeEnabled.mockResolvedValue(true)
    removePreviewTarget.mockResolvedValue({
      ...disabledSummary,
      status: 'idle',
      previewId: null,
      previewBranch: null,
      reviewBase: 'main',
    })
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.removeBranchPreview(ctx)

    expect(removePreviewTarget).toHaveBeenCalledWith('profile-a')
    expect(ctx.body).toEqual({
      ...disabledSummary,
      status: 'idle',
      previewId: null,
      previewBranch: null,
      reviewBase: 'main',
    })
  })

  it('promotes the current preview when enabled', async () => {
    isDevModeEnabled.mockResolvedValue(true)
    promotePreviewTarget.mockResolvedValue({
      ...enabledSummary,
      reviewBase: 'feature/a',
    })
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })

    await ctrl.promoteBranchPreview(ctx)

    expect(promotePreviewTarget).toHaveBeenCalledWith('profile-a')
    expect(ctx.body).toEqual({
      ...enabledSummary,
      reviewBase: 'feature/a',
    })
  })

  it('builds the selected upstream release without requiring Dev Mode', async () => {
    isDevModeEnabled.mockResolvedValue(false)
    restoreLatestUpstreamRelease.mockResolvedValue({
      ...enabledSummary,
      status: 'success',
      previewId: 'preview-slot',
      previewBranch: null,
      buildBranch: null,
      previewReleaseVersion: '1.2.3',
      buildReleaseVersion: '1.2.3',
      reviewBase: 'main',
    })
    const ctx = makeCtx({ profile: { name: 'profile-a' }, user: { role: 'super_admin' } })
    ctx.request.body = { version: '1.2.3' }

    await ctrl.restoreLatestRelease(ctx)

    expect(isDevModeEnabled).not.toHaveBeenCalled()
    expect(restoreLatestUpstreamRelease).toHaveBeenCalledWith('profile-a', '1.2.3')
    expect(ctx.body).toEqual({
      ...enabledSummary,
      status: 'success',
      previewId: 'preview-slot',
      previewBranch: null,
      buildBranch: null,
      previewReleaseVersion: '1.2.3',
      buildReleaseVersion: '1.2.3',
      reviewBase: 'main',
    })
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
