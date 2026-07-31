// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const routeState = vi.hoisted(() => ({
  query: { board: 'project-a' } as Record<string, string>,
}))

const routerReplace = vi.hoisted(() => vi.fn())

const storeState = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; title: string; status: string; created_at: number; assignee?: string | null }>,
  stats: { by_status: { todo: 1, done: 0 }, by_assignee: {}, total: 1 } as Record<string, any>,
  assignees: [] as Array<{ name: string; counts: Record<string, number> | null }>,
  activeBoards: [] as Array<{ slug: string; name: string; icon?: string; total?: number }>,
  loading: false,
  boardsLoading: false,
  selectedBoard: 'default',
  boardWarning: null as string | null,
  capabilities: null as Record<string, any> | null,
  filterStatus: null as string | null,
  filterAssignee: null as string | null,
}))

const mockFetchBoards = vi.hoisted(() => vi.fn())
const mockFetchCapabilities = vi.hoisted(() => vi.fn())
const mockRefreshAll = vi.hoisted(() => vi.fn())
const mockFetchTasks = vi.hoisted(() => vi.fn())
const mockFetchStats = vi.hoisted(() => vi.fn())
const mockSetFilter = vi.hoisted(() => vi.fn())
const mockRecoverSelectedBoard = vi.hoisted(() => vi.fn())
const mockCreateBoard = vi.hoisted(() => vi.fn())
const mockArchiveSelectedBoard = vi.hoisted(() => vi.fn())
const mockDispatch = vi.hoisted(() => vi.fn())
const mockDialogWarning = vi.hoisted(() => vi.fn())
const mockStartEventStream = vi.hoisted(() => vi.fn())
const mockStopEventStream = vi.hoisted(() => vi.fn())
const mockFetchProfiles = vi.hoisted(() => vi.fn())
const profilesState = vi.hoisted(() => ({
  profiles: [] as Array<{ name: string; avatar?: Record<string, any> | null }>,
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ replace: routerReplace }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/stores/hermes/kanban', () => ({
  DEFAULT_KANBAN_BOARD: 'default',
  useKanbanStore: () => ({
    ...storeState,
    fetchBoards: mockFetchBoards,
    fetchCapabilities: mockFetchCapabilities,
    refreshAll: mockRefreshAll,
    fetchTasks: mockFetchTasks,
    fetchStats: mockFetchStats,
    setFilter: mockSetFilter,
    recoverSelectedBoard: mockRecoverSelectedBoard,
    createBoard: mockCreateBoard,
    archiveSelectedBoard: mockArchiveSelectedBoard,
    dispatch: mockDispatch,
    startEventStream: mockStartEventStream,
    stopEventStream: mockStopEventStream,
  }),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    profiles: profilesState.profiles,
    fetchProfiles: mockFetchProfiles,
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanTaskCard.vue', () => ({
  default: defineComponent({
    name: 'KanbanTaskCard',
    props: { task: { type: Object, required: true }, assigneeAvatar: { type: Object, required: false } },
    emits: ['click'],
    template: '<button class="kanban-task-card-stub" :data-avatar-seed="assigneeAvatar?.seed || null" @click="$emit(\'click\', task.id)">{{ task.title }}</button>',
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanTaskDrawer.vue', () => ({
  default: defineComponent({
    name: 'KanbanTaskDrawer',
    props: { taskId: { type: String, required: false } },
    emits: ['updated', 'close'],
    template: '<button class="drawer-updated" :data-task-id="taskId || null" @click="$emit(\'updated\')">drawer</button>',
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanCreateForm.vue', () => ({
  default: defineComponent({
    name: 'KanbanCreateForm',
    emits: ['created', 'close'],
    template: '<button class="form-created" @click="$emit(\'created\')">form</button>',
  }),
}))

vi.mock('@vue-flow/core', () => ({
  VueFlow: defineComponent({
    name: 'VueFlow',
    props: {
      nodes: { type: Array, default: () => [] },
      defaultViewport: { type: Object, required: false },
    },
    template: `
      <div class="vue-flow-stub" :data-zoom="defaultViewport?.zoom">
        <div
          v-for="node in nodes"
          :key="node.id"
          class="vue-flow-node-stub"
          :data-position-x="node.position.x"
          :data-pointer-events="node.style?.pointerEvents"
        >
          <slot name="node-status" :data="node.data" />
        </div>
        <slot />
      </div>
    `,
  }),
}))

vi.mock('@vue-flow/background', () => ({
  Background: defineComponent({
    name: 'Background',
    template: '<div class="vue-flow-background-stub" />',
  }),
}))

vi.mock('@vue-flow/controls', () => ({
  Controls: defineComponent({
    name: 'Controls',
    template: '<div class="vue-flow-controls-stub" />',
  }),
}))

vi.mock('@vue-flow/minimap', () => ({
  MiniMap: defineComponent({
    name: 'MiniMap',
    template: '<div class="vue-flow-minimap-stub" />',
  }),
}))

vi.mock('naive-ui', () => ({
  useDialog: () => ({ warning: mockDialogWarning }),
  useMessage: () => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }),
  NButton: defineComponent({
    name: 'NButton',
    props: { disabled: Boolean },
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="icon" /></button>',
  }),
  NTooltip: defineComponent({
    name: 'NTooltip',
    props: { disabled: Boolean },
    template: '<span class="n-tooltip-stub"><slot name="trigger" /><span v-if="!disabled" class="n-tooltip-content"><slot /></span></span>',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    props: { value: null, options: { type: Array, default: () => [] }, loading: Boolean },
    emits: ['update:value'],
    template: '<button class="n-select-stub" @click="$emit(\'update:value\', options[1]?.value || value)"><span v-for="option in options" :key="option.value">{{ option.label }}</span>{{ value }}</button>',
  }),
  NInput: defineComponent({
    name: 'NInput',
    props: { value: { type: String, default: '' }, placeholder: { type: String, required: false } },
    emits: ['update:value'],
    template: '<input class="n-input-stub" :placeholder="placeholder" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NModal: defineComponent({
    name: 'NModal',
    props: { show: Boolean },
    emits: ['update:show', 'close'],
    template: '<div v-if="show" class="n-modal-stub"><slot /><slot name="action" /></div>',
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
}))

import KanbanView from '@/views/hermes/KanbanView.vue'

describe('KanbanView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    routeState.query = { board: 'project-a' }
    routerReplace.mockResolvedValue(undefined)
    storeState.tasks = [
      { id: 'task-1', title: 'Task one', status: 'todo', created_at: 10 },
      { id: 'task-2', title: 'Task two', status: 'done', created_at: 20 },
    ]
    storeState.stats = {
      by_status: { triage: 0, todo: 1, ready: 0, running: 0, blocked: 0, done: 1, archived: 0 },
      by_assignee: {},
      total: 2,
    }
    storeState.assignees = []
    storeState.activeBoards = [
      { slug: 'default', name: 'Default', total: 0 },
      { slug: 'project-a', name: 'Project A', total: 2 },
    ]
    storeState.loading = false
    storeState.boardsLoading = false
    storeState.selectedBoard = 'default'
    storeState.boardWarning = null
    storeState.capabilities = null
    storeState.filterStatus = null
    storeState.filterAssignee = null
    profilesState.profiles = []
    mockFetchBoards.mockResolvedValue(undefined)
    mockFetchCapabilities.mockResolvedValue(undefined)
    mockRefreshAll.mockResolvedValue(undefined)
    mockFetchTasks.mockResolvedValue(undefined)
    mockFetchStats.mockResolvedValue(undefined)
    mockFetchProfiles.mockResolvedValue(undefined)
    mockCreateBoard.mockResolvedValue({ slug: 'new-board' })
    mockArchiveSelectedBoard.mockResolvedValue(undefined)
    mockRecoverSelectedBoard.mockImplementation((candidate: string) => {
      storeState.selectedBoard = candidate || 'default'
      return { board: storeState.selectedBoard, recovered: false }
    })
    mockSetFilter.mockImplementation((key: 'status' | 'assignee', value: string | null) => {
      if (key === 'status') storeState.filterStatus = value
      else storeState.filterAssignee = value
    })
    mockDispatch.mockResolvedValue({ spawned: 1 })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('initializes board from route query and refreshes stats alongside tasks', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(mockFetchBoards).toHaveBeenCalledOnce()
    expect(mockFetchCapabilities).toHaveBeenCalledOnce()
    expect(mockFetchProfiles).toHaveBeenCalledOnce()
    expect(mockRecoverSelectedBoard).toHaveBeenCalledWith('project-a')
    expect(mockRefreshAll).toHaveBeenCalledOnce()
    expect(routerReplace).not.toHaveBeenCalled()
    expect(wrapper.findAll('.kanban-column')).toHaveLength(9)
    expect(wrapper.findAll('.kanban-column').map(column => column.attributes('data-status'))).toEqual([
      'triage',
      'todo',
      'scheduled',
      'ready',
      'running',
      'blocked',
      'review',
      'done',
      'archived',
    ])
    expect(wrapper.find('.vue-flow-stub').attributes('data-zoom')).toBe('0.92')
    expect(wrapper.findAll('.vue-flow-node-stub').map(node => node.attributes('data-position-x'))).toEqual([
      '0',
      '344',
      '688',
      '1032',
      '1376',
      '1720',
      '2064',
      '2408',
      '2752',
    ])
    expect(wrapper.findAll('.vue-flow-node-stub').every(node => node.attributes('data-pointer-events') === 'all')).toBe(true)

    await wrapper.find('.drawer-updated').trigger('click')
    expect(mockFetchTasks).toHaveBeenCalledTimes(1)
    expect(mockFetchStats).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)
    await flushPromises()

    expect(mockFetchBoards).toHaveBeenCalledTimes(2)
    expect(mockFetchTasks).toHaveBeenCalledTimes(2)
    expect(mockFetchStats).toHaveBeenCalledTimes(2)
  })

  it('renders board count labels and compact assignee profile labels', async () => {
    storeState.assignees = [{ name: 'alice', counts: { todo: 2, done: 1 } }]
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(wrapper.text()).toContain('kanban.title: Default · kanban.stats.tasks: 0')
    expect(wrapper.text()).toContain('kanban.title: Project A · kanban.stats.tasks: 2')
    const assigneeSelect = wrapper.findAll('.n-select-stub')[2]
    expect(assigneeSelect.text()).toContain('alice')
    expect(assigneeSelect.text()).not.toContain('default')
    expect(wrapper.text()).not.toContain('kanban.detail.assignee: alice')
    expect(wrapper.text()).not.toContain('alice · kanban.stats.tasks')
  })

  it('passes matching profile avatars to task cards', async () => {
    storeState.tasks = [{ id: 'task-1', title: 'Task one', status: 'todo', created_at: 10, assignee: 'alice' }]
    profilesState.profiles = [{ name: 'alice', avatar: { type: 'generated', seed: 'alice-seed' } }]

    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(wrapper.find('.kanban-task-card-stub').attributes('data-avatar-seed')).toBe('alice-seed')
  })

  it('keeps task cards clickable and task lists independently scrollable inside the canvas', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    const taskList = wrapper.find('.task-list')
    expect(taskList.classes()).toEqual(expect.arrayContaining(['nodrag', 'nopan', 'nowheel']))

    await wrapper.find('.kanban-task-card-stub').trigger('click')
    expect(wrapper.find('.drawer-updated').attributes('data-task-id')).toBe('task-1')
  })

  it('filters the visible board columns from stats chips', async () => {
    storeState.filterStatus = 'done'

    const wrapper = mount(KanbanView)
    await flushPromises()

    const columns = wrapper.findAll('.kanban-column')
    expect(wrapper.find('.kanban-flow').classes()).toContain('filtered')
    expect(columns).toHaveLength(1)
    expect(columns[0].attributes('data-status')).toBe('done')
    expect(wrapper.text()).toContain('Task two')
    expect(wrapper.text()).not.toContain('Task one')

    await wrapper.find('.stat-chip.todo').trigger('click')
    await flushPromises()

    expect(mockSetFilter).toHaveBeenCalledWith('status', 'todo')
    expect(mockFetchTasks).toHaveBeenCalledTimes(1)

    await wrapper.find('.stat-chip.total').trigger('click')
    await flushPromises()

    expect(mockSetFilter).toHaveBeenCalledWith('status', null)
    expect(mockFetchTasks).toHaveBeenCalledTimes(2)
  })

  it('creates and archives boards from the board toolbar', async () => {
    storeState.selectedBoard = 'project-a'
    const wrapper = mount(KanbanView)
    await flushPromises()

    await wrapper.findAll('.n-button-stub')[0].trigger('click')
    await flushPromises()
    const inputs = wrapper.findAll('.n-input-stub')
    await inputs[0].setValue('new-board')
    await inputs[1].setValue('New Board')
    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await flushPromises()

    expect(mockCreateBoard).toHaveBeenCalledWith({ slug: 'new-board', name: 'New Board' })
    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'new-board' } })

    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockDialogWarning).toHaveBeenCalledWith(expect.objectContaining({
      title: 'kanban.board.archive',
      content: 'kanban.board.archiveConfirm',
      positiveText: 'kanban.board.archive',
      negativeText: 'common.cancel',
    }))
    await mockDialogWarning.mock.calls[0][0].onPositiveClick()
    await flushPromises()

    expect(mockArchiveSelectedBoard).toHaveBeenCalled()
    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'default' } })
  })

  it('explains why the default board cannot be archived', async () => {
    storeState.selectedBoard = 'default'
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(wrapper.find('.n-tooltip-content').text()).toBe('kanban.board.defaultArchiveUnavailable')
    const archiveButton = wrapper.findAll('.n-button-stub')
      .find(node => node.text() === 'kanban.board.archive')
    expect(archiveButton?.attributes('disabled')).toBeDefined()
  })

  it('makes default board explicit when route query is absent', async () => {
    routeState.query = {}
    mockRecoverSelectedBoard.mockImplementation(() => {
      storeState.selectedBoard = 'default'
      return { board: 'default', recovered: false }
    })

    mount(KanbanView)
    await flushPromises()

    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'default' } })
    expect(mockRefreshAll).toHaveBeenCalledOnce()
  })
})
