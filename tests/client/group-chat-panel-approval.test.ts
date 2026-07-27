// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowMount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { defineComponent, nextTick } from 'vue'

const messageApi = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({ push: vi.fn() }),
  }
})

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => messageApi,
  }
})

import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

const NButtonStub = defineComponent({
  name: 'NButton',
  emits: ['click'],
  template: '<button class="n-button-stub" type="button" @click="$emit(\'click\')"><slot /></button>',
})

describe('GroupChatPanel approval capability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.innerWidth = 1280
    window.localStorage.clear()
  })

  it('lets an approval responder act without room.manage', async () => {
    const pinia = createTestingPinia({ stubActions: true, createSpy: vi.fn })
    const store = useGroupChatStore(pinia)
    store.currentRoomId = 'room-1'
    store.rooms = [{
      id: 'room-1',
      name: 'Approval room',
      canManage: false,
      canApprove: true,
    } as any]
    store.pendingApprovals.set('approval-1', {
      roomId: 'room-1',
      agentName: 'Worker',
      approvalId: 'approval-1',
      command: 'npm test',
      description: 'Run tests',
      choices: ['once', 'deny'],
      allowPermanent: false,
      isMemoryWrite: false,
      requestedAt: Date.now(),
    })

    const wrapper = shallowMount(GroupChatPanel, {
      global: {
        plugins: [pinia],
        stubs: {
          Transition: false,
          NButton: NButtonStub,
          'n-button': NButtonStub,
          Button: NButtonStub,
        },
      },
    })
    await nextTick()

    expect(wrapper.find('.approval-float-panel').exists()).toBe(true)
    const actions = wrapper.findAll('.approval-float-actions button')
    expect(actions).toHaveLength(2)
    await actions[0].trigger('click')

    expect(store.respondApproval).toHaveBeenCalledOnce()
    expect(store.respondApproval).toHaveBeenCalledWith('once')
  })
})
