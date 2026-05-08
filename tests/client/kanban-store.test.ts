// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockKanbanApi = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getStats: vi.fn(),
  getAssignees: vi.fn(),
  createTask: vi.fn(),
  completeTasks: vi.fn(),
  blockTask: vi.fn(),
  unblockTasks: vi.fn(),
  assignTask: vi.fn(),
}))

vi.mock('@/api/hermes/kanban', () => mockKanbanApi)

import { useKanbanStore } from '@/stores/hermes/kanban'

describe('Kanban store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('fetchTasks uses active filters and updates loading', async () => {
    mockKanbanApi.listTasks.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([{ id: 'task-1', status: 'todo' }]), 0))
    )

    const store = useKanbanStore()
    store.setFilter('status', 'blocked')
    store.setFilter('assignee', 'alice')
    const promise = store.fetchTasks()

    expect(store.loading).toBe(true)
    await promise

    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ status: 'blocked', assignee: 'alice' })
    expect(store.tasks).toEqual([{ id: 'task-1', status: 'todo' }])
    expect(store.loading).toBe(false)
  })

  it('create and status actions update local task state and refresh stats', async () => {
    mockKanbanApi.createTask.mockResolvedValue({ id: 'task-2', status: 'todo', assignee: null })
    mockKanbanApi.completeTasks.mockResolvedValue({ ok: true })
    mockKanbanApi.blockTask.mockResolvedValue({ ok: true })
    mockKanbanApi.unblockTasks.mockResolvedValue({ ok: true })
    mockKanbanApi.assignTask.mockResolvedValue({ ok: true })
    mockKanbanApi.getStats.mockResolvedValue({ total: 2, by_status: { done: 1 }, by_assignee: {} })

    const store = useKanbanStore()
    store.tasks = [{ id: 'task-1', status: 'running', assignee: null }] as any

    await store.createTask({ title: 'Ship' })
    await store.completeTasks(['task-1'], 'done')
    await store.blockTask('task-2', 'waiting')
    await store.unblockTasks(['task-2'])
    await store.assignTask('task-2', 'bob')

    expect(store.tasks[0]).toMatchObject({ id: 'task-2', status: 'ready', assignee: 'bob' })
    expect(store.tasks[1]).toMatchObject({ id: 'task-1', status: 'done' })
    expect(mockKanbanApi.getStats).toHaveBeenCalledTimes(4)
  })

  it('refreshAll loads tasks, stats, and assignees together', async () => {
    mockKanbanApi.listTasks.mockResolvedValue([{ id: 'task-1' }])
    mockKanbanApi.getStats.mockResolvedValue({ total: 1, by_status: {}, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])

    const store = useKanbanStore()
    await store.refreshAll()

    expect(store.tasks).toEqual([{ id: 'task-1' }])
    expect(store.stats).toEqual({ total: 1, by_status: {}, by_assignee: {} })
    expect(store.assignees).toEqual([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])
  })
})
