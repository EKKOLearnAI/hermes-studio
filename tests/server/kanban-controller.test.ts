import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReadFile = vi.hoisted(() => vi.fn())
const mockListTasks = vi.hoisted(() => vi.fn())
const mockGetTask = vi.hoisted(() => vi.fn())
const mockCreateTask = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockAssignTask = vi.hoisted(() => vi.fn())
const mockGetStats = vi.hoisted(() => vi.fn())
const mockGetAssignees = vi.hoisted(() => vi.fn())
const mockSearchSessions = vi.hoisted(() => vi.fn())
const mockGetSessionDetail = vi.hoisted(() => vi.fn())
const mockGetExactSessionDetail = vi.hoisted(() => vi.fn())
const mockFindLatestExactSessionId = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

vi.mock('os', () => ({
  homedir: () => '/Users/tester',
}))

vi.mock('../../packages/server/src/services/hermes/hermes-kanban', () => ({
  listTasks: mockListTasks,
  getTask: mockGetTask,
  createTask: mockCreateTask,
  completeTasks: mockCompleteTasks,
  blockTask: mockBlockTask,
  unblockTasks: mockUnblockTasks,
  assignTask: mockAssignTask,
  getStats: mockGetStats,
  getAssignees: mockGetAssignees,
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  searchSessionSummariesWithProfile: mockSearchSessions,
  getSessionDetailFromDbWithProfile: mockGetSessionDetail,
  getExactSessionDetailFromDbWithProfile: mockGetExactSessionDetail,
  findLatestExactSessionIdWithProfile: mockFindLatestExactSessionId,
}))

import * as ctrl from '../../packages/server/src/controllers/hermes/kanban'

function ctx(overrides: Record<string, any> = {}) {
  return {
    query: {},
    params: {},
    request: { body: {} },
    status: 200,
    body: null,
    ...overrides,
  } as any
}

