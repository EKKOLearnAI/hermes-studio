import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function makeHome() {
  const root = join(tmpdir(), `wui-model-context-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const hermes = join(root, '.hermes')
  mkdirSync(hermes, { recursive: true })
  return { root, hermes }
}

function writeConfig(hermes: string, yaml: string) {
  writeFileSync(join(hermes, 'config.yaml'), yaml)
}

function writeModelsCache(hermes: string) {
  writeFileSync(join(hermes, 'models_dev_cache.json'), JSON.stringify({
    openai: {
      models: {
        'gpt-5.5': { limit: { context: 1_050_000 } },
        'gpt-5.4': { limit: { context: 1_050_000 } },
      },
    },
    google: {
      models: {
        'gemini-3.1-pro-preview': { limit: { context: 1_000_000 } },
      },
    },
  }))
}

async function importContextService(home: string) {
  vi.resetModules()
  vi.stubEnv('HOME', home)
  return await import('../../packages/server/src/services/hermes/model-context')
}

describe('model context length resolution', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('does not borrow OpenAI context metadata for an openai-codex model with the same name', async () => {
    const { root, hermes } = makeHome()
    writeConfig(hermes, 'model:\n  provider: openai-codex\n  default: gpt-5.5\n')
    writeModelsCache(hermes)

    const { getModelContextLength } = await importContextService(root)

    expect(getModelContextLength()).toBe(200_000)
  })

  it('still honors explicit model.context_length before provider-aware cache lookup', async () => {
    const { root, hermes } = makeHome()
    writeConfig(hermes, 'model:\n  provider: openai-codex\n  default: gpt-5.5\n  context_length: 272000\n')
    writeModelsCache(hermes)

    const { getModelContextLength } = await importContextService(root)

    expect(getModelContextLength()).toBe(272_000)
  })

  it('preserves providerless legacy lookup by model name', async () => {
    const { root, hermes } = makeHome()
    writeConfig(hermes, 'model:\n  default: gpt-5.5\n')
    writeModelsCache(hermes)

    const { getModelContextLength } = await importContextService(root)

    expect(getModelContextLength()).toBe(1_050_000)
  })

  it('uses intentional cache provider aliases without conflating openai-codex with openai', async () => {
    const { root, hermes } = makeHome()
    writeConfig(hermes, 'model:\n  provider: gemini\n  default: gemini-3.1-pro-preview\n')
    writeModelsCache(hermes)

    const { getModelContextLength } = await importContextService(root)

    expect(getModelContextLength()).toBe(1_000_000)
  })
})
