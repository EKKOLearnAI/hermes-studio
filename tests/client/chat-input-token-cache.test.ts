// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

const activeSession = reactive<any>({
  id: 'session-cache',
  profile: 'default',
  provider: 'test-provider',
  model: 'test-model',
  contextTokens: 0,
  inputTokens: 3600,
  outputTokens: 400,
  cacheReadTokens: 76400,
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => ({
    activeSession,
    activeSessionId: activeSession.id,
    isStreaming: false,
    isWorking: false,
    isAborting: false,
    activeSessionHasOnlyPeerMessages: false,
    abortState: null,
    pendingApprovalForActiveSession: null,
    pendingClarifyForActiveSession: null,
    sendMessage: vi.fn(),
    sendPeerUserMessage: vi.fn(),
    abortRun: vi.fn(),
    stopStreaming: vi.fn(),
    respondApproval: vi.fn(),
    respondClarification: vi.fn(),
  }),
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => ({
    selectedProvider: 'test-provider',
    selectedModel: 'test-model',
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default' }),
}))

vi.mock('@/stores/hermes/settings', () => ({
  useSettingsStore: () => ({
    useStreamableHttp: false,
    allowPeerMessages: false,
  }),
}))

vi.mock('@/api/hermes/models', () => ({
  fetchContextLength: vi.fn().mockResolvedValue({ context_length: 1000000 }),
}))

vi.mock('@/utils/completion-sound', () => ({
  primeCompletionSound: vi.fn(),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    props: ['disabled', 'circle', 'secondary', 'type', 'size', 'quaternary', 'loading'],
    emits: ['click'],
    template: '<button type="button" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
  }),
  NTooltip: defineComponent({ template: '<span><slot name="trigger" /><slot /></span>' }),
  NSwitch: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<button type="button"></button>',
  }),
  NModal: defineComponent({ template: '<div><slot /><slot name="footer" /></div>' }),
  NInputNumber: defineComponent({
    props: ['value'],
    emits: ['update:value'],
    template: '<input type="number" :value="value" />',
  }),
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

describe('ChatInput token usage', () => {
  it('includes cache-read tokens when displaying chat context usage', async () => {
    const wrapper = mount(ChatInput)

    await Promise.resolve()

    expect(wrapper.text()).toContain('80.4k /')
  })
})
