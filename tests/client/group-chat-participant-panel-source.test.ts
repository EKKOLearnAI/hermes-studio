import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync('packages/client/src/components/hermes/group-chat/GroupChatPanel.vue', 'utf8')
const localeFiles = ['en.ts', 'zh.ts', 'zh-TW.ts', 'ja.ts', 'ko.ts', 'de.ts', 'es.ts', 'fr.ts', 'pt.ts', 'ru.ts']
const participantLocaleKeys = [
  'participantRuntime',
  'participantMode',
  'participantModel',
  'participantApiMode',
  'participantReasoningEffort',
  'participantReasoningEffortNextRun',
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

  it('hides scoped provider settings in global mode and never exposes Hermes API mode', () => {
    expect(panelSource).toContain("v-if=\"participantMode === 'scoped'\"")
    expect(panelSource).toContain("v-if=\"participantRuntime === 'coding_agent' && participantMode === 'scoped'\"")
    expect(panelSource).toContain("apiMode: participantRuntime.value === 'coding_agent' && participantMode.value === 'scoped' ? participantApiMode.value : ''")
    expect(panelSource).toContain("provider: participantMode.value === 'scoped' ? participantProvider.value : ''")
  })

  it('uses stable participant identity for interrupt and remove controls', () => {
    expect(panelSource).toContain('handleInterruptAgent(status.agentId)')
    expect(panelSource).toContain('handleRemoveAgent(agent.agentId)')
    expect(panelSource).not.toContain('handleInterruptAgent(agent.name)')
    expect(panelSource).not.toContain('handleRemoveAgent(agent.name)')
  })
})
