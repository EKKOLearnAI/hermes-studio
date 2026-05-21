import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS as SERVER_PROVIDER_PRESETS,
  buildProviderModelMap as buildServerProviderModelMap,
} from '../../packages/server/src/shared/providers'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const FUN_CODEX_PROVIDER = 'fun-codex'
const NOUS_PROVIDER = 'nous'
const GPT_5_5_MODEL = 'gpt-5.5'

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

  it('hardcodes current Nous catalog and recommended models', () => {
    const models = modelsForProvider(SERVER_PROVIDER_PRESETS, NOUS_PROVIDER)
    expect(models).toContain('qwen/qwen3.6-plus')
    expect(models).toContain('qwen/qwen3.6-35b-a3b')
    expect(models).toContain('deepseek/deepseek-v4-flash')
    expect(buildServerProviderModelMap()[NOUS_PROVIDER]).toContain('deepseek/deepseek-v4-flash')
  })
})
