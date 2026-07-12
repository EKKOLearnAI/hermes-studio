// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'

const {
  fetchStatusMock,
  fetchModelsMock,
  prepareLaunchMock,
  readConfigMock,
  successMock,
  errorMock,
} = vi.hoisted(() => ({
  fetchStatusMock: vi.fn(),
  fetchModelsMock: vi.fn(),
  prepareLaunchMock: vi.fn(),
  readConfigMock: vi.fn(),
  successMock: vi.fn(),
  errorMock: vi.fn(),
}))

vi.mock('@/api/coding-agents', () => ({
  deleteCodingAgent: vi.fn(),
  fetchCodingAgentsStatus: fetchStatusMock,
  inferCodingAgentApiMode: vi.fn(() => 'chat_completions'),
  installCodingAgent: vi.fn(),
  launchCodingAgentNativeTerminal: vi.fn(),
  normalizeCodingAgentApiMode: vi.fn((value: unknown, fallback: string) => value || fallback),
  prepareCodingAgentLaunch: prepareLaunchMock,
  readCodingAgentConfigFile: readConfigMock,
  writeCodingAgentConfigFile: vi.fn(),
}))

vi.mock('@/api/hermes/system', () => ({
  fetchAvailableModelsForProfile: fetchModelsMock,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default' }),
}))

vi.mock('@/components/hermes/chat/TerminalPanel.vue', () => ({
  default: defineComponent({ name: 'TerminalPanel', setup: () => () => h('div') }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => {
  const NButton = defineComponent({
    name: 'NButton',
    inheritAttrs: false,
    props: { disabled: Boolean, loading: Boolean },
    emits: ['click'],
    setup(props, { slots, emit, attrs }) {
      return () => h('button', {
        ...attrs,
        disabled: props.disabled,
        onClick: () => emit('click'),
      }, slots.default?.())
    },
  })
  const passthrough = (name: string, includeFooter = false) => defineComponent({
    name,
    setup(_props, { slots }) {
      return () => h('div', [slots.default?.(), includeFooter ? slots.footer?.() : undefined])
    },
  })
  return {
    NAlert: passthrough('NAlert'),
    NButton,
    NForm: passthrough('NForm'),
    NFormItem: passthrough('NFormItem'),
    NInput: passthrough('NInput'),
    NModal: passthrough('NModal', true),
    NRadioButton: passthrough('NRadioButton'),
    NRadioGroup: passthrough('NRadioGroup'),
    NSelect: passthrough('NSelect'),
    NSpace: passthrough('NSpace'),
    NSpin: passthrough('NSpin'),
    NTag: passthrough('NTag'),
    useMessage: () => ({ success: successMock, error: errorMock }),
  }
})

import CodingAgentsView from '@/views/hermes/CodingAgentsView.vue'

const installedTools = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    provider: 'Anthropic',
    command: 'claude',
    packageName: 'claude',
    installed: true,
    version: '1',
    rawVersion: '1',
  },
  {
    id: 'codex',
    name: 'Codex',
    provider: 'OpenAI',
    command: 'codex',
    packageName: 'codex',
    installed: true,
    version: '1',
    rawVersion: '1',
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  fetchStatusMock.mockResolvedValue({ tools: installedTools })
  readConfigMock.mockImplementation(async (_id: string, key: string) => ({
    key,
    path: key,
    absolutePath: `/tmp/${key}`,
    language: 'json',
    content: '',
    exists: false,
    size: 0,
    profile: 'default',
    provider: '',
    rootDir: '/tmp',
  }))
  fetchModelsMock.mockResolvedValue({
    profile: 'default',
    default: 'dict-model',
    default_provider: 'custom:dict-proxy',
    groups: [
      {
        provider: 'custom:dict-proxy',
        label: 'Dict Proxy',
        base_url: 'https://dict.invalid/v1',
        models: ['dict-model'],
        api_key: 'browser-must-not-forward-this-value',
        has_api_key: true,
        builtin: true,
        provider_source: 'providers',
        provider_key: 'dict-proxy-entry',
        api_mode: 'chat_completions',
      },
    ],
  })
  prepareLaunchMock.mockResolvedValue({
    shellCommand: 'safe-command',
    provider: 'custom:dict-proxy',
    model: 'dict-model',
  })
})

describe('CodingAgentsView launch credential behavior', () => {
  it('mounts and prepares a stored-credential launch without forwarding a browser secret', async () => {
    const wrapper = mount(CodingAgentsView)
    await flushPromises()

    const launchButton = wrapper.findAll('button').find(button => button.text() === 'codingAgents.launch')
    expect(launchButton).toBeDefined()
    await launchButton!.trigger('click')
    await flushPromises()

    const builtInButton = wrapper.findAll('button').find(button => button.text() === 'codingAgents.builtInTerminal')
    expect(builtInButton).toBeDefined()
    await builtInButton!.trigger('click')
    await flushPromises()

    expect(fetchModelsMock).toHaveBeenCalledWith('default')
    expect(prepareLaunchMock).toHaveBeenCalledWith('claude-code', {
      mode: 'scoped',
      profile: 'default',
      provider: 'custom:dict-proxy',
      model: 'dict-model',
      baseUrl: 'https://dict.invalid/v1',
      apiMode: 'chat_completions',
    })
    expect(JSON.stringify(prepareLaunchMock.mock.calls)).not.toContain('browser-must-not-forward-this-value')
  })
})
