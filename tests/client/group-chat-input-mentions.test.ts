// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'
import GroupChatInput from '@/components/hermes/group-chat/GroupChatInput.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('naive-ui', () => ({
  NButton: { template: '<button type="button" v-bind="$attrs"><slot /><slot name="icon" /></button>' },
  NTooltip: { template: '<div><slot name="trigger" /><slot /></div>' },
  NSwitch: { template: '<button type="button"></button>' },
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: { value: true }, toggleToolTraceVisible: vi.fn() }),
}))

describe('GroupChatInput mentions', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('updates mention suggestions after the textarea has a custom height', async () => {
    const pinia = createTestingPinia({ stubActions: false, createSpy: vi.fn })
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
})
