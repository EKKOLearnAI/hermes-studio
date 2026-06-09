import { describe, expect, it } from 'vitest'

import {
  PROVIDER_PRESETS as SERVER_PROVIDER_PRESETS,
  buildProviderModelMap as buildServerProviderModelMap,
} from '../../packages/server/src/shared/providers'
import { PROVIDER_ENV_MAP } from '../../packages/server/src/services/config-helpers'

const OPENAI_CODEX_PROVIDER = 'openai-codex'
const COPILOT_PROVIDER = 'copilot'
const FUN_CODEX_PROVIDER = 'fun-codex'
const KIMI_CODING_PROVIDER = 'kimi-coding'
const KIMI_CODING_CN_PROVIDER = 'kimi-coding-cn'
const MINIMAX_PROVIDER = 'minimax'
const MINIMAX_CN_PROVIDER = 'minimax-cn'
const NOUS_PROVIDER = 'nous'
const STEPFUN_PROVIDER = 'stepfun'
const XAI_OAUTH_PROVIDER = 'xai-oauth'
const GPT_5_5_MODEL = 'gpt-5.5'

function modelsForProvider(providerPresets: Array<{ value: string; models: string[] }>, provider: string): string[] {
  const preset = providerPresets.find((candidate) => candidate.value === provider)
  expect(preset).toBeDefined()
  return preset?.models ?? []
}

describe('provider presets', () => {
  it('keeps every built-in provider preset registered in the env map', () => {
    const missingMappings = SERVER_PROVIDER_PRESETS
      .filter(candidate => candidate.builtin)
      .map(candidate => candidate.value)
      .filter(provider => !Object.prototype.hasOwnProperty.call(PROVIDER_ENV_MAP, provider))

    expect(missingMappings).toEqual([])
  })

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

  it('treats xAI OAuth as OAuth-only for availability checks', () => {
    expect(PROVIDER_ENV_MAP[XAI_OAUTH_PROVIDER]).toEqual({ api_key_env: '', base_url_env: '' })
  })

  it('keeps Kimi Coding Plan and China credentials distinct without duplicate Moonshot presets', () => {
    expect(PROVIDER_ENV_MAP[KIMI_CODING_PROVIDER]).toEqual({ api_key_env: 'KIMI_API_KEY', base_url_env: 'KIMI_BASE_URL' })
    expect(PROVIDER_ENV_MAP[KIMI_CODING_CN_PROVIDER]).toEqual({ api_key_env: 'KIMI_CN_API_KEY', base_url_env: '' })
    expect(PROVIDER_ENV_MAP).not.toHaveProperty('moonshot')

    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === KIMI_CODING_PROVIDER)?.base_url).toBe('https://api.kimi.com/coding/v1')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === KIMI_CODING_CN_PROVIDER)?.base_url).toBe('https://api.kimi.cn/coding/v1')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === KIMI_CODING_CN_PROVIDER)?.label).toBe('Kimi for Coding China')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === 'moonshot')).toBeUndefined()
  })

  it('does not expose incomplete built-in provider presets', () => {
    expect(PROVIDER_ENV_MAP).not.toHaveProperty('azure-foundry')
    expect(SERVER_PROVIDER_PRESETS.find(candidate => candidate.value === 'azure-foundry')).toBeUndefined()
    expect(SERVER_PROVIDER_PRESETS.filter(candidate => candidate.builtin && !candidate.base_url && candidate.models.length === 0)).toEqual([])
  })

  it('includes Step 3.7 Flash in the StepFun fallback catalog', () => {
    expect(modelsForProvider(SERVER_PROVIDER_PRESETS, STEPFUN_PROVIDER)).toContain('step-3.7-flash')
  })

  it('keeps MiniMax M3 first while retaining currently supported M2.x Anthropic models', () => {
    expect(PROVIDER_ENV_MAP[MINIMAX_PROVIDER]).toEqual({ api_key_env: 'MINIMAX_API_KEY', base_url_env: 'MINIMAX_BASE_URL' })
    expect(PROVIDER_ENV_MAP[MINIMAX_CN_PROVIDER]).toEqual({ api_key_env: 'MINIMAX_CN_API_KEY', base_url_env: 'MINIMAX_CN_BASE_URL' })

    for (const provider of [MINIMAX_PROVIDER, MINIMAX_CN_PROVIDER]) {
      const models = modelsForProvider(SERVER_PROVIDER_PRESETS, provider)
      expect(models[0]).toBe('MiniMax-M3')
      expect(models).toEqual(expect.arrayContaining([
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.1',
        'MiniMax-M2.1-highspeed',
        'MiniMax-M2',
      ]))
    }
  })

  it('includes current GitHub Copilot fallback models', () => {
    const models = modelsForProvider(SERVER_PROVIDER_PRESETS, COPILOT_PROVIDER)
    expect(models).toEqual(expect.arrayContaining([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-nano',
      'claude-opus-4.8',
      'gemini-3.5-flash',
      'raptor-mini',
    ]))
    expect(models).not.toContain('grok-code-fast-1')
  })

  it('hardcodes current Nous catalog and recommended models', () => {
    const models = modelsForProvider(SERVER_PROVIDER_PRESETS, NOUS_PROVIDER)
    expect(models).toContain('anthropic/claude-opus-4.8')
    expect(models).toContain('qwen/qwen3.7-max')
    expect(models).toContain('qwen/qwen3.6-35b-a3b')
    expect(buildServerProviderModelMap()[NOUS_PROVIDER]).toContain('qwen/qwen3.7-max')
  })
})
