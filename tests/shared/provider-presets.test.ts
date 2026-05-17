import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS as SERVER_PROVIDER_PRESETS,
  buildProviderModelMap as buildServerProviderModelMap,
} from '../../packages/server/src/shared/providers'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const FUN_CODEX_PROVIDER = 'fun-codex'
const ZAI_PROVIDER = 'zai'
const GLM_CODING_PLAN_PROVIDER = 'glm-coding-plan'
const GPT_5_5_MODEL = 'gpt-5.5'

const MODELS_DEV_ZAI_MODELS = [
  'glm-5.1',
  'glm-5v-turbo',
  'glm-4.7-flashx',
  'glm-4.5-air',
  'glm-4.5v',
  'glm-4.7-flash',
  'glm-4.6',
  'glm-4.5',
  'glm-4.5-flash',
  'glm-5-turbo',
  'glm-4.7',
  'glm-5',
  'glm-4.6v',
]

const MODELS_DEV_ZAI_CODING_PLAN_MODELS = [
  'glm-5.1',
  'glm-4.5-air',
  'glm-5-turbo',
  'glm-4.7',
  'glm-5v-turbo',
]

function modelsForProvider(providerPresets: Array<{ value: string; models: string[] }>, provider: string): string[] {
  const preset = providerPresets.find((candidate) => candidate.value === provider)
  expect(preset).toBeDefined()
  return preset?.models ?? []
}

describe('provider presets', () => {
  it('routes apikey.fun Codex through the Responses transport', () => {
    const preset = SERVER_PROVIDER_PRESETS.find((candidate) => candidate.value === FUN_CODEX_PROVIDER)
    expect(preset?.api_mode).toBe('codex_responses')
  })

  it('lists GPT-5.5 for OpenAI Codex', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, OPENAI_CODEX_PROVIDER)).toContain(GPT_5_5_MODEL)
  })

  it('exposes GPT-5.5 through provider model maps', () => {
    expect(buildServerProviderModelMap()[OPENAI_CODEX_PROVIDER]).toContain(GPT_5_5_MODEL)
  })

  it('keeps the Z.AI direct catalog aligned with models.dev order', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, ZAI_PROVIDER)).toEqual(MODELS_DEV_ZAI_MODELS)
    expect(buildServerProviderModelMap()[ZAI_PROVIDER]).toEqual(MODELS_DEV_ZAI_MODELS)
  })

  it('keeps the GLM coding-plan catalog aligned with the models.dev Z.AI coding-plan subset', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, GLM_CODING_PLAN_PROVIDER)).toEqual(MODELS_DEV_ZAI_CODING_PLAN_MODELS)
    expect(buildServerProviderModelMap()[GLM_CODING_PLAN_PROVIDER]).toEqual(MODELS_DEV_ZAI_CODING_PLAN_MODELS)
  })
})
