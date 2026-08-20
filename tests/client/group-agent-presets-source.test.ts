// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('group Agent preset UI sources', () => {
  it('offers presets in both room creation and add-Agent flows', () => {
    const createRoom = readFileSync('packages/client/src/components/hermes/group-chat/CreateRoomForm.vue', 'utf8')
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(createRoom).toContain("t('groupChat.agentPresets')")
    expect(createRoom).toContain('groupAgentPresetToRoomAgentInput')
    expect(panel).toContain("t('groupChat.agentPreset')")
    expect(panel).toContain('applyAgentPreset')
    expect(panel).toContain('saveAgentPreset')
    expect(panel).toContain('deleteAgentPreset')
  })
})
