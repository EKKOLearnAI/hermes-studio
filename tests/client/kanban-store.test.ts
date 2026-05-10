// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mockKanbanApi = vi.hoisted(() => ({
  listBoards: vi.fn(),
  createBoard: vi.fn(),
  archiveBoard: vi.fn(),
  getCapabilities: vi.fn(),
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

import { KANBAN_SELECTED_BOARD_STORAGE_KEY, useKanbanStore } from '@/stores/hermes/kanban'

describe('Kanban store', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockKanbanApi.listBoards.mockResolvedValue([
      { slug: 'default', name: 'Default', archived: false, counts: {}, total: 0 },
      { slug: 'project-a', name: 'Project A', archived: false, counts: { todo: 1 }, total: 1 },
    ])
    mockKanbanApi.getCapabilities.mockResolvedValue({ source: 'hermes-cli', supports: { boardsList: true }, missing: [] })
  })

  it('persists selected board, including default, and falls back to default for missing boards', async () => {
    const store = useKanbanStore()
    await store.fetchBoards()

    expect(store.setSelectedBoard('project-a')).toBe('project-a')
    expect(window.localStorage.getItem(KANBAN_SELECTED_BOARD_STORAGE_KEY)).toBe('project-a')

    expect(store.setSelectedBoard('default')).toBe('default')
    expect(window.localStorage.getItem(KANBAN_SELECTED_BOARD_STORAGE_KEY)).toBe('default')

    const recovered = store.recoverSelectedBoard('missing-board')
    expect(recovered).toEqual({ board: 'default', recovered: true })
    expect(store.selectedBoard).toBe('default')
    expect(store.boardWarning).toContain('missing-board')
  })

  it('fetchTasks uses active filters and selected board while updating loading', async () => {
    mockKanbanApi.listTasks.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([{ id: 'task-1', status: 'todo' }]), 0))
    )

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    store.setFilter('status', 'blocked')
    store.setFilter('assignee', 'alice')
    const promise = store.fetchTasks()

    expect(store.loading).toBe(true)
    await promise

    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ board: 'project-a', status: 'blocked', assignee: 'alice' })
    expect(store.tasks).toEqual([{ id: 'task-1', status: 'todo' }])
    expect(store.loading).toBe(false)
  })

  it('create and status actions pass selected board, update local task state, and refresh board counts', async () => {
    mockKanbanApi.createTask.mockResolvedValue({ id: 'task-2', status: 'todo', assignee: null })
    mockKanbanApi.completeTasks.mockResolvedValue({ ok: true })
    mockKanbanApi.blockTask.mockResolvedValue({ ok: true })
    mockKanbanApi.unblockTasks.mockResolvedValue({ ok: true })
    mockKanbanApi.assignTask.mockResolvedValue({ ok: true })
    mockKanbanApi.getStats.mockResolvedValue({ total: 2, by_status: { done: 1 }, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([{ name: 'bob', on_disk: true, counts: { ready: 1 } }])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    store.tasks = [{ id: 'task-1', status: 'running', assignee: null }] as any

    await store.createTask({ title: 'Ship' })
    await store.completeTasks(['task-1'], 'done')
    await store.blockTask('task-2', 'waiting')
    await store.unblockTasks(['task-2'])
    await store.assignTask('task-2', 'bob')

    expect(mockKanbanApi.createTask).toHaveBeenCalledWith({ title: 'Ship' }, { board: 'project-a' })
    expect(mockKanbanApi.completeTasks).toHaveBeenCalledWith(['task-1'], 'done', { board: 'project-a' })
    expect(mockKanbanApi.blockTask).toHaveBeenCalledWith('task-2', 'waiting', { board: 'project-a' })
    expect(mockKanbanApi.unblockTasks).toHaveBeenCalledWith(['task-2'], { board: 'project-a' })
    expect(mockKanbanApi.assignTask).toHaveBeenCalledWith('task-2', 'bob', { board: 'project-a' })
    expect(mockKanbanApi.listBoards).toHaveBeenCalledTimes(4)
    expect(mockKanbanApi.getAssignees).toHaveBeenCalledWith({ board: 'project-a' })
    expect(store.tasks[0]).toMatchObject({ id: 'task-2', status: 'ready', assignee: 'bob' })
    expect(store.tasks[1]).toMatchObject({ id: 'task-1', status: 'done' })
  })

  it('creates and archives boards without relying on CLI current board', async () => {
    mockKanbanApi.listBoards.mockResolvedValue([
      { slug: 'default', name: 'Default', archived: false, counts: {}, total: 0 },
      { slug: 'new-board', name: 'New Board', archived: false, counts: {}, total: 0 },
    ])
    mockKanbanApi.createBoard.mockResolvedValue({ slug: 'new-board', name: 'New Board', archived: false, counts: {}, total: 0 })
    mockKanbanApi.archiveBoard.mockResolvedValue({ ok: true })
    mockKanbanApi.listTasks.mockResolvedValue([])
    mockKanbanApi.getStats.mockResolvedValue({ total: 0, by_status: {}, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([])

    const store = useKanbanStore()
    await store.createBoard({ slug: 'new-board', name: 'New Board' })
    expect(mockKanbanApi.createBoard).toHaveBeenCalledWith({ slug: 'new-board', name: 'New Board' })
    expect(store.selectedBoard).toBe('new-board')

    await store.archiveSelectedBoard()
    expect(mockKanbanApi.archiveBoard).toHaveBeenCalledWith('new-board')
    expect(store.selectedBoard).toBe('default')
  })

  it('refreshAll loads boards, tasks, stats, and assignees for the same board', async () => {
    mockKanbanApi.listTasks.mockResolvedValue([{ id: 'task-1' }])
    mockKanbanApi.getStats.mockResolvedValue({ total: 1, by_status: {}, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    await store.refreshAll()

    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ board: 'project-a', status: undefined, assignee: undefined })
    expect(mockKanbanApi.getStats).toHaveBeenCalledWith({ board: 'project-a' })
    expect(mockKanbanApi.getAssignees).toHaveBeenCalledWith({ board: 'project-a' })
    expect(mockKanbanApi.listBoards).toHaveBeenCalledWith({ includeArchived: false })
    expect(store.tasks).toEqual([{ id: 'task-1' }])
    expect(store.stats).toEqual({ total: 1, by_status: {}, by_assignee: {} })
    expect(store.assignees).toEqual([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])
  })

  it('ignores stale board-list responses after a newer request', async () => {
    let resolveSlowBoards: (value: unknown) => void = () => {}
    mockKanbanApi.listBoards
      .mockImplementationOnce(() => new Promise(resolve => { resolveSlowBoards = resolve }))
      .mockResolvedValueOnce([
        { slug: 'default', name: 'Default', archived: false, counts: {}, total: 0 },
        { slug: 'project-a', name: 'Project A', archived: false, counts: { todo: 2 }, total: 2 },
      ])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    const slowFetch = store.fetchBoards()
    await store.fetchBoards()
    resolveSlowBoards([{ slug: 'default', name: 'Default', archived: false, counts: {}, total: 0 }])
    await slowFetch

    expect(store.selectedBoard).toBe('project-a')
    expect(store.activeBoards).toEqual(expect.arrayContaining([
      expect.objectContaining({ slug: 'project-a', total: 2 }),
    ]))
  })

  it('ignores stale same-board fetch responses after a newer request', async () => {
    let resolveSlow: (value: unknown) => void = () => {}
    mockKanbanApi.listTasks
      .mockImplementationOnce(() => new Promise(resolve => { resolveSlow = resolve }))
      .mockResolvedValueOnce([{ id: 'new-filter-task' }])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    const slowFetch = store.fetchTasks()
    await store.fetchTasks()
    resolveSlow([{ id: 'old-filter-task' }])
    await slowFetch

    expect(store.tasks).toEqual([{ id: 'new-filter-task' }])
  })

  it('does not leave loading stuck when a silent fetch supersedes a visible fetch', async () => {
    let resolveVisible: (value: unknown) => void = () => {}
    mockKanbanApi.listTasks
      .mockImplementationOnce(() => new Promise(resolve => { resolveVisible = resolve }))
      .mockResolvedValueOnce([{ id: 'silent-task' }])

    const store = useKanbanStore()
    const visibleFetch = store.fetchTasks()
    expect(store.loading).toBe(true)
    await store.fetchTasks(true)
    resolveVisible([{ id: 'visible-task' }])
    await visibleFetch

    expect(store.tasks).toEqual([{ id: 'silent-task' }])
    expect(store.loading).toBe(false)
  })

  it('ignores stale fetch responses after a board switch', async () => {
    let resolveSlow: (value: unknown) => void = () => {}
    mockKanbanApi.listTasks
      .mockImplementationOnce(() => new Promise(resolve => { resolveSlow = resolve }))
      .mockResolvedValueOnce([{ id: 'new-board-task' }])

    const store = useKanbanStore()
    store.setSelectedBoard('default')
    const slowFetch = store.fetchTasks()
    store.setSelectedBoard('project-a')
    await store.fetchTasks()
    resolveSlow([{ id: 'old-board-task' }])
    await slowFetch

    expect(store.tasks).toEqual([{ id: 'new-board-task' }])
  })
})
