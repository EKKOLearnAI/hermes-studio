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
      supports: { boardsList: true, boardCreate: true, commentsWrite: false, dispatch: false },
      missing: expect.arrayContaining(['commentsWrite', 'dispatch']),
    })
  })

  it('builds list/create/stats CLI calls with global --board before the action', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ id: 'task-1' }]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'task-2' }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total: 1, by_status: {}, by_assignee: {} }) })

    await expect(service.listTasks({ board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops' })).resolves.toEqual([{ id: 'task-1' }])
    await expect(service.createTask('Ship', { board: 'project-a', body: 'write', assignee: 'alice', priority: 3, tenant: 'ops' })).resolves.toEqual({ id: 'task-2' })
    await expect(service.getStats({ board: 'project-a' })).resolves.toEqual({ total: 1, by_status: {}, by_assignee: {} })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'project-a', 'list', '--json', '--status', 'todo', '--assignee', 'alice', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'project-a', 'create', 'Ship', '--json', '--body', 'write', '--assignee', 'alice', '--priority', '3', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', '--board', 'project-a', 'stats', '--json'])
  })

  it('normalizes omitted board to default instead of falling through to CLI current', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total: 0, by_status: {}, by_assignee: {} }) })

    await service.listTasks()
    await service.getStats()

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', '--board', 'default', 'list', '--json'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', '--board', 'default', 'stats', '--json'])
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

  it('wraps CLI failures with service-specific errors', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('boom'))

    await expect(service.listTasks()).rejects.toThrow('Failed to list kanban tasks: boom')
    expect(mockLoggerError).toHaveBeenCalled()
  })
})
