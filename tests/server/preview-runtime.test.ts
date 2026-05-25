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

  it('serves a preview shell on nested clean URLs', async () => {
    mocks.getPreviewInstance.mockResolvedValue({
      id: 'preview-1',
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

    expect(ctx.status).toBe(0)
    expect(ctx.type).toBe('html')
    expect(String(ctx.body)).toContain('<base href="/preview/preview-1/">')
    expect(String(ctx.body)).toContain('<title>Preview</title>')
  })

  it('returns a controlled placeholder when the preview is missing', async () => {
    mocks.getPreviewInstance.mockResolvedValue(null)

    const ctx = createContext('/preview/missing/hermes/chat')
    await previewRuntimeMiddleware(ctx, async () => undefined)

    expect(ctx.status).toBe(503)
    expect(ctx.type).toBe('html')
    expect(String(ctx.body)).toContain('Preview missing')
    expect(String(ctx.body)).toContain('Preview is unavailable or still building.')
  })
})
