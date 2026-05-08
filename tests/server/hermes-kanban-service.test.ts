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

  it('builds list/create/stats CLI calls correctly', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ id: 'task-1' }]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ id: 'task-2' }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ total: 1, by_status: {}, by_assignee: {} }) })

    await expect(service.listTasks({ status: 'todo', assignee: 'alice', tenant: 'ops' })).resolves.toEqual([{ id: 'task-1' }])
    await expect(service.createTask('Ship', { body: 'write', assignee: 'alice', priority: 3, tenant: 'ops' })).resolves.toEqual({ id: 'task-2' })
    await expect(service.getStats()).resolves.toEqual({ total: 1, by_status: {}, by_assignee: {} })

    expect(mockExecFileAsync.mock.calls[0][1]).toEqual(['kanban', 'list', '--json', '--status', 'todo', '--assignee', 'alice', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', 'create', 'Ship', '--json', '--body', 'write', '--assignee', 'alice', '--priority', '3', '--tenant', 'ops'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', 'stats', '--json'])
  })

  it('builds action CLI calls and maps not-found show to null', async () => {
    mockExecFileAsync
      .mockRejectedValueOnce({ code: 1 })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ name: 'alice' }]) })

    await expect(service.getTask('missing')).resolves.toBeNull()
    await service.completeTasks(['task-1'], 'done')
    await service.blockTask('task-1', 'wait')
    await service.unblockTasks(['task-1'])
    await service.assignTask('task-1', 'alice')
    await expect(service.getAssignees()).resolves.toEqual([{ name: 'alice' }])

    expect(mockExecFileAsync.mock.calls[1][1]).toEqual(['kanban', 'complete', 'task-1', '--summary', 'done'])
    expect(mockExecFileAsync.mock.calls[2][1]).toEqual(['kanban', 'block', 'task-1', 'wait'])
    expect(mockExecFileAsync.mock.calls[3][1]).toEqual(['kanban', 'unblock', 'task-1'])
    expect(mockExecFileAsync.mock.calls[4][1]).toEqual(['kanban', 'assign', 'task-1', 'alice'])
    expect(mockExecFileAsync.mock.calls[5][1]).toEqual(['kanban', 'assignees', '--json'])
  })

  it('wraps CLI failures with service-specific errors', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('boom'))

    await expect(service.listTasks()).rejects.toThrow('Failed to list kanban tasks: boom')
    expect(mockLoggerError).toHaveBeenCalled()
  })
})
