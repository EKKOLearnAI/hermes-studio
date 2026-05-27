import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  profileRoot: '',
}))

const readYaml = vi.hoisted(() => vi.fn())
const writeText = vi.hoisted(() => vi.fn(async (filePath: string, text: string) => {
  await writeFile(filePath, text)
}))
const removePreviewInstance = vi.hoisted(() => vi.fn())
const updatePreviewInstance = vi.hoisted(() => vi.fn())
const startPreviewInstanceWithId = vi.hoisted(() => vi.fn())
const listAvailableReleases = vi.hoisted(() => vi.fn())
const getLatestAvailableRelease = vi.hoisted(() => vi.fn())
const prepareReleasePreviewPackage = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getProfileDir: (profile: string) => join(env.profileRoot, profile),
}))

vi.mock('../../packages/server/src/services/safe-file-store', () => ({
  safeFileStore: {
    readYaml: (...args: any[]) => Reflect.apply(readYaml as any, null, args),
    writeText: (...args: any[]) => Reflect.apply(writeText as any, null, args),
  },
}))

vi.mock('../../packages/server/src/services/hermes/preview-registry', () => ({
  PREVIEW_SLOT_ID: 'preview-slot',
  removePreviewInstance: (...args: any[]) => (removePreviewInstance as any)(...args),
  updatePreviewInstance: (...args: any[]) => (updatePreviewInstance as any)(...args),
  startPreviewInstanceWithId: (...args: any[]) => (startPreviewInstanceWithId as any)(...args),
}))

vi.mock('../../packages/server/src/services/hermes/webui-releases', () => ({
  listAvailableReleases: (...args: any[]) => (listAvailableReleases as any)(...args),
  getLatestAvailableRelease: (...args: any[]) => (getLatestAvailableRelease as any)(...args),
  prepareReleasePreviewPackage: (...args: any[]) => (prepareReleasePreviewPackage as any)(...args),
}))

import {
  __resetDevModeStateForTest,
  promotePreviewTarget,
  removePreviewTarget,
  restoreLatestUpstreamRelease,
} from '../../packages/server/src/services/hermes/dev-mode-branch-builds'

function statePath(profile: string) {
  return join(env.profileRoot, profile, '.dev-mode-branch-builds.json')
}

async function prepareProfile(profile: string, state: Record<string, any>) {
  await mkdir(join(env.profileRoot, profile), { recursive: true })
  await writeFile(statePath(profile), `${JSON.stringify(state, null, 2)}\n`)
}

