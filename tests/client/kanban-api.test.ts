// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockRequest = vi.hoisted(() => vi.fn())

vi.mock('../../packages/client/src/api/client', () => ({
  request: mockRequest,
}))

import {
  listBoards,
  createBoard,
  archiveBoard,
  getCapabilities,
  listTasks,
  getTask,
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

  it('serializes board and list filters into query params', async () => {
    mockRequest.mockResolvedValue({ tasks: [{ id: 'task-1' }] })

    const result = await listTasks({ board: 'default', status: 'blocked', assignee: 'alice', tenant: 'ops' })

    expect(mockRequest).toHaveBeenCalledWith('/api/hermes/kanban?board=default&status=blocked&assignee=alice&tenant=ops')
    expect(result).toEqual([{ id: 'task-1' }])
  })

  it('keeps default board explicit when no board is supplied', async () => {
    mockRequest
      .mockResolvedValueOnce({ tasks: [] })
      .mockResolvedValueOnce({ stats: { total: 0, by_status: {}, by_assignee: {} } })
      .mockResolvedValueOnce({ assignees: [] })
      .mockResolvedValueOnce({ task: { id: 'task-1' }, comments: [], events: [], runs: [] })

    await listTasks()
    await getStats()
    await getAssignees()
    await getTask('task-1')

    expect(mockRequest.mock.calls.map(call => call[0])).toEqual([
      '/api/hermes/kanban?board=default',
      '/api/hermes/kanban/stats?board=default',
      '/api/hermes/kanban/assignees?board=default',
      '/api/hermes/kanban/task-1?board=default',
    ])
  })

  it('posts create and action payloads with explicit board in the URL', async () => {
    mockRequest
      .mockResolvedValueOnce({ task: { id: 'task-1' } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true })

    expect(await createTask({ title: 'Ship', assignee: 'alice', priority: 3 }, { board: 'project-a' })).toEqual({ id: 'task-1' })
    await completeTasks(['task-1'], 'done', { board: 'project-a' })
    await blockTask('task-1', 'waiting', { board: 'project-a' })
    await unblockTasks(['task-1'], { board: 'project-a' })
    await assignTask('task-1', 'bob', { board: 'project-a' })

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban?board=project-a', { method: 'POST', body: JSON.stringify({ title: 'Ship', assignee: 'alice', priority: 3 }) }],
      ['/api/hermes/kanban/complete?board=project-a', { method: 'POST', body: JSON.stringify({ task_ids: ['task-1'], summary: 'done' }) }],
      ['/api/hermes/kanban/task-1/block?board=project-a', { method: 'POST', body: JSON.stringify({ reason: 'waiting' }) }],
      ['/api/hermes/kanban/unblock?board=project-a', { method: 'POST', body: JSON.stringify({ task_ids: ['task-1'] }) }],
      ['/api/hermes/kanban/task-1/assign?board=project-a', { method: 'POST', body: JSON.stringify({ profile: 'bob' }) }],
    ])
  })

  it('lists and manages boards through explicit board endpoints', async () => {
    mockRequest
      .mockResolvedValueOnce({ boards: [{ slug: 'default' }] })
      .mockResolvedValueOnce({ board: { slug: 'project-a' } })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ capabilities: { source: 'hermes-cli', supports: { boardsList: true }, missing: [] } })
      .mockResolvedValueOnce({ stats: { total: 3, by_status: {}, by_assignee: {} } })
      .mockResolvedValueOnce({ assignees: [{ name: 'alice', on_disk: true, counts: { todo: 1 } }] })

    await expect(listBoards({ includeArchived: true })).resolves.toEqual([{ slug: 'default' }])
    await expect(createBoard({ slug: 'project-a', name: 'Project A' })).resolves.toEqual({ slug: 'project-a' })
    await expect(archiveBoard('project-a')).resolves.toEqual({ ok: true })
    await expect(getCapabilities()).resolves.toEqual({ source: 'hermes-cli', supports: { boardsList: true }, missing: [] })
    await expect(getStats({ board: 'project-a' })).resolves.toEqual({ total: 3, by_status: {}, by_assignee: {} })
    await expect(getAssignees({ board: 'project-a' })).resolves.toEqual([{ name: 'alice', on_disk: true, counts: { todo: 1 } }])

    expect(mockRequest.mock.calls).toEqual([
      ['/api/hermes/kanban/boards?includeArchived=true'],
      ['/api/hermes/kanban/boards', { method: 'POST', body: JSON.stringify({ slug: 'project-a', name: 'Project A' }) }],
      ['/api/hermes/kanban/boards/project-a', { method: 'DELETE' }],
      ['/api/hermes/kanban/capabilities'],
      ['/api/hermes/kanban/stats?board=project-a'],
      ['/api/hermes/kanban/assignees?board=project-a'],
    ])
  })
})
