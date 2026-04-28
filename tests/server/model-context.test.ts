import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let homeDir = ''

function hermesPath(...parts: string[]) {
  return join(homeDir, '.hermes', ...parts)
}

function writeConfig(content: string) {
  mkdirSync(hermesPath(), { recursive: true })
  writeFileSync(hermesPath('config.yaml'), content)
}

function writeModelsCache(data: Record<string, unknown>) {
  mkdirSync(hermesPath(), { recursive: true })
  writeFileSync(hermesPath('models_dev_cache.json'), JSON.stringify(data))
}

async function loadModelContext() {
  vi.resetModules()
  vi.doMock('os', async () => ({
    ...(await vi.importActual<typeof import('os')>('os')),
    homedir: () => homeDir,
  }))
  return import('../../packages/server/src/services/hermes/model-context')
}

describe('getModelContextLength', () => {
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'hwui-model-context-'))
  })

  afterEach(() => {
    vi.doUnmock('os')
    if (homeDir) rmSync(homeDir, { recursive: true, force: true })
    homeDir = ''
  })

  it('does not borrow a same-named model context from another provider when the configured provider is uncached', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai-codex\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(200_000)
  })

  it('does not scan other providers when the configured provider exists without that model', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai-codex\n`)
    writeModelsCache({
      'openai-codex': {
        models: {
          'gpt-5.4': { limit: { context: 200_000 } },
        },
      },
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(200_000)
  })

  it('uses the configured provider cache entry when the provider matches', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n  provider: openai\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_050_000)
  })

  it('keeps legacy model-name cache lookup when no provider is configured', async () => {
    writeConfig(`model:\n  default: gpt-5.5\n`)
    writeModelsCache({
      openai: {
        models: {
          'gpt-5.5': { limit: { context: 1_050_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_050_000)
  })

  it('keeps providerless legacy lookup on global exact matches before prefixed suffix matches', async () => {
    writeConfig(`model:\n  default: gpt-5\n`)
    writeModelsCache({
      vercel: {
        models: {
          'openai/gpt-5': { limit: { context: 1_000_000 } },
        },
      },
      openai: {
        models: {
          'gpt-5': { limit: { context: 400_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(400_000)
  })

  it('maps WUI provider keys to model-cache provider keys before looking up limits', async () => {
    writeConfig(`model:\n  default: gemini-3.1-pro-preview\n  provider: gemini\n`)
    writeModelsCache({
      google: {
        models: {
          'gemini-3.1-pro-preview': { limit: { context: 1_000_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })

  it('uses gateway provider aliases with prefixed model names inside the aliased provider only', async () => {
    writeConfig(`model:\n  default: openai/gpt-5\n  provider: ai-gateway\n`)
    writeModelsCache({
      vercel: {
        models: {
          'openai/gpt-5': { limit: { context: 1_000_000 } },
        },
      },
      openai: {
        models: {
          'gpt-5': { limit: { context: 400_000 } },
        },
      },
    })

    const { getModelContextLength } = await loadModelContext()

    expect(getModelContextLength()).toBe(1_000_000)
  })
})
