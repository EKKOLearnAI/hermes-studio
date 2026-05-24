import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { execSync } from 'child_process'

function readRootPackage() {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    name: string
    version: string
  }
}

function readRootGitInfo() {
  return {
    sha: execSync('git rev-parse --short=12 HEAD', { cwd: process.cwd(), encoding: 'utf-8' }).trim(),
    branch: execSync('git branch --show-current', { cwd: process.cwd(), encoding: 'utf-8' }).trim(),
  }
}

async function loadHealthControllerWithoutInjectedVersion() {
  vi.resetModules()
  delete (globalThis as any).__APP_VERSION__
  delete (globalThis as any).__APP_GIT_SHA__
  delete (globalThis as any).__APP_GIT_BRANCH__

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithInjectedVersion(version: string, sha = 'abc123def456', branch = 'upstream/main') {
  vi.resetModules()
  ;(globalThis as any).__APP_VERSION__ = version
  ;(globalThis as any).__APP_GIT_SHA__ = sha
  ;(globalThis as any).__APP_GIT_BRANCH__ = branch

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
}

function createMockCtx() {
  return {
    body: null as any,
  }
}

describe('health controller version metadata', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    delete (globalThis as any).__APP_VERSION__
    delete (globalThis as any).__APP_GIT_SHA__
    delete (globalThis as any).__APP_GIT_BRANCH__
  })

  it('reads the root package version and git metadata in ts-node/dev mode instead of falling back to defaults', async () => {
    const pkg = readRootPackage()
    const git = readRootGitInfo()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe(pkg.version)
    expect(ctx.body.webui_version).not.toBe('0.0.0')
    expect(ctx.body.webui_git_sha).toBe(git.sha)
    expect(ctx.body.webui_git_branch).toBe(git.branch)
  })

  it('uses the injected build version and git metadata when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedVersion('9.9.9-test', 'feedbeef1234', 'upstream/main')
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe('9.9.9-test')
    expect(ctx.body.webui_git_sha).toBe('feedbeef1234')
    expect(ctx.body.webui_git_branch).toBe('upstream/main')
  })

  it('checks npm latest using the root package name', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const pkg = readRootPackage()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '99.99.99' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithoutInjectedVersion()

    await checkLatestVersion()

    expect(fetchMock).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${pkg.name}/latest`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('99.99.99')
    expect(ctx.body.webui_update_available).toBe(true)
  })

  it('does not throw when latest-version lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { checkLatestVersion } = await loadHealthControllerWithoutInjectedVersion()

    await expect(checkLatestVersion()).resolves.toBeUndefined()
  })
})
