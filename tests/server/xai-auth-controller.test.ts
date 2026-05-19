import { describe, expect, it } from 'vitest'
import { applyXaiOAuthDefaultModel } from '../../packages/server/src/controllers/hermes/xai-auth'

describe('xAI auth controller', () => {
  it('does not keep a non-xAI model when switching the default provider to xai-oauth', () => {
    const config = applyXaiOAuthDefaultModel({
      model: {
        default: 'glm-5-turbo',
        provider: 'custom:glm-coding-plan',
        base_url: 'https://api.z.ai/api/anthropic',
        api_key: 'secret',
      },
    })

    expect(config.model).toEqual({
      default: 'grok-4.3',
      provider: 'xai-oauth',
    })
  })

  it('preserves an existing Grok model when refreshing xai-oauth credentials', () => {
    const config = applyXaiOAuthDefaultModel({
      model: {
        default: 'grok-4.20-reasoning',
        provider: 'xai-oauth',
      },
    })

    expect(config.model).toEqual({
      default: 'grok-4.20-reasoning',
      provider: 'xai-oauth',
    })
  })
})
