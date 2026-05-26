import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

let configYaml: any = {}
const updateYamlMock = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/safe-file-store', () => ({
  safeFileStore: {
    readYaml: vi.fn(async () => configYaml),
    updateYaml: updateYamlMock,
  },
}))

import {
  listPreviewRepositoryBranches,
  resolvePreviewRepository,
  savePreviewRepository,
} from '../../packages/server/src/services/hermes/preview-repository'

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-preview-repo-'))
  execFileSync('git', ['init', dir], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' })
  writeFileSync(join(dir, 'README.md'), '# preview repo\n')
  execFileSync('git', ['-C', dir, 'add', 'README.md'], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'commit', '-m', 'initial'], { stdio: 'ignore' })
  execFileSync('git', ['-C', dir, 'branch', 'feature/alpha'], { stdio: 'ignore' })
  return dir
}

describe('preview repository resolution', () => {
  let repoDir: string | null = null

  beforeEach(() => {
    configYaml = {}
    updateYamlMock.mockReset()
    updateYamlMock.mockImplementation(async (_path: string, updater: (current: Record<string, any>) => Record<string, any>) => {
      configYaml = updater(configYaml)
    })
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true })
    }
    repoDir = makeGitRepo()
  })

  it('resolves a local checkout and reports it as configured', async () => {
    configYaml = {
      dev: {
        preview_repository: {
          type: 'local',
          path: repoDir,
        },
      },
    }

    const resolution = await resolvePreviewRepository('profile-a', { fetchRemote: false })

    expect(resolution.configured).toBe(true)
    expect(resolution.available).toBe(true)
    expect(resolution.reason).toBeNull()
    expect(resolution.repoRoot).toBe(repoDir)
  })

  it('marks a missing local path as unavailable', async () => {
    configYaml = {
      dev: {
        preview_repository: {
          type: 'local',
          path: join(repoDir as string, 'missing'),
        },
      },
    }

    const resolution = await resolvePreviewRepository('profile-a', { fetchRemote: false })

    expect(resolution.configured).toBe(false)
    expect(resolution.available).toBe(false)
    expect(resolution.reason).toBe('repo_path_missing')
    expect(resolution.repoRoot).toBeNull()
  })

  it('lists branches from a local checkout', async () => {
    configYaml = {
      dev: {
        preview_repository: {
          type: 'local',
          path: repoDir,
        },
      },
    }

    const branches = await listPreviewRepositoryBranches('profile-a')

    expect(branches).toContain('feature/alpha')
    expect(branches.some((branch) => branch.includes('HEAD'))).toBe(false)
  })

  it('does not persist an invalid repository when validation fails', async () => {
    await expect(savePreviewRepository('profile-a', {
      type: 'local',
      path: join(repoDir as string, 'missing'),
    }, { validate: true })).rejects.toThrow('Preview repository path is missing')

    expect(updateYamlMock).not.toHaveBeenCalled()
    expect(configYaml.dev?.preview_repository).toBeUndefined()
  })

  it('persists a valid repository after validation', async () => {
    const result = await savePreviewRepository('profile-a', {
      type: 'local',
      path: repoDir as string,
    }, { validate: true })

    expect(result.resolution.available).toBe(true)
    expect(updateYamlMock).toHaveBeenCalledTimes(1)
    expect(configYaml.dev.preview_repository).toEqual({
      type: 'local',
      path: repoDir,
    })
  })
})
