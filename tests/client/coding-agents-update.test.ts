// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  checkCodingAgentUpdate: vi.fn(),
  deleteCodingAgent: vi.fn(),
  fetchCodingAgentsStatus: vi.fn(),
  installCodingAgent: vi.fn(),
  readCodingAgentConfigFile: vi.fn(),
  writeCodingAgentConfigFile: vi.fn(),
}))

const messageMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}))

vi.mock('@/api/coding-agents', () => ({
  ...apiMocks,
  inferCodingAgentApiMode: () => 'codex_responses',
  launchCodingAgentNativeTerminal: vi.fn(),
  normalizeCodingAgentApiMode: (value?: string, fallback?: string) => value || fallback || 'codex_responses',
  prepareCodingAgentLaunch: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => ({
  fetchAvailableModelsForProfile: vi.fn().mockResolvedValue({ groups: [] }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default' }),
}))

vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  default: defineComponent({ template: '<div />' }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => {
  const SlotStub = defineComponent({ template: '<div><slot /></div>' })
  return {
    NAlert: SlotStub,
    NButton: defineComponent({
      props: { disabled: Boolean, loading: Boolean },
      emits: ['click'],
      template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
    }),
    NForm: SlotStub,
    NFormItem: SlotStub,
    NInput: SlotStub,
    NModal: SlotStub,
    NRadioButton: SlotStub,
    NRadioGroup: SlotStub,
    NSelect: SlotStub,
    NSpace: SlotStub,
    NSpin: SlotStub,
    NTag: defineComponent({ template: '<span><slot /></span>' }),
    useMessage: () => messageMock,
  }
})

import CodingAgentsView from '@/views/hermes/CodingAgentsView.vue'

const claudeV1 = {
  id: 'claude-code',
  name: 'Claude Code',
  provider: 'Anthropic',
  command: 'claude',
  packageName: '@anthropic-ai/claude-code',
  installed: true,
  version: '1.0.0',
  rawVersion: '1.0.0',
}

const claudeV2 = {
  ...claudeV1,
  version: '2.0.0',
  rawVersion: '2.0.0',
}

const codexMissing = {
  id: 'codex',
  name: 'Codex',
  provider: 'OpenAI',
  command: 'codex',
  packageName: '@openai/codex',
  installed: false,
  version: '',
  rawVersion: '',
}

function buttonWithText(wrapper: VueWrapper, text: string) {
  return wrapper.findAll('button').find(button => button.text() === text)
}

describe('CodingAgentsView update state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiMocks.fetchCodingAgentsStatus.mockResolvedValue({ tools: [claudeV1, codexMissing] })
    apiMocks.readCodingAgentConfigFile.mockResolvedValue({
      content: '',
      absolutePath: '/tmp/config',
      exists: false,
    })
  })

  it('rechecks after an update and replaces the available banner with the latest state', async () => {
    apiMocks.checkCodingAgentUpdate
      .mockResolvedValueOnce({
        success: true,
        tool: claudeV1,
        latestVersion: '2.0.0',
        updateAvailable: true,
      })
      .mockResolvedValueOnce({
        success: true,
        tool: claudeV2,
        latestVersion: '2.0.0',
        updateAvailable: false,
      })
    apiMocks.installCodingAgent.mockResolvedValue({
      success: true,
      tool: claudeV2,
      tools: [claudeV2, codexMissing],
    })

    const wrapper = mount(CodingAgentsView)
    await flushPromises()

    await buttonWithText(wrapper, 'codingAgents.checkUpdate')!.trigger('click')
    await flushPromises()

    const availableState = wrapper.get('[data-testid="coding-agent-update-claude-code"]')
    expect(availableState.text()).toContain('codingAgents.newVersionAvailable')
    expect(availableState.text()).toContain('2.0.0')
    expect(availableState.find('.update-action').exists()).toBe(true)
    expect(availableState.find('.agent-install-summary').exists()).toBe(false)

    await buttonWithText(wrapper, 'codingAgents.updateNow')!.trigger('click')
    await flushPromises()

    expect(apiMocks.installCodingAgent).toHaveBeenCalledWith('claude-code')
    expect(apiMocks.checkCodingAgentUpdate).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="coding-agent-update-claude-code"]').text())
      .toContain('codingAgents.upToDate')
    expect(wrapper.find('.agent-install-summary').text()).toContain('2.0.0')
    expect(wrapper.text()).not.toContain('codingAgents.newVersionAvailable')
    expect(wrapper.text()).not.toContain('codingAgents.checkingUpdate')
    expect(buttonWithText(wrapper, 'codingAgents.checkUpdate')).toBeTruthy()
  })

  it('shows only the error toast when the update check fails', async () => {
    apiMocks.checkCodingAgentUpdate.mockResolvedValue({
      success: false,
      tool: claudeV1,
      latestVersion: '',
      updateAvailable: false,
      message: 'registry unavailable',
    })

    const wrapper = mount(CodingAgentsView)
    await flushPromises()

    await buttonWithText(wrapper, 'codingAgents.checkUpdate')!.trigger('click')
    await flushPromises()

    expect(messageMock.error).toHaveBeenCalledWith('registry unavailable')
    expect(wrapper.find('[data-testid="coding-agent-update-claude-code"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('codingAgents.upToDate')
    expect(wrapper.text()).not.toContain('codingAgents.checkingUpdate')
  })
})
