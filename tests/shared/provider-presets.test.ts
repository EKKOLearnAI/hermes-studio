import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS as SERVER_PROVIDER_PRESETS,
  buildProviderModelMap as buildServerProviderModelMap,
} from '../../packages/server/src/shared/providers'
import {
  PROVIDER_PRESETS as CLIENT_PROVIDER_PRESETS,
  buildProviderModelMap as buildClientProviderModelMap,
} from '../../packages/client/src/shared/providers'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const FUN_CODEX_PROVIDER = 'fun-codex'
const GPT_5_5_MODEL = 'gpt-5.5'

function modelsForProvider(providerPresets: Array<{ value: string; models: string[] }>, provider: string): string[] {
  const preset = providerPresets.find((candidate) => candidate.value === provider)
  expect(preset).toBeDefined()
  return preset?.models ?? []
}

describe('provider presets', () => {
  it('routes apikey.fun Codex through the Responses transport on both client and server', () => {
    const clientPreset = CLIENT_PROVIDER_PRESETS.find(candidate => candidate.value === FUN_CODEX_PROVIDER)
    const serverPreset = SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === FUN_CODEX_PROVIDER)
    expect(clientPreset?.api_mode).toBe('codex_responses')
    expect(serverPreset?.api_mode).toBe('codex_responses')
  })

  it('keeps the newer Z.AI model aliases available on both client and server', () => {
    expect(modelsForProvider(CLIENT_PROVIDER_PRESETS, 'zai')).toContain('glm-4.7-flashx')
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, 'zai')).toContain('glm-4.7-flashx')
    expect(modelsForProvider(CLIENT_PROVIDER_PRESETS, 'glm-coding-plan')).toContain('glm-4.5-air')
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, 'glm-coding-plan')).toContain('glm-4.5-air')
  })

  it('lists GPT-5.5 for OpenAI Codex on both client and server', () => {
    expect(modelsForProvider(CLIENT_PROVIDER_PRESETS, OPENAI_CODEX_PROVIDER)).toContain(GPT_5_5_MODEL)
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, OPENAI_CODEX_PROVIDER)).toContain(GPT_5_5_MODEL)
  })

  it('exposes GPT-5.5 through provider model maps', () => {
    expect(buildClientProviderModelMap()[OPENAI_CODEX_PROVIDER]).toContain(GPT_5_5_MODEL)
    expect(buildServerProviderModelMap()[OPENAI_CODEX_PROVIDER]).toContain(GPT_5_5_MODEL)
  })
})
