import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readRootPackage() {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
    name: string
    version: string
  }
}

async function loadHealthControllerWithoutInjectedVersion() {
  vi.resetModules()
  delete (globalThis as any).__APP_VERSION__

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithInjectedVersion(version: string) {
  vi.resetModules()
  ;(globalThis as any).__APP_VERSION__ = version

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithInjectedBuildMetadata(metadata: Record<string, string>) {
  vi.resetModules()
  ;(globalThis as any).__WEBUI_BUILD_METADATA__ = JSON.stringify(metadata)

  vi.doMock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    getVersion: vi.fn().mockResolvedValue('Hermes Agent v0.11.0\n'),
  }))

  return import('../../packages/server/src/controllers/health')
}

async function loadHealthControllerWithMissingBuildMetadata() {
  vi.resetModules()
  delete (globalThis as any).__WEBUI_BUILD_METADATA__

  vi.doMock('child_process', () => ({
    execSync: vi.fn(() => { throw new Error('git unavailable') }),
  }))

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
    ;(globalThis as any).__APP_VERSION__ = 'test'
    delete (globalThis as any).__WEBUI_BUILD_METADATA__
    vi.unmock('child_process')
  })

  it('reads the root package version in ts-node/dev mode instead of falling back to 0.0.0', async () => {
    const pkg = readRootPackage()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithoutInjectedVersion()
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe(pkg.version)
    expect(ctx.body.webui_version).not.toBe('0.0.0')
  })

  it('uses the injected build version when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedVersion('9.9.9-test')
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_version).toBe('9.9.9-test')
  })

  it('uses injected build metadata when available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedBuildMetadata({
      commit: 'abc123def456',
      branch: 'upstream-pr/adr-009-singleton-updates-preview',
      source: 'https://github.com/kira-project-lab/hermes-web-ui.git',
      built_at: '2026-05-26T21:43:00.000Z',
    })
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_build_commit).toBe('abc123def456')
    expect(ctx.body.webui_build_branch).toBe('upstream-pr/adr-009-singleton-updates-preview')
    expect(ctx.body.webui_build_source).toBe('https://github.com/kira-project-lab/hermes-web-ui.git')
    expect(ctx.body.webui_built_at).toBe('2026-05-26T21:43:00.000Z')
  })

  it('redacts credentials from injected build source URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithInjectedBuildMetadata({
      commit: 'abc123def456',
      branch: 'main',
      source: 'https://token:secret@github.com/kira-project-lab/hermes-web-ui.git',
      built_at: '2026-05-26T21:43:00.000Z',
    })
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_build_source).toBe('https://github.com/kira-project-lab/hermes-web-ui.git')
    expect(ctx.body.webui_build_source).not.toContain('secret')
    expect(ctx.body.webui_build_source).not.toContain('token')
  })

  it('falls back to unknown build metadata when no build info is available', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))

    const { healthCheck } = await loadHealthControllerWithMissingBuildMetadata()
    const ctx = createMockCtx()

    await healthCheck(ctx)

    expect(ctx.body.webui_build_commit).toBe('unknown')
    expect(ctx.body.webui_build_branch).toBe('unknown')
    expect(ctx.body.webui_build_source).toBe('unknown')
    expect(ctx.body.webui_built_at).toBe('unknown')
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
