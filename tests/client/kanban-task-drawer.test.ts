// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const mockGetTask = vi.hoisted(() => vi.fn())
const mockRequest = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockAssignTask = vi.hoisted(() => vi.fn())
const mockRouterPush = vi.hoisted(() => vi.fn())
const mockUseMessage = vi.hoisted(() => vi.fn(() => ({
  success: vi.fn(),
  error: vi.fn(),
})))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({
    push: mockRouterPush,
  }),
}))

vi.mock('@/api/client', () => ({
  request: mockRequest,
}))

vi.mock('@/api/hermes/kanban', () => ({
  getTask: mockGetTask,
}))

vi.mock('@/stores/hermes/kanban', () => ({
  useKanbanStore: () => ({
    selectedBoard: 'project-a',
    assignees: [{ name: 'alice', counts: { todo: 1 } }, { name: 'bob', counts: { ready: 1 } }],
    completeTasks: mockCompleteTasks,
    blockTask: mockBlockTask,
    unblockTasks: mockUnblockTasks,
    assignTask: mockAssignTask,
  }),
}))

vi.mock('@/components/hermes/chat/HistoryMessageList.vue', () => ({
  default: defineComponent({
    name: 'HistoryMessageList',
    props: { session: { type: Object, required: false } },
    template: '<div class="history-message-list-stub">{{ session ? session.id : "none" }}</div>',
  }),
}))

vi.mock('naive-ui', () => ({
  NDrawer: defineComponent({
    name: 'NDrawer',
    props: { show: { type: Boolean, required: false } },
    emits: ['update:show'],
    template: '<div class="n-drawer-stub"><slot /></div>',
  }),
  NDrawerContent: defineComponent({
    name: 'NDrawerContent',
    props: { title: { type: String, required: false }, closable: { type: Boolean, required: false } },
    template: '<div class="n-drawer-content-stub"><slot /></div>',
  }),
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    template: '<button class="n-button-stub" @click="$emit(\'click\')"><slot /></button>',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    props: { value: { required: false }, options: { type: Array, default: () => [] } },
    emits: ['update:value'],
    template: '<select class="n-select-stub" @change="$emit(\'update:value\', $event.target.value || null)"><option value=""></option><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    props: { value: { required: false }, size: { type: String, required: false }, placeholder: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
  NModal: defineComponent({
    name: 'NModal',
    props: { show: { type: Boolean, required: false }, title: { type: String, required: false } },
    emits: ['close'],
    template: '<div v-if="show" class="n-modal-stub" :data-title="title"><slot /></div>',
  }),
  useMessage: mockUseMessage,
}))

import KanbanTaskDrawer from '@/components/hermes/kanban/KanbanTaskDrawer.vue'

