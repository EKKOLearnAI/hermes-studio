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

  it('uses explicit preset dialogs instead of embedded selects', () => {
    const panel = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')

    expect(panel).toContain('@click="openAgentPresetSelection"')
    expect(panel).toContain('@click="openAgentPresetManager"')
    expect(panel).toContain('class="agent-preset-dialog-list"')
    expect(panel).toContain('@click="confirmAgentPresetSelection"')
    expect(panel).toContain('preset.validationError')
    expect(panel).not.toContain('class="agent-preset-selector"')
    expect(panel).not.toContain('class="agent-preset-manager"')
    expect(panel).toContain('saveAgentPreset')
    expect(panel).toContain('deleteAgentPreset')
  })
})
