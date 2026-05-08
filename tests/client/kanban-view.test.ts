// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'

const storeState = vi.hoisted(() => ({
  tasks: [] as Array<{ id: string; title: string; status: string; created_at: number }>,
  stats: { by_status: { todo: 1, done: 0 }, by_assignee: {}, total: 1 } as Record<string, any>,
  assignees: [] as Array<{ name: string; counts: Record<string, number> | null }>,
  loading: false,
  filterStatus: null as string | null,
  filterAssignee: null as string | null,
}))

const mockRefreshAll = vi.hoisted(() => vi.fn())
const mockFetchTasks = vi.hoisted(() => vi.fn())
const mockFetchStats = vi.hoisted(() => vi.fn())
const mockSetFilter = vi.hoisted(() => vi.fn())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@/stores/hermes/kanban', () => ({
  useKanbanStore: () => ({
    ...storeState,
    refreshAll: mockRefreshAll,
    fetchTasks: mockFetchTasks,
    fetchStats: mockFetchStats,
    setFilter: mockSetFilter,
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
  NButton: defineComponent({
    name: 'NButton',
    emits: ['click'],
    template: '<button class="n-button-stub" @click="$emit(\'click\')"><slot /><slot name="icon" /></button>',
  }),
  NSelect: defineComponent({
    name: 'NSelect',
    props: { value: null, options: { type: Array, default: () => [] } },
    emits: ['update:value'],
    template: '<div class="n-select-stub"></div>',
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
    storeState.loading = false
    storeState.filterStatus = null
    storeState.filterAssignee = null
    mockRefreshAll.mockResolvedValue(undefined)
    mockFetchTasks.mockResolvedValue(undefined)
    mockFetchStats.mockResolvedValue(undefined)
    mockSetFilter.mockImplementation((key: 'status' | 'assignee', value: string | null) => {
      if (key === 'status') storeState.filterStatus = value
      else storeState.filterAssignee = value
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  it('starts with collapsed panels and refreshes stats alongside tasks', async () => {
    const wrapper = mount(KanbanView)
    await flushPromises()

    expect(mockRefreshAll).toHaveBeenCalledOnce()
    expect(wrapper.find('.n-collapse-stub').attributes('data-default-expanded')).toBe('null')

    await wrapper.find('.drawer-updated').trigger('click')
    expect(mockFetchTasks).toHaveBeenCalledTimes(1)
    expect(mockFetchStats).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(15000)
    await flushPromises()

    expect(mockFetchTasks).toHaveBeenCalledTimes(2)
    expect(mockFetchStats).toHaveBeenCalledTimes(2)
  })
})
