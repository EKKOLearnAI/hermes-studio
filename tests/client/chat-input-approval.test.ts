// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockChatStore = vi.hoisted(() => ({
  isStreaming: true,
  isAborting: false,
  activeSession: null as any,
  setAutoPlaySpeech: vi.fn(),
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
}))

vi.mock('../../packages/client/src/stores/hermes/chat', () => ({
  useChatStore: () => mockChatStore,
}))

vi.mock('../../packages/client/src/stores/hermes/app', () => ({
  useAppStore: () => ({ selectedModel: 'test-model' }),
}))

vi.mock('../../packages/client/src/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({ activeProfileName: 'default' }),
}))

vi.mock('../../packages/client/src/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(() => Promise.resolve(200000)),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', async (importActual) => {
  const actual = await importActual<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(),
      success: vi.fn(),
    }),
  }
})

import ChatInput from '../../packages/client/src/components/hermes/chat/ChatInput.vue'

function mountInput() {
  return mount(ChatInput, {
    global: {
      stubs: {
        NButton: {
          props: ['disabled'],
          emits: ['click'],
          template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot name="icon"/><slot /></button>',
        },
        NTooltip: {
          template: '<div><slot name="trigger"/><slot /></div>',
        },
        NSwitch: {
          props: ['value'],
          emits: ['update:value'],
          template: '<input type="checkbox" />',
        },
      },
    },
  })
}

describe('ChatInput approval commands while streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStore.isStreaming = true
    mockChatStore.isAborting = false
  })

  it('allows /approve to be submitted while a run is streaming', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('/approve')

    const buttons = wrapper.findAll('button')
    const sendButton = buttons[buttons.length - 1]
    expect(sendButton.attributes('disabled')).toBeUndefined()

    await sendButton.trigger('click')
    expect(mockChatStore.sendMessage).toHaveBeenCalledWith('/approve', undefined)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('allows ordinary messages while streaming so the run queue can handle them', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')
    await textarea.setValue('hello while busy')

    const buttons = wrapper.findAll('button')
    const sendButton = buttons[buttons.length - 1]
    expect(sendButton.attributes('disabled')).toBeUndefined()

    await textarea.trigger('keydown', { key: 'Enter' })
    expect(mockChatStore.sendMessage).toHaveBeenCalledWith('hello while busy', undefined)
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
  })

  it('allows session/always/all approval commands while streaming', async () => {
    const wrapper = mountInput()
    const textarea = wrapper.find('textarea')

    await textarea.setValue('/approve session')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(mockChatStore.sendMessage).toHaveBeenLastCalledWith('/approve session', undefined)

    await textarea.setValue('/approve always')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(mockChatStore.sendMessage).toHaveBeenLastCalledWith('/approve always', undefined)

    await textarea.setValue('/deny all')
    await textarea.trigger('keydown', { key: 'Enter' })
    expect(mockChatStore.sendMessage).toHaveBeenLastCalledWith('/deny all', undefined)
  })
})
