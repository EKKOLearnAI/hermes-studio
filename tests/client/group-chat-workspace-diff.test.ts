// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import GroupMessageItem from '@/components/hermes/group-chat/GroupMessageItem.vue'
import GroupMessageList from '@/components/hermes/group-chat/GroupMessageList.vue'
import type { ChatMessage, GroupWorkspaceDiffPayload } from '@/api/hermes/group-chat'

const toolTraceVisibleState = vi.hoisted(() => ({ value: true }))

const groupChatApiMock = vi.hoisted(() => {
  const socket: any = {
    id: 'socket-1',
    connected: true,
    on: vi.fn(() => socket),
    once: vi.fn(() => socket),
    off: vi.fn(() => socket),
    emit: vi.fn((event: string, _payload: unknown, ack?: Function) => {
      if (event === 'join') {
        ack?.({
          roomId: 'room-1',
          roomName: 'Room 1',
          messages: [],
          agents: [],
          members: [],
          typingUsers: [],
          contextStatuses: [],
        })
      }
      return socket
    }),
  }
  return {
    socket,
    connectGroupChat: vi.fn(() => socket),
    disconnectGroupChat: vi.fn(),
    getSocket: vi.fn(() => socket),
    getStoredUserId: vi.fn(() => 'user-1'),
    getStoredUserName: vi.fn(() => 'tester'),
    createRoom: vi.fn(),
    listRooms: vi.fn(),
    getRoomDetail: vi.fn(),
    joinRoomByCode: vi.fn(),
    addAgent: vi.fn(),
    listAgents: vi.fn(),
    removeAgent: vi.fn(),
    cloneRoom: vi.fn(),
    deleteRoom: vi.fn(),
    clearRoomContext: vi.fn(),
    updateInviteCode: vi.fn(),
    updateRoomWorkspace: vi.fn(),
  }
})

vi.mock('@/api/hermes/group-chat', () => groupChatApiMock)
vi.mock('@/api/client', () => ({
  getApiKey: vi.fn(() => 'token'),
  getActiveProfileName: vi.fn(() => 'default'),
  getStoredUsername: vi.fn(() => null),
}))
vi.mock('@/api/auth', () => ({ fetchCurrentUser: vi.fn(async () => { throw new Error('no user') }) }))
vi.mock('@/api/hermes/download', () => ({ getDownloadUrl: vi.fn((path: string) => `/download?path=${path}`) }))
vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({ toolTraceVisible: toolTraceVisibleState, toggleToolTraceVisible: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}))

const payload: GroupWorkspaceDiffPayload = {
  kind: 'workspace_diff',
  version: 1,
  room_id: 'room-1',
  session_id: 'session-1',
  run_id: '0123456789abcdef0123456789abcdef',
  status: 'completed',
  change_id: 'change-1',
  workspace_basename: 'repo',
  workspace: '/tmp/repo',
  files_changed: 2,
  additions: 3,
  deletions: 1,
  truncated: false,
  files: [
    { id: 1, path: 'src/a.ts', change_type: 'modified', additions: 2, deletions: 1, patch: 'diff --git a/src/a.ts b/src/a.ts\n-old\n+new\n', binary: false, truncated: false },
    { id: 2, path: 'asset.bin', change_type: 'added', additions: 0, deletions: 0, patch: null, binary: true, truncated: false },
  ],
}

function assistantMessage(): ChatMessage {
  return {
    id: 'assistant-1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'Worker',
    content: 'Finished the workspace update.',
    timestamp: 1,
    role: 'assistant',
  }
}

function workspaceDiffMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'diff-1',
    roomId: 'room-1',
    senderId: 'agent-1',
    senderName: 'Worker',
    content: JSON.stringify(payload),
    timestamp: 1,
    role: 'tool',
    tool_call_id: `workspace_diff:${payload.run_id}`,
    tool_name: 'workspace_diff',
    ...overrides,
  }
}

