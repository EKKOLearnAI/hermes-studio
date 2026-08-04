// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import GroupChatInput from '@/components/hermes/group-chat/GroupChatInput.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import { useSettingsStore } from '@/stores/hermes/settings'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
  NDropdown: { template: '<div><slot /></div>' },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

describe('GroupChatInput mentions', () => {
  beforeEach(() => {
    localStorage.clear()
    window.innerWidth = 1024
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:group-attachment'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })
  })

  it('adds a pasted non-image file to the attachment list', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const file = new File(['hello'], 'group-notes.txt', { type: 'text/plain' })
    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
        files: [file],
      },
    })

    wrapper.get('textarea').element.dispatchEvent(paste)
    await nextTick()

    expect(paste.defaultPrevented).toBe(true)
    expect(wrapper.get('.attachment-file').text()).toContain('group-notes.txt')
  })

  it('updates mention suggestions after the textarea has a custom height', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.agents = [{ id: 'agent-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-1', description: '', invited: 1 }]
    store.emitTyping = vi.fn()

    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    const textarea = wrapper.get('textarea')
    const resizeHandle = wrapper.get('.resize-handle')
    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    await textarea.setValue('@')
    await nextTick()
    expect(wrapper.find('.mention-dropdown').exists()).toBe(true)
    expect(wrapper.find('.mention-dropdown').text()).toContain('@Worker')
  })

  it('inserts an agent mention at the current cursor from the avatar action', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.emitTyping = vi.fn()
    const wrapper = mount(GroupChatInput, {
      attachTo: document.body,
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('老板喊你')
    ;(textarea.element as HTMLTextAreaElement).setSelectionRange(5, 5)
    ;(wrapper.vm as any).insertMention('codex')
    await nextTick()

    expect((textarea.element as HTMLTextAreaElement).value).toBe('老板喊你 @codex ')
    expect(document.activeElement).toBe(textarea.element)
    expect(store.emitTyping).toHaveBeenCalled()

    wrapper.unmount()
  })

  it('shows the active room reference outside the input and can cancel it', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.setMessageReference('room-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'A referenced group response',
      sender: 'Worker',
    })

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    await nextTick()

    expect(wrapper.get('.message-reference-preview').text()).toContain('A referenced group response')
    expect(wrapper.get('.message-reference-preview').element.parentElement?.classList.contains('input-wrapper')).toBe(false)

    await wrapper.get('.message-reference-remove').trigger('click')
    expect(store.activeMessageReference).toBeNull()
  })

  it('automatically mentions a valid quoted agent once', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.userId = 'human-1'
    store.agents = [{ id: 'row-1', agentId: 'agent-1', profile: 'worker', name: 'Worker', roomId: 'room-1', description: '', invited: 1 }]
    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    store.setMessageReference('room-1', {
      id: 'message-1',
      role: 'assistant',
      content: 'A referenced response',
      sender: 'Worker',
      senderId: 'agent-1',
    })
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('@Worker ')
    store.setMessageReference('room-1', {
      id: 'message-2',
      role: 'assistant',
      content: 'Another response',
      sender: 'Worker',
      senderId: 'agent-1',
    })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('@Worker ')
  })

  it('does not auto-mention self or an invalid quoted sender', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.userId = 'human-1'
    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    store.setMessageReference('room-1', {
      id: 'self',
      role: 'user',
      content: 'My message',
      sender: 'Me',
      senderId: 'human-1',
    })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')

    store.setMessageReference('room-1', {
      id: 'missing',
      role: 'assistant',
      content: 'Removed member',
      sender: 'Removed',
      senderId: 'removed-1',
    })
    await nextTick()
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('')
  })

  it('applies the configured desktop input height', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 168 }

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('168px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('231px')
  })

  it('applies display setting changes after a manual resize', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const resizeHandle = wrapper.get('.resize-handle')

    await resizeHandle.trigger('mousedown', { clientY: 100 })
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: 50 }))
    document.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()

    settingsStore.display.chat_input_height = 216
    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).toBe('216px')
    expect((wrapper.get('.input-wrapper').element as HTMLElement).style.minHeight).toBe('279px')
  })

  it('preserves mobile auto height when a desktop preference is configured', async () => {
    window.innerWidth = 640
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = { chat_input_height: 168 }

    const wrapper = mount(GroupChatInput, {
      global: { plugins: [pinia], stubs: { Transition: false } },
    })

    await nextTick()

    expect((wrapper.get('textarea').element as HTMLTextAreaElement).style.height).not.toBe('168px')
  })

  it('keeps the draft intact when room configuration blocks sending', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
    const settingsStore = useSettingsStore()
    settingsStore.display = {}
    const wrapper = mount(GroupChatInput, {
      props: { sendBlocked: true },
      global: { plugins: [pinia], stubs: { Transition: false } },
    })
    const textarea = wrapper.get('textarea')

    await textarea.setValue('@Worker keep this draft')
    await textarea.trigger('keydown', { key: 'Enter' })

    expect(wrapper.emitted('send-blocked')).toHaveLength(1)
    expect(wrapper.emitted('send')).toBeUndefined()
    expect((textarea.element as HTMLTextAreaElement).value).toBe('@Worker keep this draft')
  })
})