describe('dev-mode branch build state transitions', () => {
  beforeEach(async () => {
    env.profileRoot = await mkdtemp(join(tmpdir(), 'hermes-dev-builds-'))
    readYaml.mockReset()
    writeText.mockReset()
    removePreviewInstance.mockReset()
    updatePreviewInstance.mockReset()
    startPreviewInstanceWithId.mockReset()
    listAvailableReleases.mockReset()
    getLatestAvailableRelease.mockReset()
    prepareReleasePreviewPackage.mockReset()
    listAvailableReleases.mockResolvedValue(['0.6.2', '0.6.1'])
    getLatestAvailableRelease.mockResolvedValue('0.6.2')
    prepareReleasePreviewPackage.mockImplementation(async (_profile: string, version: string, targetPath?: string) => {
      const packagePath = targetPath || join(env.profileRoot, 'release-cache', version, 'package')
      await mkdir(join(packagePath, 'dist', 'client'), { recursive: true })
      await writeFile(join(packagePath, 'dist', 'client', 'index.html'), '<html></html>')
      return packagePath
    })
    readYaml.mockResolvedValue({
      dev: {
        enabled: true,
        review_base: 'main',
      },
    })
  })

  it('removes the active preview without changing the review base', async () => {
    const profile = 'profile-a'
    await prepareProfile(profile, {
      profile,
      reviewBase: 'main',
      previewId: 'preview-slot',
      previewBranch: 'feature/a',
      previewReleaseVersion: null,
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'feature/a',
      buildReleaseVersion: null,
      status: 'success',
      startedAt: 1,
      finishedAt: 2,
      exitCode: 0,
      signal: null,
      error: null,
      logTail: ['before'],
      updatedAt: 2,
    })

    const summary = await removePreviewTarget(profile)

    expect(removePreviewInstance).toHaveBeenCalledWith(profile, 'preview-slot')
    expect(summary).toMatchObject({
      status: 'idle',
      previewId: null,
      previewBranch: null,
      previewWorktreePath: null,
      buildBranch: null,
      reviewBase: 'main',
    })

    const state = JSON.parse(await (await import('fs/promises')).readFile(statePath(profile), 'utf-8'))
    expect(state).toMatchObject({
      reviewBase: 'main',
      previewId: null,
      previewBranch: null,
      buildBranch: null,
      status: 'idle',
    })
  })

  it('promotes the current preview branch as the new review base', async () => {
    const profile = 'profile-a'
    await prepareProfile(profile, {
      profile,
      reviewBase: 'main',
      previewId: 'preview-slot',
      previewBranch: 'feature/b',
      previewReleaseVersion: null,
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'feature/b',
      buildReleaseVersion: null,
      status: 'success',
      startedAt: 10,
      finishedAt: 20,
      exitCode: 0,
      signal: null,
      error: null,
      logTail: ['before'],
      updatedAt: 20,
    })

    const summary = await promotePreviewTarget(profile)

    expect(summary).toMatchObject({
      reviewBase: 'feature/b',
      previewId: null,
      previewBranch: null,
      previewWorktreePath: null,
      buildBranch: null,
      status: 'idle',
    })
    expect(removePreviewInstance).toHaveBeenCalledWith(profile, 'preview-slot')

    const state = JSON.parse(await (await import('fs/promises')).readFile(statePath(profile), 'utf-8'))
    expect(state.reviewBase).toBe('feature/b')
    expect(state.previewId).toBeNull()
    expect(state.previewBranch).toBeNull()
  })

  it('builds the latest upstream release as a servable preview', async () => {
    const profile = 'profile-a'
    await prepareProfile(profile, {
      profile,
      reviewBase: 'feature/b',
      previewId: 'preview-slot',
      previewBranch: 'feature/b',
      previewReleaseVersion: null,
      previewWorktreePath: '/tmp/worktree',
      buildBranch: 'feature/b',
      buildReleaseVersion: null,
      status: 'success',
      startedAt: 10,
      finishedAt: 20,
      exitCode: 0,
      signal: null,
      error: null,
      logTail: ['before'],
      updatedAt: 20,
    })

    const summary = await restoreLatestUpstreamRelease(profile)

    expect(removePreviewInstance).toHaveBeenCalledWith(profile, 'preview-slot')
    expect(summary).toMatchObject({
      reviewBase: 'main',
      previewId: 'preview-slot',
      previewBranch: null,
      previewReleaseVersion: '0.6.2',
      buildBranch: null,
      buildReleaseVersion: '0.6.2',
      status: 'success',
    })
    expect(startPreviewInstanceWithId).toHaveBeenCalledWith(profile, {
      type: 'release-artifact',
      version: '0.6.2',
      source: 'github-release',
      artifactPath: null,
    }, 'preview-slot')
    expect(updatePreviewInstance).toHaveBeenCalledWith(profile, 'preview-slot', expect.objectContaining({
      status: 'success',
      target: expect.objectContaining({
        type: 'release-artifact',
        version: '0.6.2',
        artifactPath: expect.stringContaining('.preview-slot'),
      }),
    }))

    const state = JSON.parse(await (await import('fs/promises')).readFile(statePath(profile), 'utf-8'))
    expect(state).toMatchObject({
      reviewBase: 'main',
      previewId: 'preview-slot',
      previewBranch: null,
      previewReleaseVersion: '0.6.2',
      buildBranch: null,
      buildReleaseVersion: '0.6.2',
      status: 'success',
    })
  })
})
