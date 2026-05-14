import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS as SERVER_PROVIDER_PRESETS,
  buildProviderModelMap as buildServerProviderModelMap,
} from '../../packages/server/src/shared/providers'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const GPT_5_5_MODEL = 'gpt-5.5'

function modelsForProvider(providerPresets: Array<{ value: string; models: string[] }>, provider: string): string[] {
  const preset = providerPresets.find((candidate) => candidate.value === provider)
  expect(preset).toBeDefined()
  return preset?.models ?? []
}

describe('provider presets', () => {
  it('lists GPT-5.5 for OpenAI Codex', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, OPENAI_CODEX_PROVIDER)).toContain(GPT_5_5_MODEL)
  })

  it('exposes GPT-5.5 through provider model maps', () => {
    expect(buildServerProviderModelMap()[OPENAI_CODEX_PROVIDER]).toContain(GPT_5_5_MODEL)
  })
})
