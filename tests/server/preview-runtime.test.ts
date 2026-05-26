import { mkdtemp, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPreviewInstance: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: () => 'profile-a',
}))

vi.mock('../../packages/server/src/services/hermes/preview-registry', () => ({
  PREVIEW_SLOT_ID: 'preview-slot',
  getPreviewInstance: mocks.getPreviewInstance,
}))

import { previewRuntimeMiddleware } from '../../packages/server/src/routes/hermes/preview-runtime'

function createContext(path: string, method = 'GET') {
  return {
    path,
    method,
    status: 0,
    type: '',
    body: undefined,
    redirectedTo: null as string | null,
    redirect(target: string) {
      this.redirectedTo = target
      this.status = 302
    },
  } as any
}

describe('previewRuntimeMiddleware', () => {
  let worktreePath: string

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'preview-runtime-'))
    await mkdir(join(worktreePath, 'dist', 'client'), { recursive: true })
    await writeFile(join(worktreePath, 'dist', 'client', 'index.html'), '<html><head><title>Preview</title></head><body></body></html>')
    mocks.getPreviewInstance.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('serves a preview shell on singleton preview URLs', async () => {
    mocks.getPreviewInstance.mockResolvedValue({
      id: 'preview-slot',
      status: 'success',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      logTail: [],
      updatedAt: Date.now(),
      target: {
        type: 'git-branch',
        repo: 'repo',
        branch: 'feature',
        provider: 'git-branch-worktree',
        devOnly: true,
        worktreePath,
      },
    })

    const ctx = createContext('/preview/hermes/chat')
    await previewRuntimeMiddleware(ctx, async () => undefined)

    expect(ctx.status).toBe(0)
    expect(ctx.type).toBe('html')
    expect(String(ctx.body)).toContain('<base href="/preview/">')
    expect(String(ctx.body)).toContain('<title>Preview</title>')
  })

  it('serves a release artifact preview shell on singleton preview URLs', async () => {
    mocks.getPreviewInstance.mockResolvedValue({
      id: 'preview-slot',
      status: 'success',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      logTail: [],
      updatedAt: Date.now(),
      target: {
        type: 'release-artifact',
        version: '0.6.2',
        source: 'github-release',
        artifactPath: worktreePath,
      },
    })

    const ctx = createContext('/preview/hermes/chat')
    await previewRuntimeMiddleware(ctx, async () => undefined)

    expect(ctx.status).toBe(0)
    expect(ctx.type).toBe('html')
    expect(String(ctx.body)).toContain('<base href="/preview/">')
    expect(String(ctx.body)).toContain('<title>Preview</title>')
  })

  it('redirects legacy singleton preview URLs to the canonical slot', async () => {
    mocks.getPreviewInstance.mockResolvedValue({
      id: 'preview-slot',
      status: 'success',
      startedAt: Date.now(),
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      logTail: [],
      updatedAt: Date.now(),
      target: {
        type: 'git-branch',
        repo: 'repo',
        branch: 'feature',
        provider: 'git-branch-worktree',
        devOnly: true,
        worktreePath,
      },
    })

    const ctx = createContext('/preview/preview-1/hermes/chat')
    await previewRuntimeMiddleware(ctx, async () => undefined)

    expect(ctx.redirectedTo).toBe('/preview/hermes/chat')
    expect(ctx.status).toBe(302)
  })

  it('returns a controlled placeholder when the preview is missing', async () => {
    mocks.getPreviewInstance.mockResolvedValue(null)

    const ctx = createContext('/preview/hermes/chat')
    await previewRuntimeMiddleware(ctx, async () => undefined)

    expect(ctx.status).toBe(503)
    expect(ctx.type).toBe('html')
    expect(String(ctx.body)).toContain('Preview')
    expect(String(ctx.body)).toContain('Preview is unavailable or still building.')
  })
})
