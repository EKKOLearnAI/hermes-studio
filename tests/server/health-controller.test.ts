import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const UPDATE_PACKAGE = '@quanthermes/hermes-web-ui'
const UPDATE_REGISTRY = 'https://registry.npmjs.org'
const UPDATE_SOURCE_LABEL = 'Company npm registry'

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

function createMockCtx() {
  return {
    body: null as any,
  }
}

describe('health controller version metadata', () => {
  const originalUpdateEnabled = process.env.WEBUI_UPDATE_ENABLED
  const originalUpdatePackage = process.env.WEBUI_UPDATE_PACKAGE
  const originalUpdateRegistry = process.env.WEBUI_UPDATE_REGISTRY
  const originalUpdateCliBin = process.env.WEBUI_UPDATE_CLI_BIN
  const originalUpdateSourceLabel = process.env.WEBUI_UPDATE_SOURCE_LABEL

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = 'test'
    if (originalUpdateEnabled === undefined) delete process.env.WEBUI_UPDATE_ENABLED
    else process.env.WEBUI_UPDATE_ENABLED = originalUpdateEnabled
    if (originalUpdatePackage === undefined) delete process.env.WEBUI_UPDATE_PACKAGE
    else process.env.WEBUI_UPDATE_PACKAGE = originalUpdatePackage
    if (originalUpdateRegistry === undefined) delete process.env.WEBUI_UPDATE_REGISTRY
    else process.env.WEBUI_UPDATE_REGISTRY = originalUpdateRegistry
    if (originalUpdateCliBin === undefined) delete process.env.WEBUI_UPDATE_CLI_BIN
    else process.env.WEBUI_UPDATE_CLI_BIN = originalUpdateCliBin
    if (originalUpdateSourceLabel === undefined) delete process.env.WEBUI_UPDATE_SOURCE_LABEL
    else process.env.WEBUI_UPDATE_SOURCE_LABEL = originalUpdateSourceLabel
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

  it('checks npm latest using the configured package name', async () => {
    process.env.WEBUI_UPDATE_ENABLED = 'true'
    process.env.WEBUI_UPDATE_PACKAGE = UPDATE_PACKAGE
    process.env.WEBUI_UPDATE_REGISTRY = UPDATE_REGISTRY
    process.env.WEBUI_UPDATE_CLI_BIN = 'hermes-web-ui.mjs'
    process.env.WEBUI_UPDATE_SOURCE_LABEL = UPDATE_SOURCE_LABEL
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ version: '99.99.99' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const { checkLatestVersion, healthCheck } = await loadHealthControllerWithInjectedVersion('0.6.10-test')

    await checkLatestVersion()

    expect(fetchMock).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${encodeURIComponent(UPDATE_PACKAGE)}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )

    const ctx = createMockCtx()
    await healthCheck(ctx)

    expect(ctx.body.webui_latest).toBe('99.99.99')
    expect(ctx.body.webui_update_enabled).toBe(true)
    expect(ctx.body.webui_update_available).toBe(true)
    expect(ctx.body.webui_update_source_label).toBe(UPDATE_SOURCE_LABEL)
  })

  it('does not throw when latest-version lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const { checkLatestVersion } = await loadHealthControllerWithoutInjectedVersion()

    await expect(checkLatestVersion()).resolves.toBeUndefined()
  })
})
