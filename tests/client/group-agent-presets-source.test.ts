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
    expect(panel).toContain("err?.code === 'GROUP_AGENT_PRESET_NAME_CONFLICT'")
    expect(panel).toContain("t('groupChat.agentPresetAlreadyExists')")
  })

  it('provides the required Simplified Chinese duplicate-name message', () => {
    const locale = readFileSync('packages/client/src/i18n/locales/zh.ts', 'utf8')

    expect(locale).toContain("agentPresetAlreadyExists: '该预设已添加过'")
  })
})
