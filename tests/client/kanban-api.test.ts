// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
}))

import {
  listTasks,
  createTask,
  completeTasks,
  blockTask,
  unblockTasks,
  assignTask,
  getStats,
  getAssignees,
} from '../../packages/client/src/api/hermes/kanban'

describe('Kanban API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('serializes list filters into query params', async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: 'task-1' }] })

    const result = await listTasks({ status: 'blocked', assignee: 'alice', tenant: 'ops' })

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/kanban?status=blocked&assignee=alice&tenant=ops')
    expect(result).toEqual([{ id: 'task-1' }])
  })

  it('posts create and action payloads in the expected shape', async () => {
    mockRequest
      .mockResolvedValueOnce({ task: { id: 'task-1' } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })

    expect(await createTask({ title: 'Ship', assignee: 'alice', priority: 3 })).toEqual({ id: 'task-1' })
    await completeTasks(['task-1'], 'done')
    await blockTask('task-1', 'waiting')
    await unblockTasks(['task-1'])
    await assignTask('task-1', 'bob')

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban', { method: 'POST', body: JSON.stringify({ title: 'Ship', assignee: 'alice', priority: 3 }) }],
      ['/api/hermes/kanban/complete', { method: 'POST', body: JSON.stringify({ task_ids: ['task-1'], summary: 'done' }) }],
      ['/api/hermes/kanban/task-1/block', { method: 'POST', body: JSON.stringify({ reason: 'waiting' }) }],
      ['/api/hermes/kanban/unblock', { method: 'POST', body: JSON.stringify({ task_ids: ['task-1'] }) }],
      ['/api/hermes/kanban/task-1/assign', { method: 'POST', body: JSON.stringify({ profile: 'bob' }) }],
    ])
  })

  it('unwraps stats and assignee response envelopes', async () => {
    mockRequest
      .mockResolvedValueOnce({ stats: { total: 3, by_status: {}, by_assignee: {} } })
      .mockResolvedValueOnce({ assignees: [{ name: 'alice', on_disk: true, counts: { todo: 1 } }] })

    await expect(getStats()).resolves.toEqual({ total: 3, by_status: {}, by_assignee: {} })
    await expect(getAssignees()).resolves.toEqual([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])
  })
})
