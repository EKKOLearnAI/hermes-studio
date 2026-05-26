import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

let configYaml: any = {}

vi.mock('../../packages/server/src/services/safe-file-store', () => ({
  safeFileStore: {
    readYaml: vi.fn(async () => configYaml),
  },
}))

import {
  listPreviewRepositoryBranches,
  resolvePreviewRepository,
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
          path: join(repoDir, 'missing'),
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

  it('treats a git-url descriptor as configured without needing a clone', async () => {
    configYaml = {
      dev: {
        preview_repository: {
          type: 'git-url',
          url: 'https://example.com/acme/repo.git',
        },
      },
    }

    const resolution = await resolvePreviewRepository('profile-a', { fetchRemote: false })

    expect(resolution.configured).toBe(true)
    expect(resolution.available).toBe(true)
    expect(resolution.reason).toBeNull()
    expect(resolution.cachePath).toContain('.preview-repositories')
  })
})
