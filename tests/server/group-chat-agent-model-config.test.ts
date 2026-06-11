import { beforeEach, describe, expect, it, vi } from 'vitest'

const readConfigYamlForProfileMock = vi.fn()

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

describe('group chat agent model config', () => {
  beforeEach(() => {
    readConfigYamlForProfileMock.mockReset()
  })

  it('resolves the mentioned agent profile default model and provider', async () => {
    readConfigYamlForProfileMock.mockResolvedValueOnce({
      model: { default: 'research-model', provider: 'research-provider' },
    })
    const { resolveGroupAgentModelContext } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')

    const result = await resolveGroupAgentModelContext('research')

    expect(readConfigYamlForProfileMock).toHaveBeenCalledWith('research')
    expect(result).toEqual({ model: 'research-model', provider: 'research-provider' })
  })

  it('requires cached context metadata to match the active model and provider', async () => {
    const { isGroupBridgeContextCacheCompatible } = await import('../../packages/server/src/services/hermes/group-chat/agent-clients')

    expect(isGroupBridgeContextCacheCompatible(
      { model: 'research-model', provider: 'research-provider' },
      { model: 'research-model', provider: 'research-provider' },
    )).toBe(true)
    expect(isGroupBridgeContextCacheCompatible(
      { model: 'other-model', provider: 'research-provider' },
      { model: 'research-model', provider: 'research-provider' },
    )).toBe(false)
    expect(isGroupBridgeContextCacheCompatible(
      { fixedContextTokens: 120 } as { model?: string; provider?: string },
      { model: 'research-model', provider: 'research-provider' },
    )).toBe(false)
  })
})
