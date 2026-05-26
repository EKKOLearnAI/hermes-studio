import { beforeEach, describe, expect, it, vi } from 'vitest'

const readYaml = vi.hoisted(() => vi.fn())
const resolvePreviewRepository = vi.hoisted(() => vi.fn())
const listAvailableReleases = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/safe-file-store', () => ({
  safeFileStore: {
    readYaml: (...args: any[]) => readYaml(...args),
  },
}))

vi.mock('../../packages/server/src/services/hermes/preview-repository', () => ({
  resolvePreviewRepository: (...args: any[]) => resolvePreviewRepository(...args),
}))

vi.mock('../../packages/server/src/services/hermes/webui-releases', () => ({
  listAvailableReleases: (...args: any[]) => listAvailableReleases(...args),
}))

import { getBranchPreviewCapabilities } from '../../packages/server/src/services/hermes/dev-mode-branch-builds'

const releaseProvider = {
  provider: 'release' as const,
  available: true,
  configured: true,
  devOnly: false,
  canListTargets: true,
  canBuild: true,
  reason: null,
}

function makeRepository(reason: 'repo_path_missing' | 'not_git_repo' | null, configured = reason === null, available = reason === null) {
  return {
    descriptor: { type: 'local', path: '/tmp/repo' },
    configured,
    available,
    reason,
    repoRoot: available ? '/tmp/repo' : null,
    cachePath: null,
    remoteUrl: null,
  }
}

describe('getBranchPreviewCapabilities', () => {
  beforeEach(() => {
    readYaml.mockReset()
    resolvePreviewRepository.mockReset()
    listAvailableReleases.mockReset()
    readYaml.mockResolvedValue({ dev: { enabled: true } })
    listAvailableReleases.mockResolvedValue(['0.6.2', '0.6.1'])
  })

  it.each([
    {
      title: 'Dev Mode off + missing repo',
      devEnabled: false,
      repository: makeRepository('repo_path_missing', false, false),
      expectedReason: 'disabled',
      branchAvailable: false,
    },
    {
      title: 'Dev Mode on + missing repo',
      devEnabled: true,
      repository: makeRepository('repo_path_missing', false, false),
      expectedReason: 'repo_path_missing',
      branchAvailable: false,
    },
    {
      title: 'Dev Mode on + invalid repo',
      devEnabled: true,
      repository: makeRepository('not_git_repo', false, false),
      expectedReason: 'not_git_repo',
      branchAvailable: false,
    },
    {
      title: 'Dev Mode on + valid repo',
      devEnabled: true,
      repository: makeRepository(null, true, true),
      expectedReason: null,
      branchAvailable: true,
    },
  ])('$title returns release preview independently of repository errors', async ({ devEnabled, repository, expectedReason, branchAvailable }) => {
    readYaml.mockResolvedValue({ dev: { enabled: devEnabled } })
    resolvePreviewRepository.mockResolvedValue(repository)

    const capabilities = await getBranchPreviewCapabilities('profile-a', true)

    expect(capabilities.providers).toEqual([
      releaseProvider,
      {
        provider: 'branch',
        available: branchAvailable,
        configured: branchAvailable,
        devOnly: true,
        canListTargets: branchAvailable,
        canBuild: branchAvailable,
        reason: expectedReason,
      },
      {
        provider: 'commit',
        available: branchAvailable,
        configured: branchAvailable,
        devOnly: true,
        canListTargets: branchAvailable,
        canBuild: branchAvailable,
        reason: expectedReason,
      },
    ])
    expect(capabilities.branchPreviewAvailable).toBe(branchAvailable)
    expect(capabilities.branchPreviewConfigured).toBe(branchAvailable)
    expect(capabilities.canListBranches).toBe(branchAvailable)
    expect(capabilities.canBuild).toBe(branchAvailable)
    expect(capabilities.reason).toBe(expectedReason)
    expect(capabilities.providers?.[0]).toEqual(releaseProvider)
  })

  it('disables release builds when no releases are available', async () => {
    readYaml.mockResolvedValue({ dev: { enabled: true } })
    resolvePreviewRepository.mockResolvedValue(makeRepository('repo_path_missing', false, false))
    listAvailableReleases.mockResolvedValue([])

    const capabilities = await getBranchPreviewCapabilities('profile-a', true)

    expect(capabilities.providers?.[0]).toEqual({
      ...releaseProvider,
      available: false,
      configured: false,
      canBuild: false,
    })
  })
})
