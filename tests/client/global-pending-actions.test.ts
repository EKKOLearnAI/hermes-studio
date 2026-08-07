// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, reactive } from 'vue'

const chatState = reactive({
  activeSessionId: 'session-a' as string | null,
  pendingApprovals: new Map<string, any>(),
  pendingClarifies: new Map<string, any>(),
  sessions: [] as any[],
  respondApprovalFor: vi.fn(),
  respondToClarifyFor: vi.fn(),
})
const groupState = reactive({
  currentRoomId: 'room-a' as string | null,
  pendingApprovals: new Map<string, any>(),
  rooms: [] as any[],
  respondApprovalFor: vi.fn(),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(),
})
const profileState = reactive({ activeProfileName: 'default' as string | null })
const routeState = reactive({ name: 'hermes.chat' as string })
const created: any[] = []
const workflowMock = vi.hoisted(() => ({
  statusHandlers: [] as Array<(status: any) => void>,
  approveWorkflowNode: vi.fn(),
  listWorkflowsSocket: vi.fn(async () => [{ id: 'workflow-b', name: 'Workflow B' }]),
  subscribeWorkflowStatuses: vi.fn(async () => []),
}))

vi.mock('@/stores/hermes/chat', () => ({ useChatStore: () => chatState }))
vi.mock('@/stores/hermes/group-chat', () => ({ useGroupChatStore: () => groupState }))
vi.mock('@/stores/hermes/profiles', () => ({ useProfilesStore: () => profileState }))
vi.mock('vue-router', () => ({ useRoute: () => routeState }))
vi.mock('@/api/hermes/workflows', () => ({ approveWorkflowNode: workflowMock.approveWorkflowNode }))
vi.mock('@/api/hermes/workflow-socket', () => ({
  listWorkflowsSocket: workflowMock.listWorkflowsSocket,
  subscribeWorkflowStatuses: workflowMock.subscribeWorkflowStatuses,
  disconnectWorkflowSocket: vi.fn(),
  onWorkflowStatusUpdated: vi.fn((handler: (status: any) => void) => { workflowMock.statusHandlers.push(handler); return () => undefined }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('naive-ui', async () => {
  const button = defineComponent({ name: 'NButton', emits: ['click'], template: '<button @click="$emit(\'click\')"><slot /></button>' })
  const input = defineComponent({ name: 'NInput', props: ['value'], emits: ['update:value'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" />' })
  return {
    NButton: button,
    NInput: input,
    useMessage: () => ({ error: vi.fn() }),
    useNotification: () => ({
      create: vi.fn((options: any) => {
        const entry = { options, destroy: vi.fn() }
        created.push(entry)
        return entry
      }),
    }),
  }
})

import GlobalPendingActions from '@/components/layout/GlobalPendingActions.vue'

async function render(node: (() => any) | undefined) {
  const component = defineComponent({ setup: () => () => node?.() })
  return mount(component)
}

describe('GlobalPendingActions', () => {
  beforeEach(() => {
    created.splice(0)
    chatState.pendingApprovals = new Map()
    chatState.pendingClarifies = new Map()
    chatState.sessions = []
    chatState.activeSessionId = 'session-a'
    groupState.pendingApprovals = new Map()
    groupState.rooms = []
    groupState.currentRoomId = 'room-a'
    profileState.activeProfileName = 'default'
    routeState.name = 'hermes.chat'
    vi.clearAllMocks()
    workflowMock.statusHandlers.splice(0)
  })

  it('does not duplicate the existing in-context approval for the active session', async () => {
    chatState.pendingApprovals = new Map([['session-a', {
      sessionId: 'session-a', approvalId: 'approval-a', description: 'Run', command: 'pwd', choices: ['once'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(created).toHaveLength(0)
  })

  it('shows a stored active-session approval globally when the chat route is not visible', async () => {
    routeState.name = 'hermes.workflow'
    chatState.pendingApprovals = new Map([['session-a', {
      sessionId: 'session-a', approvalId: 'approval-a', description: 'Run', command: 'pwd', choices: ['once'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(created.some(entry => String(entry.options.title).includes('session-a'))).toBe(true)
  })

  it('shows and directly handles an approval from an inactive chat session', async () => {
    chatState.sessions = [{ id: 'session-a', title: 'A' }, { id: 'session-b', title: 'B' }]
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Run command', command: 'pwd', choices: ['once', 'deny'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const approvalNotification = created.find(entry => String(entry.options.title).includes('B'))
    expect(approvalNotification).toBeTruthy()
    const action = await render(approvalNotification.options.action)
    await action.get('button').trigger('click')
    expect(chatState.respondApprovalFor).toHaveBeenCalledWith('session-b', 'approval-b', 'once')
  })

  it('submits a clarify response from the global notification', async () => {
    chatState.sessions = [{ id: 'session-b', title: 'B' }]
    chatState.pendingClarifies = new Map([['session-b', {
      sessionId: 'session-b', clarifyId: 'clarify-b', question: 'Which environment?', choices: null,
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    const content = await render(created[0].options.content)
    await content.get('input').setValue('staging')
    const action = await render(created[0].options.action)
    await action.get('button').trigger('click')
    expect(chatState.respondToClarifyFor).toHaveBeenCalledWith('session-b', 'clarify-b', 'staging')
  })

  it('handles a group-room approval without navigating to that room', async () => {
    groupState.rooms = [{ id: 'room-b', name: 'Room B' }]
    groupState.pendingApprovals = new Map([['approval-b', {
      roomId: 'room-b', approvalId: 'approval-b', agentName: 'Builder', description: 'Install package', command: 'npm ci', choices: ['once', 'deny'],
    }]])

    mount(GlobalPendingActions)
    await nextTick()

    expect(groupState.connect).toHaveBeenCalled()
    expect(created[0].options.title).toContain('Room B')
    const action = await render(created[0].options.action)
    await action.get('button').trigger('click')
    expect(groupState.respondApprovalFor).toHaveBeenCalledWith('room-b', 'approval-b', 'once')
  })

  it('destroys a global notification when the authoritative pending entry resolves', async () => {
    chatState.pendingApprovals = new Map([['session-b', {
      sessionId: 'session-b', approvalId: 'approval-b', description: 'Run', command: 'pwd', choices: ['once'],
    }]])
    mount(GlobalPendingActions)
    await nextTick()
    const instance = created[0]

    chatState.pendingApprovals = new Map()
    await nextTick()

    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('directly approves a pending workflow node from the global notification', async () => {
    mount(GlobalPendingActions)
    await nextTick()
    workflowMock.statusHandlers[0]({
      workflowId: 'workflow-b', runId: 'run-b', status: 'pending_approval',
      nodeStatuses: { build: 'pending_approval' },
      run: { node_sessions: [{ node_id: 'build', execution_id: 'exec-b', status: 'blocked' }] },
    })
    await nextTick()

    const workflowNotification = created.find(entry => String(entry.options.title).includes('Workflow B'))
    expect(workflowNotification).toBeTruthy()
    const action = await render(workflowNotification.options.action)
    const buttons = action.findAll('button')
    await buttons[buttons.length - 1].trigger('click')
    expect(workflowMock.approveWorkflowNode).toHaveBeenCalledWith('workflow-b', 'run-b', 'build', true, 'exec-b')
  })

  it('resubscribes workflow approvals when the active profile changes', async () => {
    mount(GlobalPendingActions)
    await nextTick()
    workflowMock.subscribeWorkflowStatuses.mockClear()

    profileState.activeProfileName = 'research'
    await nextTick()

    expect(workflowMock.subscribeWorkflowStatuses).toHaveBeenCalledWith(undefined, 'research')
  })
})
