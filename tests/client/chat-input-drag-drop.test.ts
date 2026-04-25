// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const mockChatStore = vi.hoisted(() => ({
  activeSession: null as Record<string, any> | null,
  isStreaming: false,
  sendMessage: vi.fn(),
  stopStreaming: vi.fn(),
}))

const mockAppStore = vi.hoisted(() => ({
  selectedModel: 'gpt-5.5',
}))

const mockProfilesStore = vi.hoisted(() => ({
  activeProfileName: 'default' as string | null,
}))

vi.mock('@/stores/hermes/chat', () => ({
  useChatStore: () => mockChatStore,
}))

vi.mock('@/stores/hermes/app', () => ({
  useAppStore: () => mockAppStore,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => mockProfilesStore,
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(async () => 200000),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'

function mountInput() {
  return mount(ChatInput, {
    global: {
      stubs: {
        NButton: {
          template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot name="icon" /><slot /></button>',
          props: ['disabled'],
        },
        NTooltip: {
          template: '<div><slot name="trigger" /><slot /></div>',
        },
      },
    },
  })
}

function fireDragEvent(
  element: Element,
  type: string,
  dataTransfer: Partial<DataTransfer>,
) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  Object.defineProperty(event, 'dataTransfer', {
    value: dataTransfer,
  })
  element.dispatchEvent(event)
  return event
}

describe('ChatInput drag-in attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChatStore.activeSession = null
    mockChatStore.isStreaming = false

    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:attachment'),
      revokeObjectURL: vi.fn(),
    })
  })

  it('shows the drag affordance when files enter anywhere in the window', async () => {
    const wrapper = mountInput()
    const composer = wrapper.find('.chat-input-area')

    fireDragEvent(document.body, 'dragenter', {
      types: ['Files'],
      files: [] as any,
    })
    await wrapper.vm.$nextTick()

    expect(composer.classes()).toContain('drag-over')
    expect(wrapper.find('.drop-overlay').exists()).toBe(true)
    expect(wrapper.text()).toContain('chat.dropFilesToAttach')
  })

  it('attaches files dropped anywhere in the window', async () => {
    const wrapper = mountInput()
    const composer = wrapper.find('.chat-input-area')
    const textFile = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    const imageFile = new File(['png'], 'diagram.png', { type: 'image/png' })

    fireDragEvent(document.body, 'drop', {
      types: ['Files'],
      files: [textFile, imageFile] as any,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('notes.txt')
    expect(wrapper.find('img[alt="diagram.png"]').exists()).toBe(true)
    expect(composer.classes()).not.toContain('drag-over')
  })

  it('attaches files even when an inner page element stops drag event bubbling', async () => {
    const wrapper = mountInput()
    const blocker = document.createElement('div')
    document.body.appendChild(blocker)
    blocker.addEventListener('drop', event => event.stopPropagation())

    const blockedFile = new File(['blocked'], 'blocked.txt', { type: 'text/plain' })
    fireDragEvent(blocker, 'drop', {
      types: ['Files'],
      files: [blockedFile] as any,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.text()).toContain('blocked.txt')
    blocker.remove()
  })

  it('ignores non-file drags over the window', async () => {
    const wrapper = mountInput()
    const composer = wrapper.find('.chat-input-area')

    fireDragEvent(document.body, 'dragenter', {
      types: ['text/plain'],
      files: [] as any,
    })
    await wrapper.vm.$nextTick()

    expect(composer.classes()).not.toContain('drag-over')
    expect(wrapper.find('.drop-overlay').exists()).toBe(false)
  })

  it('keeps existing duplicate-name attachment behavior for window drops', async () => {
    const wrapper = mountInput()
    const first = new File(['first'], 'same.txt', { type: 'text/plain' })
    const second = new File(['second'], 'same.txt', { type: 'text/plain' })

    fireDragEvent(document.body, 'drop', {
      types: ['Files'],
      files: [first, second] as any,
    })
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('.attachment-preview')).toHaveLength(1)
    expect(wrapper.text()).toContain('same.txt')
  })
})
