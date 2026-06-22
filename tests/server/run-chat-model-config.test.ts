import { beforeEach, describe, expect, it, vi } from 'vitest'

const readConfigYamlForProfileMock = vi.fn()

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

describe('run chat model config', () => {
  beforeEach(() => {
    readConfigYamlForProfileMock.mockReset()
    readConfigYamlForProfileMock.mockResolvedValue({
      model: { default: 'default-model', provider: 'default-provider' },
    })
  })

  it('uses the requested model for a new bridge session before falling back to profile default', async () => {
    const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/services/hermes/run-chat/model-config')

    const result = await resolveBridgeRunModelConfig({
      profile: 'default',
      requestedModel: 'gpt-5.2',
      requestedProvider: 'openai',
      modelGroups: [{ provider: 'openai', models: ['gpt-5.2'] }],
    })

    expect(result).toEqual({ model: 'gpt-5.2', provider: 'openai' })
    expect(readConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('uses the requested model ahead of a stale session model', async () => {
    const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/services/hermes/run-chat/model-config')

    const result = await resolveBridgeRunModelConfig({
      profile: 'default',
      sessionModel: 'claude-sonnet-4.5',
      sessionProvider: 'anthropic',
      requestedModel: 'gpt-5.2',
      requestedProvider: 'openai',
      modelGroups: [
        { provider: 'anthropic', models: ['claude-sonnet-4.5'] },
        { provider: 'openai', models: ['gpt-5.2'] },
      ],
    })

    expect(result).toEqual({ model: 'gpt-5.2', provider: 'openai' })
    expect(readConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('keeps an explicit model when no model group list is available', async () => {
    const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/services/hermes/run-chat/model-config')

    const result = await resolveBridgeRunModelConfig({
      profile: 'default',
      requestedModel: 'gpt-5.5',
      requestedProvider: 'custom',
    })

    expect(result).toEqual({ model: 'gpt-5.5', provider: 'custom' })
    expect(readConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('maps Claude OAuth to the Anthropic runtime provider', async () => {
    const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/services/hermes/run-chat/model-config')

    const result = await resolveBridgeRunModelConfig({
      profile: 'default',
      requestedModel: 'claude-sonnet-4-6',
      requestedProvider: 'claude-oauth',
      modelGroups: [{ provider: 'claude-oauth', models: ['claude-sonnet-4-6'] }],
    })

    expect(result).toEqual({ model: 'claude-sonnet-4-6', provider: 'anthropic' })
    expect(readConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('keeps an explicit session model even when it is missing from the loaded model groups', async () => {
    const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/services/hermes/run-chat/model-config')

    const result = await resolveBridgeRunModelConfig({
      profile: 'default',
      sessionModel: 'claude-opus-4-8',
      sessionProvider: 'anthropic',
      modelGroups: [{ provider: 'openai', models: ['gpt-5.2'] }],
    })

    expect(result).toEqual({ model: 'claude-opus-4-8', provider: 'anthropic' })
    expect(readConfigYamlForProfileMock).not.toHaveBeenCalled()
  })

  it('falls back to the profile default only when no explicit model/provider exists', async () => {
    const { resolveBridgeRunModelConfig } = await import('../../packages/server/src/services/hermes/run-chat/model-config')

    const result = await resolveBridgeRunModelConfig({
      profile: 'default',
      modelGroups: [{ provider: 'openai', models: ['gpt-5.2'] }],
    })

    expect(result).toEqual({ model: 'default-model', provider: 'default-provider' })
    expect(readConfigYamlForProfileMock).toHaveBeenCalledWith('default')
  })
})
