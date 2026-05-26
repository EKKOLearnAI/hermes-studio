import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __resetPreviewRegistryForTest,
  getPreviewInstance,
  listPreviewInstances,
  startPreviewInstance,
  startPreviewInstanceWithId,
  updatePreviewInstance,
  stopPreviewInstance,
} from '../../packages/server/src/services/hermes/preview-registry'

let hermesHome = ''
let profile = ''

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'preview-registry-'))
  process.env.HERMES_HOME = hermesHome
  profile = 'preview-profile'
  mkdirSync(join(hermesHome, 'profiles', profile), { recursive: true })
})

afterEach(() => {
  delete process.env.HERMES_HOME
  if (hermesHome) {
    rmSync(hermesHome, { recursive: true, force: true })
  }
})

describe('preview registry service', () => {
  it('tracks preview lifecycle transitions in the registry', async () => {
    await __resetPreviewRegistryForTest(profile)

    const target = {
      type: 'installed-version',
      version: '2026.05.25',
    } as const

    const started = await startPreviewInstance(profile, target)
    expect(started.status).toBe('running')
    expect(started.target).toEqual(target)
    expect(started.startedAt).not.toBeNull()
    expect(started.finishedAt).toBeNull()

    const listed = await listPreviewInstances(profile)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(started)

    const fetched = await getPreviewInstance(profile, started.id)
    expect(fetched).toEqual(started)

    const stopped = await stopPreviewInstance(profile, started.id, 'manual QA complete')
    expect(stopped.status).toBe('stopped')
    expect(stopped.finishedAt).not.toBeNull()
    expect(stopped.exitCode).toBe(0)
    expect(stopped.error).toBeNull()
    expect(stopped.logTail.at(-1)).toContain('manual QA complete')

    const afterStop = await getPreviewInstance(profile, started.id)
    expect(afterStop?.status).toBe('stopped')
    expect(afterStop?.finishedAt).toBe(stopped.finishedAt)
  })

  it('upserts a git-branch preview instance by id', async () => {
    await __resetPreviewRegistryForTest(profile)

    const previewId = 'preview-branch-1'
    const worktreePath = '/tmp/branch-preview-worktree'
    const target = {
      type: 'git-branch',
      repo: '/repo/hermes-web-ui',
      branch: 'feature/preview-instance',
      provider: 'git-branch-worktree',
      devOnly: true,
      worktreePath,
    } as const

    const started = await startPreviewInstanceWithId(profile, target, previewId)
    expect(started.id).toBe(previewId)
    expect(started.status).toBe('running')

    const updated = await updatePreviewInstance(profile, previewId, {
      target,
      status: 'success',
      startedAt: started.startedAt,
      finishedAt: started.startedAt ? started.startedAt + 123 : Date.now(),
      exitCode: 0,
      signal: null,
      error: null,
      logTail: [...started.logTail, 'Preview build complete'],
    })

    expect(updated.id).toBe(previewId)
    expect(updated.status).toBe('success')
    expect(updated.target).toEqual(target)
    expect(updated.logTail.at(-1)).toBe('Preview build complete')

    const listed = await listPreviewInstances(profile)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(updated)
  })

  it('rejects invalid preview targets with a structured error', async () => {
    await expect(startPreviewInstance(profile, { type: 'installed-version' })).rejects.toMatchObject({
      status: 400,
      code: 'preview_invalid_target',
    })
  })

  it('returns a structured not-found error for unknown instances', async () => {
    await expect(stopPreviewInstance(profile, 'missing-preview-id')).rejects.toMatchObject({
      status: 404,
      code: 'preview_not_found',
    })
  })
})