describe('group chat workspace diff client rendering', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    toolTraceVisibleState.value = true
    vi.clearAllMocks()
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { addEventListener: vi.fn(), removeEventListener: vi.fn(), getVoices: vi.fn(() => []), speak: vi.fn(), cancel: vi.fn(), pause: vi.fn(), resume: vi.fn() },
    })
  })

  it('maps persisted workspace_diff tool JSON to a structured tool result', async () => {
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room: { id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '/tmp/repo' },
      messages: [workspaceDiffMessage()],
      agents: [],
      members: [],
    })
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()

    await store.joinRoom('room-1')

    expect(store.sortedMessages[0]).toMatchObject({
      role: 'tool',
      toolName: 'workspace_diff',
      toolResult: expect.objectContaining({ kind: 'workspace_diff', files_changed: 2 }),
    })
  })

  it('attaches persisted and realtime workspace diffs to their exact assistant message', async () => {
    groupChatApiMock.getRoomDetail.mockResolvedValue({
      room: { id: 'room-1', name: 'Room 1', inviteCode: null, workspace: '/tmp/repo' },
      messages: [
        assistantMessage(),
        workspaceDiffMessage({
          content: JSON.stringify({ ...payload, parent_message_id: 'assistant-1' }),
          timestamp: 2,
        }),
      ],
      agents: [],
      members: [],
    })
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()

    await store.joinRoom('room-1')

    expect(store.sortedMessages).toHaveLength(1)
    expect(store.sortedMessages[0]).toMatchObject({
      id: 'assistant-1',
      role: 'assistant',
      workspaceChanges: [expect.objectContaining({ change_id: 'change-1' })],
    })

    store.messages = [assistantMessage()]
    store.messages.push(workspaceDiffMessage({
      content: JSON.stringify({ ...payload, parent_message_id: 'assistant-1' }),
      timestamp: 2,
    }))

    expect(store.sortedMessages).toHaveLength(1)
    expect(store.sortedMessages[0].workspaceChanges?.[0]?.change_id).toBe('change-1')
  })

  it('renders an associated workspace diff inside the assistant message', async () => {
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          ...assistantMessage(),
          workspaceChanges: [{ ...payload, parent_message_id: 'assistant-1' }],
        },
        agents: [{ id: 'a1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0 }],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    expect(wrapper.find('.tool-message').exists()).toBe(false)
    expect(wrapper.find('.assistant-workspace-change').exists()).toBe(true)
    expect(wrapper.text()).toContain('chat.changesThisTurn')

    await wrapper.find('.tool-change-card-header').trigger('click')
    expect(wrapper.find('.tool-change-file-row').text()).toContain('a.ts')
  })

  it('renders a workspace diff card collapsed by default and expands it on demand', async () => {
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          ...workspaceDiffMessage(),
          toolName: 'workspace_diff',
          toolResult: payload,
          toolStatus: 'done',
        },
        agents: [],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    expect(wrapper.find('.tool-change-card').exists()).toBe(true)
    expect(wrapper.find('.tool-change-files').exists()).toBe(false)
    expect(wrapper.find('.tool-change-card-header').attributes('aria-expanded')).toBe('false')

    await wrapper.find('.tool-change-card-header').trigger('click')

    expect(wrapper.find('.tool-change-card-header').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.tool-change-file-row').text()).toContain('a.ts')
    expect(wrapper.find('.tool-line').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('"kind"')

    await wrapper.find('.tool-change-file-row').trigger('click')
    const { useToolPanelStore } = await import('@/stores/hermes/tool-panel')
    expect(useToolPanelStore().workspaceDiff).toMatchObject({
      patch: expect.stringContaining('+new'),
      editable: false,
      file: expect.objectContaining({ path: 'src/a.ts' }),
    })
  })

  it('keeps workspace diff audit cards visible when generic tool traces are hidden', async () => {
    toolTraceVisibleState.value = false
    const { useGroupChatStore } = await import('@/stores/hermes/group-chat')
    const store = useGroupChatStore()
    store.currentRoomId = 'room-1'
    store.messages = [
      {
        ...workspaceDiffMessage(),
        toolName: 'workspace_diff',
        toolResult: payload,
        toolStatus: 'done',
      },
      {
        id: 'tool-1',
        roomId: 'room-1',
        senderId: 'agent-1',
        senderName: 'Worker',
        content: '{}',
        timestamp: 2,
        role: 'tool',
        tool_name: 'shell',
        toolName: 'shell',
        toolStatus: 'done',
      } as ChatMessage,
    ]

    const wrapper = mount(GroupMessageList, {
      global: {
        stubs: {
          GroupMessageItem: true,
          VirtualMessageList: {
            name: 'VirtualMessageList',
            props: ['messages'],
            methods: {
              scrollToBottom() {},
              isNearBottom() { return true },
              captureScrollPosition() { return null },
              restoreScrollPosition() {},
            },
            template: '<div><slot v-for="message in messages" name="item" :message="message" /></div>',
          },
        },
      },
    })

    const messages = wrapper.getComponent({ name: 'VirtualMessageList' }).props('messages') as ChatMessage[]
    expect(messages.map(message => message.id)).toEqual(['diff-1'])
  })

  it('hands previewable group attachments to the shared file panel instead of downloading', async () => {
    const previewRequests: Array<{ path: string; fileName: string }> = []
    const handlePreview = (event: Event) => {
      const customEvent = event as CustomEvent<{ path: string; fileName: string }>
      previewRequests.push(customEvent.detail)
      customEvent.preventDefault()
    }
    window.addEventListener('hermes:preview-workspace-file', handlePreview)
    const wrapper = mount(GroupMessageItem, {
      props: {
        message: {
          id: 'file-1',
          roomId: 'room-1',
          senderId: 'agent-1',
          senderName: 'Worker',
          content: JSON.stringify([{ type: 'file', name: 'sales-data.xlsx', path: '/tmp/repo/sales-data.xlsx' }]),
          timestamp: 1,
          role: 'assistant',
        },
        agents: [{ id: 'a1', roomId: 'room-1', agentId: 'agent-1', profile: 'default', name: 'Worker', description: '', invited: 0 }],
        members: [],
        currentUserId: 'user-1',
      },
      global: { stubs: { MarkdownRenderer: true, ProfileAvatar: true } },
    })

    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      wrapper.get('.msg-attachment-file').element.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
      expect(previewRequests).toEqual([{ path: '/tmp/repo/sales-data.xlsx', fileName: 'sales-data.xlsx' }])
    } finally {
      wrapper.unmount()
      window.removeEventListener('hermes:preview-workspace-file', handlePreview)
    }
  })
})
