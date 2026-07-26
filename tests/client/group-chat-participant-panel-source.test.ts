import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
const localeFiles = ['en.ts', 'zh.ts', 'zh-TW.ts', 'ja.ts', 'ko.ts', 'de.ts', 'es.ts', 'fr.ts', 'pt.ts', 'ru.ts']
const participantLocaleKeys = [
  'participantRuntime',
  'participantModel',
  'participantApiMode',
  'participantReasoningEffort',
  'participantReasoningEffortNextRun',
  'participantAvatar',
  'editParticipant',
  'sessionGeneration',
]

describe('GroupChatPanel mixed-runtime participant UI contract', () => {
  it('uses localized labels for participant controls in every shipped locale', () => {
    for (const key of participantLocaleKeys) {
      expect(panelSource).toContain(`groupChat.${key}`)
    }
    expect(panelSource).not.toMatch(/>Runtime<|>Mode<|>Model<|>API mode<|Reasoning effort|Edit participant|· gen /)

    for (const file of localeFiles) {
      const source = readFileSync(`packages/client/src/i18n/locales/${file}`, 'utf8')
      for (const key of participantLocaleKeys) expect(source).toContain(`${key}:`)
    }
  })

  it('keeps immutable runtime/profile identity out of the edit payload and marks next-run settings', () => {
    const editHandler = panelSource.slice(
      panelSource.indexOf('async function confirmEditAgent()'),
      panelSource.indexOf('function handleOpenWorkspacePicker'),
    )
    expect(editHandler).toContain('updateAgentInRoom')
    expect(editHandler).not.toContain('runtime:')
    expect(editHandler).not.toContain('codingAgentId:')
    expect(editHandler).not.toContain('profile:')
    expect(panelSource).toContain("groupChat.participantReasoningEffortNextRun")
  })

  it('hides the redundant model selector for Hermes and keeps it for scoped coding agents', () => {
    expect(panelSource).toContain("v-if=\"participantRuntime === 'coding_agent' && participantMode === 'scoped'\"")
    const addAgentForm = panelSource.slice(
      panelSource.indexOf('v-if="showAddAgentModal"'),
      panelSource.indexOf('v-if="showEditAgentModal"'),
    )
    expect(addAgentForm).toMatch(/participantRuntime === 'coding_agent' && participantMode === 'scoped'[\s\S]*groupChat\.participantModel/)
  })

  it('filters coding-agent models to compatible providers and requires a complete scoped launch tuple', () => {
    expect(panelSource).toContain('canScopedCodingAgentUseProvider')
    expect(panelSource).toContain('participantCanSubmit')
    expect(panelSource).toContain(':disabled="!participantCanSubmit"')
  })

  it('does not persist redundant Hermes model overrides', () => {
    expect(panelSource).toContain("provider: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantProvider.value : ''")
    expect(panelSource).toContain("model: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantModel.value : ''")
  })

  it('hides scoped provider settings in global mode and never exposes Hermes API mode', () => {
    expect(panelSource).toContain("v-if=\"participantMode === 'scoped'\"")
    expect(panelSource).toContain("v-if=\"participantRuntime === 'coding_agent' && participantMode === 'scoped'\"")
    expect(panelSource).toContain("apiMode: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantApiMode.value : ''")
    expect(panelSource).toContain("provider: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantProvider.value : ''")
  })

  it('keeps every custom modal reachable inside a short viewport', () => {
    expect(panelSource).toContain('max-height: calc(100vh - 32px)')
    expect(panelSource).toContain('overflow-y: auto')
  })

  it('defaults the participant profile and its configured model instead of showing empty selectors', () => {
    expect(panelSource).toContain('profilesStore.activeProfileName || profilesStore.profiles[0]?.name || null')
    expect(panelSource).toContain('selectedProfileDefaults')
    expect(panelSource).toContain('profileDefaults.default_provider')
    expect(panelSource).toContain('profileDefaults.default')
  })

  it('preserves the selected provider API mode when switching coding-agent runtime or model provider', () => {
    expect(panelSource).toContain('normalizeCodingAgentApiMode')
    expect(panelSource).toContain('inferCodingAgentApiMode')
    expect(panelSource).toContain("participantModelGroups.value.find(group => group.provider === selection.provider)")
    expect(panelSource).toMatch(/participantApiMode\.value = normalizeCodingAgentApiMode\(\s*selection\.apiMode,\s*inferCodingAgentApiMode\(providerGroup\?\.provider, providerGroup\?\.base_url\),\s*\)/)
    expect(panelSource).not.toContain("if (value === 'codex') participantApiMode.value = 'codex_responses'")
    expect(panelSource).not.toContain("if (value === 'claude-code') participantApiMode.value = 'anthropic_messages'")
  })

  it('does not render a one-option launch mode selector', () => {
    expect(panelSource).not.toContain('participantModeOptions')
    expect(panelSource).not.toContain("t('groupChat.participantMode')")
    expect(panelSource).not.toContain("v-model:value=\"participantMode\"")
  })

  it('treats default reasoning as profile inheritance instead of a provider value', () => {
    expect(panelSource).toContain("participantReasoningEffort.value === 'default' ? '' : participantReasoningEffort.value")
  })

  it('uses a participant-owned runtime avatar with upload, randomize, and reset controls', () => {
    expect(panelSource).toContain('participantAvatar')
    expect(panelSource).toContain('defaultParticipantAvatar')
    expect(panelSource).toContain('handleParticipantAvatarFileChange')
    expect(panelSource).toContain('randomizeParticipantAvatar')
    expect(panelSource).toContain('resetParticipantAvatar')
    expect(panelSource).toContain(':avatar="agent.avatar || profileAvatarFor(agent.profile)"')
  })

  it('uses stable participant identity for interrupt and remove controls', () => {
    expect(panelSource).toContain('handleInterruptAgent(status.agentId)')
    expect(panelSource).toContain('handleRemoveAgent(agent.agentId)')
    expect(panelSource).not.toContain('handleInterruptAgent(agent.name)')
    expect(panelSource).not.toContain('handleRemoveAgent(agent.name)')
  })
})
