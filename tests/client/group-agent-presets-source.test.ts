// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('group Agent preset UI sources', () => {
  it('keeps new Room creation independent from Agent presets', () => {
    const createRoom = readFileSync('packages/client/src/components/hermes/group-chat/CreateRoomForm.vue', 'utf8')

    expect(createRoom).not.toContain('listGroupAgentPresets')
    expect(createRoom).not.toContain('groupAgentPresetToRoomAgentInput')
    expect(createRoom).not.toContain("t('groupChat.agentPresets')")
  })

  it('separates add-member preset selection from existing-member preset management', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(panel).toContain('v-if="!editingAgent" class="agent-preset-selector"')
    expect(panel).toContain('v-if="editingAgent" class="agent-preset-manager"')
    expect(panel).toContain('@update:value="selectAgentPresetForManagement"')
    expect(panel).toContain('saveAgentPreset')
    expect(panel).toContain('deleteAgentPreset')
  })
})
