// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createTestingPinia } from '@pinia/testing'
import { nextTick } from 'vue'

const listHandoffsMock = vi.hoisted(() => vi.fn())
const messageApi = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'groupChat.activityStep') return `${params?.step}/${params?.total}`
      if (key === 'groupChat.stopReply') return `Stop ${params?.agent}`
      if (key === 'groupChat.stopHandoff') return 'Stop relay'
      return key
    },
  }),
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), resolve: vi.fn(() => ({ href: '/' })) }) }
})

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => messageApi,
    useDialog: () => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() }),
  }
})

vi.mock('@/api/hermes/group-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/hermes/group-chat')>()
  return { ...actual, listHandoffs: listHandoffsMock }
})

import GroupChatPanel from '@/components/hermes/group-chat/GroupChatPanel.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'

function handoff(overrides: Record<string, unknown>) {
  return {
    id: 'job-1',
    roomId: 'room-1',
    chainId: 'chain-1',
    sourceMessageId: 'message-1',
    targetAgentId: 'agent-a',
    depth: 0,
    kind: 'fixed',
    chainOrderJson: '["agent-a","agent-b"]',
    status: 'running',
    attemptCount: 1,
    lastError: '',
    createdAt: 1,
    updatedAt: 1,
    completedAt: 0,
    ...overrides,
  }
}

function mountPanel(jobs: Record<string, unknown>[] = []) {
  listHandoffsMock.mockResolvedValue({ jobs })
  const pinia = createTestingPinia({ stubActions: true, createSpy: vi.fn })
  const store = useGroupChatStore(pinia)
  store.currentRoomId = 'room-1'
  store.rooms = [{ id: 'room-1', name: 'Activity room', workspace: '', canManage: true } as any]
  store.agents = [
    { roomId: 'room-1', agentId: 'agent-a', profile: 'a', name: 'Alpha' } as any,
    { roomId: 'room-1', agentId: 'agent-b', profile: 'b', name: 'Beta' } as any,
    { roomId: 'room-1', agentId: 'agent-c', profile: 'c', name: 'Gamma' } as any,
  ]
  const wrapper = shallowMount(GroupChatPanel, {
    global: { plugins: [pinia], stubs: { Transition: false } },
  })
  return { wrapper, store }
}

describe('GroupChatPanel Activity Dock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.innerWidth = 1280
    window.localStorage.clear()
  })

  it('merges relay and reply activity without duplicating the active relay participant', async () => {
    const { wrapper, store } = mountPanel([
      handoff({ id: 'job-running', targetAgentId: 'agent-a', depth: 0, status: 'running' }),
      handoff({ id: 'job-pending', targetAgentId: 'agent-b', depth: 1, status: 'pending' }),
      handoff({ id: 'job-terminal', chainId: 'finished-chain', targetAgentId: 'agent-c', status: 'completed' }),
    ])
    store.contextStatuses.set('agent-a', { agentId: 'agent-a', agentName: 'Alpha', status: 'replying' })
    store.contextStatuses.set('agent-c', { agentId: 'agent-c', agentName: 'Gamma', status: 'replying' })
    store.contextStatuses.set('agent-d', { agentId: 'agent-d', agentName: 'Delta', status: 'replying' })
    await flushPromises()
    await nextTick()

    expect(wrapper.findAll('.activity-dock')).toHaveLength(1)
    expect(wrapper.find('.handoff-status-panel').exists()).toBe(false)
    expect(wrapper.find('.status-bar').exists()).toBe(false)
    expect(wrapper.findAll('.activity-dock-relay')).toHaveLength(1)
    expect(wrapper.findAll('.activity-dock-reply')).toHaveLength(2)
    expect(wrapper.find('.activity-dock-relay').text()).toContain('1/2')
    expect(wrapper.find('.activity-dock-reply').text()).toContain('Gamma')
    expect(wrapper.find('.activity-dock-reply').text()).not.toContain('Alpha')
    expect(wrapper.findAll('.activity-dock-reply')[1].text()).toContain('Delta')
    expect(wrapper.find('.activity-dock-live').attributes('aria-live')).toBe('polite')
    expect(wrapper.find('.activity-dock-live button').exists()).toBe(false)

    wrapper.unmount()
  })

  it('provides keyboard buttons for progress, the whole relay, and each ordinary reply', async () => {
    const { wrapper, store } = mountPanel([
      handoff({ id: 'job-running', targetAgentId: 'agent-a', depth: 0, status: 'running' }),
    ])
    store.contextStatuses.set('agent-c', { agentId: 'agent-c', agentName: 'Gamma', status: 'replying' })
    await flushPromises()
    await nextTick()

    const progress = wrapper.find('.activity-dock-progress-button')
    expect(progress.attributes('aria-expanded')).toBe('false')
    await progress.trigger('click')
    expect(progress.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('#activity-dock-chain-chain-1').exists()).toBe(true)

    await wrapper.find('.activity-dock-stop-relay').trigger('click')
    await flushPromises()
    expect(store.interruptHandoffChain).toHaveBeenCalledWith('chain-1')
    expect(store.interruptAgent).not.toHaveBeenCalledWith('agent-a')
    expect(store.interruptAgent).not.toHaveBeenCalledWith('agent-b')

    await wrapper.find('.activity-dock-stop-reply').trigger('click')
    await flushPromises()
    expect(store.interruptAgent).toHaveBeenCalledWith('agent-c')

    wrapper.unmount()
  })
})