describe('kanban controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists tasks with filters', async () => {
    mockListTasks.mockResolvedValue([{ id: 'task-1' }])
    const c = ctx({ query: { status: 'todo', assignee: 'alice', tenant: 'ops' } })
    await ctrl.list(c)
    expect(mockListTasks).toHaveBeenCalledWith({ status: 'todo', assignee: 'alice', tenant: 'ops' })
    expect(c.body).toEqual({ tasks: [{ id: 'task-1' }] })
  })

  it('enriches completed task details using the latest run profile', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 'task-1', status: 'done' },
      runs: [{ profile: 'stale' }, { profile: 'fresh' }],
      comments: [],
      events: [],
    })
    mockFindLatestExactSessionId.mockResolvedValue('session-1')
    mockGetExactSessionDetail.mockResolvedValue({
      title: 'Session one',
      source: 'codex',
      model: 'gpt-5.5',
      started_at: 1,
      ended_at: 2,
      messages: [],
    })

    const c = ctx({ params: { id: 'task-1' } })
    await ctrl.get(c)

    expect(mockFindLatestExactSessionId).toHaveBeenCalledWith('task-1', 'fresh')
    expect(mockGetExactSessionDetail).toHaveBeenCalledWith('session-1', 'fresh')
    expect(c.body.session).toMatchObject({ id: 'session-1', title: 'Session one' })
  })

  it('prefers exact kanban-task session matches over later sessions that merely reference the task id', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 't_348bfaaf', status: 'done' },
      runs: [{ profile: 'default' }],
      comments: [],
      events: [],
    })
    mockFindLatestExactSessionId.mockResolvedValue('session_20260508_110903_58e664')
    mockGetExactSessionDetail.mockResolvedValue({
      title: 'work kanban task t_348bfaaf',
      source: 'codex',
      model: 'gpt-5.5',
      started_at: 1,
      ended_at: 2,
      messages: [{ id: 'm1', role: 'user', content: 'work kanban task t_348bfaaf', timestamp: 1 }],
    })

    const c = ctx({ params: { id: 't_348bfaaf' } })
    await ctrl.get(c)

    expect(c.body.session).toMatchObject({
      id: 'session_20260508_110903_58e664',
      title: 'work kanban task t_348bfaaf',
    })
    expect(c.body.session.messages[0].content).toBe('work kanban task t_348bfaaf')
  })

  it('validates create/search/readArtifact requests', async () => {
    const createCtx = ctx({ request: { body: {} } })
    await ctrl.create(createCtx)
    expect(createCtx.status).toBe(400)

    const searchCtx = ctx({ query: { task_id: 'task-1' } })
    await ctrl.searchSessions(searchCtx)
    expect(searchCtx.status).toBe(400)

    const fileCtx = ctx({ query: { path: '/tmp/outside.txt' } })
    await ctrl.readArtifact(fileCtx)
    expect(fileCtx.status).toBe(403)
  })

  it('reads workspace artifacts and proxies action routes', async () => {
    mockReadFile.mockResolvedValue('artifact-content')
    mockCreateTask.mockResolvedValue({ id: 'task-2' })
    mockCompleteTasks.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockUnblockTasks.mockResolvedValue(undefined)
    mockAssignTask.mockResolvedValue(undefined)
    mockGetStats.mockResolvedValue({ total: 1, by_status: {}, by_assignee: {} })
    mockGetAssignees.mockResolvedValue([{ name: 'alice' }])
    mockSearchSessions.mockResolvedValue([{ id: 'session-2' }])
    mockFindLatestExactSessionId.mockResolvedValue('session-2')
    mockGetExactSessionDetail.mockResolvedValue({
      id: 'session-2',
      source: 'codex',
      title: 'Matched session',
      preview: 'task-id matched',
      model: 'gpt-5.5',
      started_at: 100,
      ended_at: 101,
      last_active: 101,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      messages: [],
      thread_session_count: 1,
    })

    const fileCtx = ctx({ query: { path: '/Users/tester/.hermes/kanban/workspaces/task/out.txt' } })
    await ctrl.readArtifact(fileCtx)
    expect(fileCtx.body).toEqual({
      content: 'artifact-content',
      path: '/Users/tester/.hermes/kanban/workspaces/task/out.txt',
    })

    const createCtx = ctx({ request: { body: { title: 'Ship', body: 'x' } } })
    await ctrl.create(createCtx)
    expect(createCtx.body).toEqual({ task: { id: 'task-2' } })

    const completeCtx = ctx({ request: { body: { task_ids: ['task-1'], summary: 'done' } } })
    await ctrl.complete(completeCtx)
    expect(mockCompleteTasks).toHaveBeenCalledWith(['task-1'], 'done')

    const blockCtx = ctx({ params: { id: 'task-1' }, request: { body: { reason: 'wait' } } })
    await ctrl.block(blockCtx)
    expect(mockBlockTask).toHaveBeenCalledWith('task-1', 'wait')

    const unblockCtx = ctx({ request: { body: { task_ids: ['task-1'] } } })
    await ctrl.unblock(unblockCtx)
    expect(mockUnblockTasks).toHaveBeenCalledWith(['task-1'])

    const assignCtx = ctx({ params: { id: 'task-1' }, request: { body: { profile: 'alice' } } })
    await ctrl.assign(assignCtx)
    expect(mockAssignTask).toHaveBeenCalledWith('task-1', 'alice')

    const statsCtx = ctx()
    await ctrl.stats(statsCtx)
    expect(statsCtx.body).toEqual({ stats: { total: 1, by_status: {}, by_assignee: {} } })

    const assigneesCtx = ctx()
    await ctrl.assignees(assigneesCtx)
    expect(assigneesCtx.body).toEqual({ assignees: [{ name: 'alice' }] })

    const searchCtx = ctx({ query: { task_id: 'task-1', profile: 'alice', q: 'custom' } })
    await ctrl.searchSessions(searchCtx)
    expect(mockSearchSessions).toHaveBeenCalledWith('custom', 'alice', undefined, 10)

    const exactSearchCtx = ctx({ query: { task_id: 'task-1', profile: 'alice' } })
    await ctrl.searchSessions(exactSearchCtx)
    expect(exactSearchCtx.body.results[0]).toMatchObject({ id: 'session-2', title: 'Matched session' })
  })
})
