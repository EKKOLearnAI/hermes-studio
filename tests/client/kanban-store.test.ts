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
  addComment: vi.fn(),
  linkTasks: vi.fn(),
  unlinkTasks: vi.fn(),
  bulkUpdateTasks: vi.fn(),
  getTaskLog: vi.fn(),
  getDiagnostics: vi.fn(),
  reclaimTask: vi.fn(),
  reassignTask: vi.fn(),
  specifyTask: vi.fn(),
  dispatch: vi.fn(),
  openKanbanEventStream: vi.fn(),
}))

vi.mock('@/api/hermes/kanban', () => mockKanbanApi)

import { KANBAN_SELECTED_BOARD_STORAGE_KEY, normalizeBoardSlug, useKanbanStore } from '@/stores/hermes/kanban'

describe('Kanban store', () => {
  it('normalizes board slugs with canonical underscore, uppercase, and length rules', () => {
    const sixtyFour = 'a'.repeat(64)

    expect(normalizeBoardSlug(' Team_Alpha ')).toBe('team_alpha')
    expect(normalizeBoardSlug(sixtyFour)).toBe(sixtyFour)
    expect(normalizeBoardSlug('default')).toBe('default')
    expect(normalizeBoardSlug('bad/slug')).toBe('default')
    expect(normalizeBoardSlug('bad.slug')).toBe('default')
    expect(normalizeBoardSlug('bad slug')).toBe('default')
  })

  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    mockKanbanApi.listBoards.mockResolvedValue([
      { slug: 'default', name: 'Default', archived: false, counts: {}, total: 0 },
      { slug: 'project-a', name: 'Project A', archived: false, counts: { todo: 1 }, total: 1 },
    ])
    mockKanbanApi.getCapabilities.mockResolvedValue({ source: 'hermes-cli', supports: { boardsList: true }, missing: [] })
    mockKanbanApi.openKanbanEventStream.mockReturnValue({ close: vi.fn(), onmessage: null, onclose: null, onerror: null })
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

    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ board: 'project-a', status: 'blocked', assignee: 'alice', includeArchived: true })
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

  it('uses capability metadata before calling parity APIs', async () => {
    mockKanbanApi.getCapabilities.mockResolvedValue({
      source: 'hermes-cli',
      supports: { commentsWrite: true, dispatch: false },
      missing: ['dispatch'],
    })
    mockKanbanApi.addComment.mockResolvedValue({ ok: true })

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    await store.fetchCapabilities()

    expect(store.isCapabilitySupported('commentsWrite')).toBe(true)
    expect(store.isCapabilitySupported('dispatch')).toBe(false)
    await store.addComment('task-1', 'needs review', 'han')
    await expect(store.dispatch({ dryRun: true })).rejects.toThrow('dispatch')

    expect(mockKanbanApi.addComment).toHaveBeenCalledWith('task-1', { body: 'needs review', author: 'han' }, { board: 'project-a' })
    expect(mockKanbanApi.dispatch).not.toHaveBeenCalled()
  })

  it('passes selected board to link and partial bulk parity actions', async () => {
    mockKanbanApi.getCapabilities.mockResolvedValue({
      source: 'hermes-cli',
      supports: { links: true, bulk: false },
      missing: ['bulk'],
      capabilities: [
        { key: 'links', status: 'supported', requiresBoard: true },
        { key: 'bulk', status: 'partial', requiresBoard: true },
      ],
    })
    mockKanbanApi.linkTasks.mockResolvedValue({ ok: true })
    mockKanbanApi.unlinkTasks.mockResolvedValue({ ok: true })
    mockKanbanApi.bulkUpdateTasks.mockResolvedValue({ results: [{ id: 'task-1', ok: true }] })
    mockKanbanApi.listTasks.mockResolvedValue([])
    mockKanbanApi.getStats.mockResolvedValue({ total: 0, by_status: {}, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    await store.fetchCapabilities()

    await store.linkTasks('task-1', 'task-2')
    await store.unlinkTasks('task-1', 'task-2')
    await expect(store.bulkUpdateTasks({ ids: ['task-1'], status: 'done', assignee: null, summary: 'closed' })).resolves.toEqual({ results: [{ id: 'task-1', ok: true }] })

    expect(mockKanbanApi.linkTasks).toHaveBeenCalledWith({ parent_id: 'task-1', child_id: 'task-2' }, { board: 'project-a' })
    expect(mockKanbanApi.unlinkTasks).toHaveBeenCalledWith({ parent_id: 'task-1', child_id: 'task-2' }, { board: 'project-a' })
    expect(mockKanbanApi.bulkUpdateTasks).toHaveBeenCalledWith({ ids: ['task-1'], status: 'done', assignee: null, summary: 'closed' }, { board: 'project-a' })
    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ board: 'project-a', status: undefined, assignee: undefined, includeArchived: true })
  })

  it('opens board-scoped event streams, refreshes on events, and reconnects on board switch', async () => {
    vi.useFakeTimers()
    const socketA = { close: vi.fn(), onmessage: null as ((event: { data: string }) => void) | null, onclose: null, onerror: null }
    const socketB = { close: vi.fn(), onmessage: null as ((event: { data: string }) => void) | null, onclose: null, onerror: null }
    mockKanbanApi.openKanbanEventStream
      .mockReturnValueOnce(socketA)
      .mockReturnValueOnce(socketB)
    mockKanbanApi.getCapabilities.mockResolvedValue({
      source: 'hermes-cli',
      supports: {},
      missing: [],
      capabilities: [{ key: 'events', status: 'partial', requiresBoard: true }],
    })
    mockKanbanApi.listTasks.mockResolvedValue([])
    mockKanbanApi.getStats.mockResolvedValue({ total: 0, by_status: {}, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    await store.fetchCapabilities()

    expect(store.startEventStream()).toBe(true)
    expect(mockKanbanApi.openKanbanEventStream).toHaveBeenCalledWith({ board: 'project-a' })

    socketA.onmessage?.({ data: JSON.stringify({ type: 'event', line: 'changed' }) })
    await vi.advanceTimersByTimeAsync(100)
    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ board: 'project-a', status: undefined, assignee: undefined, includeArchived: true })
    expect(mockKanbanApi.getStats).toHaveBeenCalledWith({ board: 'project-a' })
    expect(mockKanbanApi.getAssignees).toHaveBeenCalledWith({ board: 'project-a' })

    store.setSelectedBoard('default')
    expect(socketA.close).toHaveBeenCalled()
    expect(mockKanbanApi.openKanbanEventStream).toHaveBeenLastCalledWith({ board: 'default' })
    store.stopEventStream()
    expect(socketB.close).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('passes selected board to parity actions and refreshes affected board state', async () => {
    mockKanbanApi.getCapabilities.mockResolvedValue({
      source: 'hermes-cli',
      supports: { taskLog: true, diagnostics: true, reclaim: true, reassign: true, specify: true, dispatch: true },
      missing: [],
    })
    mockKanbanApi.getTaskLog.mockResolvedValue({ task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false })
    mockKanbanApi.getDiagnostics.mockResolvedValue([{ task_id: 'task-1' }])
    mockKanbanApi.reclaimTask.mockResolvedValue({ ok: true })
    mockKanbanApi.reassignTask.mockResolvedValue({ ok: true })
    mockKanbanApi.specifyTask.mockResolvedValue([{ task_id: 'task-1' }])
    mockKanbanApi.dispatch.mockResolvedValue({ spawned: 1 })
    mockKanbanApi.getStats.mockResolvedValue({ total: 1, by_status: {}, by_assignee: {} })
    mockKanbanApi.getAssignees.mockResolvedValue([{ name: 'bob', on_disk: true, counts: {} }])
    mockKanbanApi.listTasks.mockResolvedValue([{ id: 'task-1', assignee: 'bob' }])

    const store = useKanbanStore()
    store.setSelectedBoard('project-a')
    store.tasks = [{ id: 'task-1', status: 'running', assignee: 'alice' }] as any
    await store.fetchCapabilities()

    await expect(store.getTaskLog('task-1', 4000)).resolves.toEqual({ task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false })
    await expect(store.getDiagnostics({ task: 'task-1', severity: 'warning' })).resolves.toEqual([{ task_id: 'task-1' }])
    await store.reclaimTask('task-1', 'stale')
    await store.reassignTask('task-1', 'bob', { reclaim: true, reason: 'handoff' })
    await expect(store.specifyTask('task-1', 'han')).resolves.toEqual([{ task_id: 'task-1' }])
    await expect(store.dispatch({ dryRun: true, max: 2, failureLimit: 3 })).resolves.toEqual({ spawned: 1 })

    expect(mockKanbanApi.getTaskLog).toHaveBeenCalledWith('task-1', { board: 'project-a', tail: 4000 })
    expect(mockKanbanApi.getDiagnostics).toHaveBeenCalledWith({ board: 'project-a', task: 'task-1', severity: 'warning' })
    expect(mockKanbanApi.reclaimTask).toHaveBeenCalledWith('task-1', { board: 'project-a', reason: 'stale' })
    expect(mockKanbanApi.reassignTask).toHaveBeenCalledWith('task-1', 'bob', { board: 'project-a', reclaim: true, reason: 'handoff' })
    expect(mockKanbanApi.specifyTask).toHaveBeenCalledWith('task-1', { board: 'project-a', author: 'han' })
    expect(mockKanbanApi.dispatch).toHaveBeenCalledWith({ board: 'project-a', dryRun: true, max: 2, failureLimit: 3 })
    expect(store.tasks[0]).toMatchObject({ id: 'task-1', assignee: 'bob' })
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

    expect(mockKanbanApi.listTasks).toHaveBeenCalledWith({ board: 'project-a', status: undefined, assignee: undefined, includeArchived: true })
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
