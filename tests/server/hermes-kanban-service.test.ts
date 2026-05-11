import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecFileAsync = vi.hoisted(() => vi.fn())
const mockLoggerError = vi.hoisted(() => vi.fn())

vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    error: mockLoggerError,
  },
}))

import * as service from '../../packages/server/src/services/hermes/hermes-kanban'

describe('hermes kanban service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists boards without mutating or depending on CLI current', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: JSON.stringify([{ slug: 'default' }]) })

    await expect(service.listBoards({ includeArchived: true })).resolves.toEqual([{ slug: 'default' }])

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', 'boards', 'list', '--json', '--all'])
  })

  it('creates and archives boards through canonical CLI board commands', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ slug: 'project-a', name: 'Project A' }]) })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(service.createBoard({ slug: 'project-a', name: 'Project A', description: 'desc', icon: '📌', color: '#8b5cf6', switchCurrent: true })).resolves.toEqual({ slug: 'project-a', name: 'Project A' })
    await expect(service.archiveBoard('project-a')).resolves.toBeUndefined()

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', 'boards', 'create', 'project-a', '--name', 'Project A', '--description', 'desc', '--icon', '📌', '--color', '#8b5cf6', '--switch'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', 'boards', 'list', '--json', '--all'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', 'boards', 'rm', 'project-a'])
  })

  it('exposes capability metadata for WUI/canonical parity gaps', async () => {
    await expect(service.getCapabilities()).resolves.toMatchObject({
      source: 'hermes-cli',
      supports: { boardsList: true, boardCreate: true, commentsWrite: true, dispatch: true },
      missing: expect.arrayContaining(['cliCurrentSwitch', 'links', 'bulk', 'events', 'homeSubscriptions']),
      capabilities: expect.arrayContaining([
        expect.objectContaining({ key: 'commentsWrite', status: 'supported', canonicalCommand: 'comment', requiresBoard: true }),
        expect.objectContaining({ key: 'events', status: 'missing', canonicalRoute: '/events', requiresBoard: true }),
      ]),
    })
  })

  it('builds comment/log/diagnostics commands with explicit board', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'comment added\n' })
      .mockResolvedValueOnce({ stdout: 'worker log\n' })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ task_id: 'task-1', severity: 'warning' }]) })

    await expect(service.addComment('task-1', '--not-an-option', { board: 'default', author: 'han' })).resolves.toEqual({ ok: true, output: 'comment added\n' })
    await expect(service.getTaskLog('task-1', { board: 'default', tail: 4000 })).resolves.toEqual({ task_id: 'task-1', path: null, exists: true, size_bytes: 11, content: 'worker log\n', truncated: false })
    await expect(service.getDiagnostics({ board: 'default', task: 'task-1', severity: 'warning' })).resolves.toEqual([{ task_id: 'task-1', severity: 'warning' }])

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'comment', 'task-1', '--not-an-option', '--author', 'han'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'log', 'task-1', '--tail', '4000'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'diagnostics', '--json', '--task', 'task-1', '--severity', 'warning'])
  })

  it('maps no-log task logs to canonical empty-log shape', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1, stderr: '(no log for task-1 — task may not have spawned yet)' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ task: { id: 'task-1' }, runs: [], comments: [], events: [] }) })

    await expect(service.getTaskLog('task-1', { board: 'default' })).resolves.toEqual({
      task_id: 'task-1',
      path: null,
      exists: false,
      size_bytes: 0,
      content: '',
      truncated: false,
    })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'log', 'task-1'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'show', 'task-1', '--json'])
  })

  it('builds recovery and dispatch commands with explicit board', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'reclaimed\n' })
      .mockResolvedValueOnce({ stdout: 'reassigned\n' })
      .mockResolvedValueOnce({ stdout: '{"task_id":"task-1","created":true}\n' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ spawned: 1 }) })

    await expect(service.reclaimTask('task-1', { board: 'project-a', reason: 'stale lock' })).resolves.toEqual({ ok: true, output: 'reclaimed\n' })
    await expect(service.reassignTask('task-1', 'bob', { board: 'project-a', reclaim: true, reason: 'handoff' })).resolves.toEqual({ ok: true, output: 'reassigned\n' })
    await expect(service.specifyTask('task-1', { board: 'project-a', author: 'han' })).resolves.toEqual([{ task_id: 'task-1', created: true }])
    await expect(service.dispatch({ board: 'project-a', dryRun: true, max: 2, failureLimit: 3 })).resolves.toEqual({ spawned: 1 })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'project-a', 'reclaim', 'task-1', '--reason', 'stale lock'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'project-a', 'reassign', 'task-1', 'bob', '--reclaim', '--reason', 'handoff'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'project-a', 'specify', 'task-1', '--json', '--author', 'han'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'project-a', 'dispatch', '--json', '--dry-run', '--max', '2', '--failure-limit', '3'])
  })

  it('builds list/create/stats CLI calls with global --board before the action', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ id: 'task-1' }]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'task-2' }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total: 1, by_status: {}, by_assignee: {} }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ id: 'archived-1', status: 'archived' }, { id: 'archived-2', status: 'archived' }]) })

    await expect(service.listTasks({ board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops', includeArchived: true })).resolves.toEqual([{ id: 'task-1' }])
    await expect(service.createTask('Ship', { board: 'project-a', body: 'write', assignee: 'alice', priority: 3, tenant: 'ops' })).resolves.toEqual({ id: 'task-2' })
    await expect(service.getStats({ board: 'project-a' })).resolves.toEqual({ total: 3, by_status: { archived: 2 }, by_assignee: {} })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'project-a', 'list', '--json', '--archived', '--status', 'todo', '--assignee', 'alice', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'project-a', 'create', 'Ship', '--json', '--body', 'write', '--assignee', 'alice', '--priority', '3', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'project-a', 'stats', '--json'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'project-a', 'list', '--json', '--archived', '--status', 'archived'])
  })

  it('normalizes omitted board to default instead of falling through to CLI current', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total: 0, by_status: {}, by_assignee: {} }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    await service.listTasks()
    await service.getStats()

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'stats', '--json'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'list', '--json', '--archived', '--status', 'archived'])
  })

  it('builds action CLI calls and maps not-found show to null', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ name: 'alice' }]) })

    await expect(service.getTask('missing', { board: 'default' })).resolves.toBeNull()
    await service.completeTasks(['task-1'], 'done', { board: 'default' })
    await service.blockTask('task-1', 'wait', { board: 'default' })
    await service.unblockTasks(['task-1'], { board: 'default' })
    await service.assignTask('task-1', 'alice', { board: 'default' })
    await expect(service.getAssignees({ board: 'default' })).resolves.toEqual([{ name: 'alice' }])

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'show', 'missing', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'complete', 'task-1', '--summary', 'done'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'block', 'task-1', 'wait'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', '--board', 'default', 'unblock', 'task-1'])
    expect(mockExecFileAsync.mock.calls[4][1]).toEqual(['kanban', '--board', 'default', 'assign', 'task-1', 'alice'])
    expect(mockExecFileAsync.mock.calls[5][1]).toEqual(['kanban', '--board', 'default', 'assignees', '--json'])
  })

  it('rejects invalid board slugs before shelling out', async () => {
    await expect(service.listTasks({ board: 'bad;slug' })).rejects.toThrow('Invalid kanban board slug')
    expect(mockExecFileAsync).not.toHaveBeenCalled()
  })

  it('normalizes board slugs using canonical upstream-compatible rules', async () => {
    const sixtyFourChars = 'a'.repeat(64)
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    await service.listTasks({ board: 'Team_Alpha' })
    await service.listTasks({ board: sixtyFourChars })
    await service.listTasks({ board: 'default' })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'team_alpha', 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', sixtyFourChars, 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'default', 'list', '--json'])
    await expect(service.listTasks({ board: 'bad/slug' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: 'bad.slug' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: '..' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: 'bad slug' })).rejects.toThrow('Invalid kanban board slug')
    await expect(service.listTasks({ board: ' ' })).rejects.toThrow('Invalid kanban board slug')
  })

  it('does not hide non-no-log failures from the kanban log command', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1, stderr: 'permission denied', message: 'permission denied' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ task: { id: 'task-1' }, runs: [], comments: [], events: [] }) })

    await expect(service.getTaskLog('task-1', { board: 'default' })).rejects.toThrow('Failed to read kanban task log: permission denied')
    expect(mockLoggerError).toHaveBeenCalled()
  })

  it('does not treat misleading no-log fragments as canonical no-log messages', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1, stderr: 'permission denied: no log for diagnostic file', message: 'permission denied' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ task: { id: 'task-1' }, runs: [], comments: [], events: [] }) })

    await expect(service.getTaskLog('task-1', { board: 'default' })).rejects.toThrow('Failed to read kanban task log: permission denied')
  })

  it('wraps CLI failures with service-specific errors', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('boom'))

    await expect(service.listTasks()).rejects.toThrow('Failed to list kanban tasks: boom')
    expect(mockLoggerError).toHaveBeenCalled()
  })
})
