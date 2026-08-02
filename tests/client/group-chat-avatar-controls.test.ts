import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
const messageListSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageList.vue', 'utf8')
const messageItemSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupMessageItem.vue', 'utf8')
const inputSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatInput.vue', 'utf8')
const bridgeClientSource = readFileSync('packages/server/src/services/hermes/agent-bridge/client.ts', 'utf8')
const bridgeServerSource = readFileSync('packages/server/src/services/hermes/agent-bridge/python/bridge_server.py', 'utf8')
const bridgePoolSource = readFileSync('packages/server/src/services/hermes/agent-bridge/python/bridge_pool.py', 'utf8')
const agentClientsSource = readFileSync('packages/server/src/services/hermes/group-chat/agent-clients.ts', 'utf8')

const localeFiles = ['en.ts', 'zh.ts', 'zh-TW.ts', 'ja.ts', 'ko.ts', 'de.ts', 'es.ts', 'fr.ts', 'pt.ts', 'ru.ts']
const localeKeys = [
  'participantQuickSettings',
  'mentionParticipant',
  'participantSettingsNextRun',
  'participantSettingsSaved',
]

describe('Group Chat participant avatar direct controls', () => {
  it('opens one shared participant panel from the semantic message-stream avatar', () => {
    expect(messageItemSource).toContain('class="avatar participant-message-avatar-trigger"')
    expect(messageItemSource).toContain(':aria-expanded="expandedParticipantId === agentInfo.agentId"')
    expect(messageItemSource).toContain("emit('participantAvatarClick', { participantId: participant.agentId, trigger })")
    expect(messageListSource).toContain('@participant-avatar-click="payload => emit(\'participantAvatarClick\', payload)"')
    expect(panelSource).toContain('@participant-avatar-click="handleMessageParticipantAvatar"')
    expect(panelSource).toContain('class="participant-quick-settings message-participant-quick-settings"')
    expect(panelSource).toContain(':x="participantQuickX"')
    expect(panelSource).toContain(':y="participantQuickY"')
    expect(panelSource).toContain("reasoningEffort: pending.value || ''")
    expect(panelSource).toContain('value: reasoningEffort')
    expect(panelSource).toContain('participantQuickKey(roomId, agent.agentId, authorityGeneration)')
    expect(panelSource).toContain('applyParticipantQuickState(roomId, agent.agentId, authorityGeneration, desired)')
    expect(panelSource).toContain('participantQuickDesired.clear()')
    expect(panelSource).toContain('participantReasoningCommits.clear()')
    expect(panelSource).toContain('participantModelOptions(expandedParticipant)')
    expect(panelSource).toContain('participantApiModeOptionsFor(expandedParticipant)')
    expect(panelSource).toContain('class="participant-reasoning-slider"')
    expect(panelSource).toContain('<NSlider')
    expect(panelSource).toContain('@update:value="value => handleQuickReasoningChange(expandedParticipant, value)"')
    expect(panelSource).toContain('@click="mentionParticipant(expandedParticipant)"')
  })

  it('resolves the message participant by stable sender ID before the legacy name fallback', () => {
    expect(messageItemSource).toContain("props.agents.find(a => a.agentId === props.message.senderId)")
    expect(messageItemSource).toContain("props.agents.find(a => a.name === props.message.senderName)")
    expect(messageItemSource).toContain("props.message.role !== 'assistant' && props.message.role !== 'tool'")
    expect(messageItemSource).not.toContain("a.agentId === props.message.senderId || a.name === props.message.senderName")
  })

  it('uses immediate participant PATCH updates without a secondary save modal', () => {
    expect(panelSource).toContain('saveParticipantQuickSetting(agent')
    expect(panelSource).toContain('store.updateAgentInRoom(roomId, agent.agentId')
    expect(panelSource).toContain('participantSettingsNextRun')
    expect(panelSource).not.toContain('showParticipantQuickSettingsModal')
  })

  it('reuses the single-chat reasoning scale and keeps default as an empty inherited value', () => {
    for (const value of ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      expect(panelSource).toContain(`value: '${value === 'default' ? '' : value}'`)
    }
    expect(panelSource).toContain('participantReasoningSliderValue(agent)')
    expect(panelSource).toContain('participantReasoningSliderLabel')
  })

  it('inserts an atomic structured participant mention through the composer public API', () => {
    expect(panelSource).toContain('groupChatInputRef.value?.insertParticipantMention(agent.agentId, agent.name)')
    expect(inputSource).toContain('function insertParticipantMention(participantId: string, displayName: string)')
    expect(inputSource).toContain("type: 'agent', participantId: normalizedParticipantId, name: normalizedDisplayName")
    expect(inputSource).toContain('defineExpose({ addFiles, insertParticipantMention })')
  })

  it('preserves old Room participants with empty next-run settings', () => {
    expect(panelSource).toContain("agent.reasoningEffort || ''")
    expect(panelSource).toContain("expandedParticipant.mode || 'scoped'")
    expect(panelSource).toContain("agent.runtime || 'hermes'")
  })

  it('localizes the direct avatar controls in every shipped locale', () => {
    for (const file of localeFiles) {
      const source = readFileSync(`packages/client/src/i18n/locales/${file}`, 'utf8')
      for (const key of localeKeys) expect(source).toContain(`${key}:`)
    }
  })

  it('forwards a Hermes participant API mode through the complete Agent Bridge contract', () => {
    expect(panelSource).toContain("apiMode: String(requested.apiMode || '')")
    expect(panelSource).toContain('participantApiModeOptionsFor(expandedParticipant)')
    expect(panelSource).toContain("runtime === 'hermes'")
    expect(panelSource).toContain("'bedrock_converse'")
    expect(panelSource).toContain("'codex_app_server'")
    expect(bridgeClientSource).toContain('api_mode?: string')
    expect(bridgeClientSource).toContain("...(options.api_mode !== undefined ? { api_mode: options.api_mode } : {})")
    expect(agentClientsSource).toContain("api_mode: String(participantSnapshot.apiMode || '')")
    expect(bridgeServerSource).toContain('api_mode = req.get("api_mode")')
    expect(bridgePoolSource).toContain('api_mode_specified = api_mode is not None')
    expect(bridgePoolSource).toContain('api_mode=api_mode')
  })
})