describe('KanbanTaskDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequest.mockResolvedValue({ results: [] })
    mockCompleteTasks.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockUnblockTasks.mockResolvedValue(undefined)
    mockAssignTask.mockResolvedValue(undefined)
    mockGetTask.mockResolvedValue({
      task: {
        id: 'task-1',
        title: 'Ship kanban',
        body: 'Implement feature',
        assignee: 'alice',
        status: 'done',
        priority: 2,
        created_at: 100,
        started_at: 110,
        completed_at: 120,
        tenant: null,
        result: 'Done summary',
      },
      latest_summary: 'Done summary',
      comments: [],
      events: [],
      runs: [{ id: 1, profile: 'alice', status: 'done', started_at: 110, ended_at: 120 }],
      session: {
        id: 'session-1',
        title: 'Hermes session',
        source: 'codex',
        model: 'gpt-5.5',
        started_at: 110,
        ended_at: 120,
        messages: [
          { id: 'm1', role: 'user', content: 'hello', timestamp: 111 },
          { id: 'm2', role: 'assistant', content: 'world', timestamp: 112 },
          { id: 'm3', role: 'tool', content: 'ignore', timestamp: 113 },
        ],
      },
    })
  })

  it('renders completed-result messages through HistoryMessageList', async () => {
    const wrapper = mount(KanbanTaskDrawer, {
      props: { taskId: 'task-1' },
    })

    await flushPromises()

    await wrapper.find('.result-summary').trigger('click')
    await flushPromises()

    const modal = wrapper.find('.n-modal-stub')
    expect(modal.exists()).toBe(true)
    expect(modal.attributes('data-title')).toBe('Ship kanban')

    const history = wrapper.find('.history-message-list-stub')
    expect(history.exists()).toBe(true)
    expect(history.text()).toBe('session-1')

    const sessionProp = wrapper.getComponent({ name: 'HistoryMessageList' }).props('session') as any
    expect(sessionProp.messages).toEqual([
      { id: 'm1', role: 'user', content: 'hello', timestamp: 111 },
      { id: 'm2', role: 'assistant', content: 'world', timestamp: 112 },
    ])
  })

  it('uses the latest run profile when searching related sessions', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-2',
        title: 'Retry task',
        body: null,
        assignee: 'bob',
        status: 'running',
        priority: 2,
        created_at: 100,
        started_at: 110,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [
        { id: 1, profile: 'stale', status: 'failed', started_at: 110, ended_at: 120 },
        { id: 2, profile: 'fresh', status: 'running', started_at: 130, ended_at: null },
      ],
    })
    mockRequest.mockResolvedValueOnce({
      results: [{ id: 'session-2', title: 'Found session', source: 'codex', model: 'gpt-5.5', started_at: 130 }],
    })

    const wrapper = mount(KanbanTaskDrawer, { props: { taskId: 'task-2' } })
    await flushPromises()

    const sessionsTitle = wrapper.findAll('.section-title').find(node => node.text() === 'kanban.detail.sessions')
    await sessionsTitle?.trigger('click')
    await flushPromises()

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/kanban/search-sessions?task_id=task-2&profile=fresh&board=project-a')
    await wrapper.find('.session-item').trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith({ name: 'hermes.chat', query: { session: 'session-2' } })
  })

  it('executes complete, block, unblock, and assign actions', async () => {
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-0',
        title: 'Todo task',
        body: null,
        assignee: null,
        status: 'todo',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    const wrapper = mount(KanbanTaskDrawer, {
      props: { taskId: 'task-0' },
    })
    await flushPromises()

    const buttons = wrapper.findAll('.n-button-stub')
    await buttons.find(node => node.text() === 'kanban.action.complete')?.trigger('click')
    await wrapper.find('.n-input-stub').setValue('done summary')
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'common.ok')?.trigger('click')
    await flushPromises()
    expect(mockCompleteTasks).toHaveBeenCalledWith(['task-0'], 'done summary')

    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-3',
        title: 'Blocked task',
        body: null,
        assignee: 'alice',
        status: 'blocked',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    await wrapper.setProps({ taskId: 'task-3' })
    await flushPromises()
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.unblock')?.trigger('click')
    expect(mockUnblockTasks).toHaveBeenCalledWith(['task-3'])

    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-4',
        title: 'Todo task',
        body: null,
        assignee: null,
        status: 'todo',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    mockGetTask.mockResolvedValueOnce({
      task: {
        id: 'task-4',
        title: 'Todo task',
        body: null,
        assignee: 'bob',
        status: 'todo',
        priority: 1,
        created_at: 100,
        started_at: null,
        completed_at: null,
        tenant: null,
        result: null,
      },
      latest_summary: null,
      comments: [],
      events: [],
      runs: [],
    })
    await wrapper.setProps({ taskId: 'task-4' })
    await flushPromises()
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.block')?.trigger('click')
    await wrapper.find('.n-input-stub').setValue('waiting dependency')
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'common.ok')?.trigger('click')
    expect(mockBlockTask).toHaveBeenCalledWith('task-4', 'waiting dependency')

    const select = wrapper.find('.n-select-stub')
    await select.setValue('bob')
    await wrapper.findAll('.n-button-stub').find(node => node.text() === 'kanban.action.assign')?.trigger('click')
    await flushPromises()
    expect(mockAssignTask).toHaveBeenCalledWith('task-4', 'bob')
  })
})
