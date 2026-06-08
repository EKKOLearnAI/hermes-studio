// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import { useChatStore } from '@/stores/hermes/chat'
import ChatInput from '@/components/hermes/chat/ChatInput.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NModal: { template: '<div><slot /><slot name="footer" /></div>' },
  NInputNumber: { template: '<input />' },
  useMessage: () => ({ error: vi.fn(), success: vi.fn() }),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn().mockResolvedValue(256000),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

function mountForSession(sessionId: string, sessionOverrides: Partial<ReturnType<typeof useChatStore>['sessions'][number]> = {}) {
  const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
  const chatStore = useChatStore()
  chatStore.sessions = [
    { id: sessionId, title: sessionId, source: 'cli', messages: [], createdAt: Date.now(), updatedAt: Date.now(), ...sessionOverrides },
  ]
  chatStore.activeSessionId = sessionId
  chatStore.activeSession = chatStore.sessions[0]
  return mount(ChatInput, { global: { plugins: [pinia] } })
}

describe('ChatInput draft persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores unsent text for the active session after the chat view is remounted', async () => {
    const wrapper = mountForSession('session-a')
    const textarea = wrapper.get('textarea')

    await textarea.setValue('draft before tab switch')
    await nextTick()
    wrapper.unmount()

    const remounted = mountForSession('session-a')
    await nextTick()

    expect((remounted.get('textarea').element as HTMLTextAreaElement).value).toBe('draft before tab switch')
  })

  it('stores drafts under one localStorage key mapped by session id', async () => {
    const wrapperA = mountForSession('session-a')
    await wrapperA.get('textarea').setValue('draft for session a')
    await nextTick()
    wrapperA.unmount()

    const wrapperB = mountForSession('session-b')
    await wrapperB.get('textarea').setValue('draft for session b')
    await nextTick()
    wrapperB.unmount()

    expect(localStorage.getItem('hermes_chat_input_draft_v1')).toBeNull()
    expect(JSON.parse(localStorage.getItem('hermes_chat_input_drafts_v1') || '{}')).toEqual({
      'session-a': 'draft for session a',
      'session-b': 'draft for session b',
    })

    const remountedA = mountForSession('session-a')
    await nextTick()
    expect((remountedA.get('textarea').element as HTMLTextAreaElement).value).toBe('draft for session a')
  })

  it('hides context usage for coding-agent sessions', async () => {
    const wrapper = mountForSession('session-codex', {
      source: 'coding_agent',
      agent: 'codex',
      codingAgentId: 'codex',
      inputTokens: 1200,
      outputTokens: 800,
      contextTokens: 2000,
    })
    await nextTick()

    expect(wrapper.find('.context-info').exists()).toBe(false)
    expect(wrapper.find('.context-bar').exists()).toBe(false)
  })
})
