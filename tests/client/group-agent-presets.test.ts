// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

describe('group Agent preset UI and API', () => {
  it('exposes CRUD and snapshot conversion without secret fields', async () => {
    const api = await import('../../packages/client/src/api/studio/group-chat')
    const preset: api.GroupAgentPreset = {
      id: 'preset-1',
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
      description: 'Review code',
      avatar: '',
      available: true,
      validationError: '',
      createdAt: 1,
      updatedAt: 1,
    }
    expect(api.groupAgentPresetToRoomAgentInput(preset)).toEqual({
      presetId: 'preset-1',
      agent: 'codex',
      profile: 'research',
      provider: 'openai',
      model: 'gpt-test',
      apiMode: 'codex_responses',
      reasoningEffort: 'high',
      name: 'Reviewer',
      description: 'Review code',
      avatar: '',
    })
  })
})
