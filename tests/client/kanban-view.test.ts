// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const routeState = vi.hoisted(() => ({
  query: { board: 'project-a' } as Record<string, string>,
}))

const routerReplace = vi.hoisted(() => vi.fn())

const storeState = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; title: string; status: string; created_at: number }>,
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
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanTaskCard.vue', () => ({
  default: defineComponent({
    name: 'KanbanTaskCard',
    props: { task: { type: Object, required: true } },
    template: '<div class="kanban-task-card-stub">{{ task.title }}</div>',
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanTaskDrawer.vue', () => ({
  default: defineComponent({
    name: 'KanbanTaskDrawer',
    emits: ['updated', 'close'],
    template: '<button class="drawer-updated" @click="$emit(\'updated\')">drawer</button>',
  }),
}))

vi.mock('@/components/hermes/kanban/KanbanCreateForm.vue', () => ({
  default: defineComponent({
    name: 'KanbanCreateForm',
    emits: ['created', 'close'],
    template: '<button class="form-created" @click="$emit(\'created\')">form</button>',
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ warning: vi.fn(), error: vi.fn(), success: vi.fn() }),
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    template: '<button class="n-button-stub" @click="$emit(\'click\')"><slot /><slot name="icon" /></button>',
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
  NCollapse: defineComponent({
    name: 'NCollapse',
    props: { defaultExpandedNames: { type: Array, required: false } },
    template: '<div class="n-collapse-stub" :data-default-expanded="JSON.stringify(defaultExpandedNames ?? null)"><slot /></div>',
  }),
  NCollapseItem: defineComponent({
    name: 'NCollapseItem',
    props: { title: { type: String, required: false }, name: { type: String, required: false } },
    template: '<section class="n-collapse-item-stub"><slot /></section>',
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
    mockFetchBoards.mockResolvedValue(undefined)
    mockFetchCapabilities.mockResolvedValue(undefined)
    mockRefreshAll.mockResolvedValue(undefined)
    mockFetchTasks.mockResolvedValue(undefined)
    mockFetchStats.mockResolvedValue(undefined)
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
    expect(mockRecoverSelectedBoard).toHaveBeenCalledWith('project-a')
    expect(mockRefreshAll).toHaveBeenCalledOnce()
    expect(routerReplace).not.toHaveBeenCalled()
    expect(wrapper.find('.n-collapse-stub').attributes('data-default-expanded')).toBe('null')

    await wrapper.find('.drawer-updated').trigger('click')
    expect(mockFetchTasks).toHaveBeenCalledTimes(1)
    expect(mockFetchStats).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)
    await flushPromises()

    expect(mockFetchBoards).toHaveBeenCalledTimes(2)
    expect(mockFetchTasks).toHaveBeenCalledTimes(2)
    expect(mockFetchStats).toHaveBeenCalledTimes(2)
  })

  it('renders board and assignee count labels with explicit context', async () => {
    storeState.assignees = [{ name: 'alice', counts: { todo: 2, done: 1 } }]
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(wrapper.text()).toContain('kanban.title: Default · kanban.stats.tasks: 0')
    expect(wrapper.text()).toContain('kanban.title: Project A · kanban.stats.tasks: 2')
    expect(wrapper.text()).toContain('kanban.detail.assignee: alice · kanban.stats.tasks: 3')
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

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true)
    await wrapper.findAll('.n-button-stub')[1].trigger('click')
    await flushPromises()

    expect(mockArchiveSelectedBoard).toHaveBeenCalled()
    expect(routerReplace).toHaveBeenCalledWith({ query: { board: 'default' } })
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
