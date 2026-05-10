import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockReadFile = vi.hoisted(() => vi.fn())
const mockListBoards = vi.hoisted(() => vi.fn())
const mockCreateBoard = vi.hoisted(() => vi.fn())
const mockArchiveBoard = vi.hoisted(() => vi.fn())
const mockGetCapabilities = vi.hoisted(() => vi.fn())
const mockListTasks = vi.hoisted(() => vi.fn())
const mockGetTask = vi.hoisted(() => vi.fn())
const mockCreateTask = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockAssignTask = vi.hoisted(() => vi.fn())
const mockAddComment = vi.hoisted(() => vi.fn())
const mockLinkTasks = vi.hoisted(() => vi.fn())
const mockUnlinkTasks = vi.hoisted(() => vi.fn())
const mockBulkUpdateTasks = vi.hoisted(() => vi.fn())
const mockGetTaskLog = vi.hoisted(() => vi.fn())
const mockGetDiagnostics = vi.hoisted(() => vi.fn())
const mockReclaimTask = vi.hoisted(() => vi.fn())
const mockReassignTask = vi.hoisted(() => vi.fn())
const mockSpecifyTask = vi.hoisted(() => vi.fn())
const mockDispatch = vi.hoisted(() => vi.fn())
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
  normalizeBoardSlug: (board?: string | null) => {
    const value = board?.trim().toLowerCase() || 'default'
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid kanban board slug')
    return value
  },
  listBoards: mockListBoards,
  createBoard: mockCreateBoard,
  archiveBoard: mockArchiveBoard,
  getCapabilities: mockGetCapabilities,
  listTasks: mockListTasks,
  getTask: mockGetTask,
  createTask: mockCreateTask,
  completeTasks: mockCompleteTasks,
  blockTask: mockBlockTask,
  unblockTasks: mockUnblockTasks,
  assignTask: mockAssignTask,
  addComment: mockAddComment,
  linkTasks: mockLinkTasks,
  unlinkTasks: mockUnlinkTasks,
  bulkUpdateTasks: mockBulkUpdateTasks,
  getTaskLog: mockGetTaskLog,
  getDiagnostics: mockGetDiagnostics,
  reclaimTask: mockReclaimTask,
  reassignTask: mockReassignTask,
  specifyTask: mockSpecifyTask,
  dispatch: mockDispatch,
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

  it('lists boards and tasks with explicit/default board context', async () => {
    mockListBoards.mockResolvedValue([{ slug: 'default' }])
    mockListTasks.mockResolvedValue([{ id: 'task-1' }])

    const boardsCtx = ctx({ query: { includeArchived: 'true' } })
    await ctrl.listBoards(boardsCtx)
    expect(mockListBoards).toHaveBeenCalledWith({ includeArchived: true })
    expect(boardsCtx.body).toEqual({ boards: [{ slug: 'default' }] })

    const c = ctx({ query: { board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops', includeArchived: 'true' } })
    await ctrl.list(c)
    expect(mockListTasks).toHaveBeenCalledWith({ board: 'project-a', status: 'todo', assignee: 'alice', tenant: 'ops', includeArchived: true })
    expect(c.body).toEqual({ tasks: [{ id: 'task-1' }] })

    mockCreateBoard.mockResolvedValue({ slug: 'project-b' })
    const createBoardCtx = ctx({ request: { body: { slug: 'project-b', name: 'Project B', switchCurrent: false } } })
    await ctrl.createBoard(createBoardCtx)
    expect(mockCreateBoard).toHaveBeenCalledWith({ slug: 'project-b', name: 'Project B', description: undefined, icon: undefined, color: undefined, switchCurrent: false })
    expect(createBoardCtx.body).toEqual({ board: { slug: 'project-b' } })

    mockArchiveBoard.mockResolvedValue(undefined)
    const archiveCtx = ctx({ params: { slug: 'project-b' } })
    await ctrl.archiveBoard(archiveCtx)
    expect(mockArchiveBoard).toHaveBeenCalledWith('project-b')
    expect(archiveCtx.body).toEqual({ ok: true })

    mockGetCapabilities.mockResolvedValue({ source: 'hermes-cli', supports: {}, missing: [] })
    const capabilitiesCtx = ctx()
    await ctrl.capabilities(capabilitiesCtx)
    expect(capabilitiesCtx.body).toEqual({ capabilities: { source: 'hermes-cli', supports: {}, missing: [] } })

    const defaultCtx = ctx({ query: { status: 'ready' } })
    await ctrl.list(defaultCtx)
    expect(mockListTasks).toHaveBeenLastCalledWith({ board: 'default', status: 'ready', assignee: undefined, tenant: undefined, includeArchived: false })
  })

  it('proxies comment/log/diagnostics with explicit board context', async () => {
    const taskLog = { task_id: 'task-1', path: null, exists: true, size_bytes: 10, content: 'worker log', truncated: false }
    mockAddComment.mockResolvedValue({ ok: true, output: 'commented' })
    mockGetTaskLog.mockResolvedValue(taskLog)
    mockGetDiagnostics.mockResolvedValue([{ task_id: 'task-1' }])

    const commentCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { body: 'needs review', author: 'han' } } })
    await ctrl.addComment(commentCtx)
    expect(mockAddComment).toHaveBeenCalledWith('task-1', 'needs review', { board: 'project-a', author: 'han' })
    expect(commentCtx.body).toEqual({ ok: true, output: 'commented' })

    const logCtx = ctx({ query: { board: 'default', tail: '4000' }, params: { id: 'task-1' } })
    await ctrl.taskLog(logCtx)
    expect(mockGetTaskLog).toHaveBeenCalledWith('task-1', { board: 'default', tail: 4000 })
    expect(logCtx.body).toEqual(taskLog)

    const diagnosticsCtx = ctx({ query: { board: 'default', task: 'task-1', severity: 'warning' } })
    await ctrl.diagnostics(diagnosticsCtx)
    expect(mockGetDiagnostics).toHaveBeenCalledWith({ board: 'default', task: 'task-1', severity: 'warning' })
    expect(diagnosticsCtx.body).toEqual({ diagnostics: [{ task_id: 'task-1' }] })
  })

  it('proxies links and bulk actions with explicit board context', async () => {
    mockLinkTasks.mockResolvedValue({ ok: true, output: 'linked' })
    mockUnlinkTasks.mockResolvedValue({ ok: true, output: 'unlinked' })
    mockBulkUpdateTasks.mockResolvedValue({ results: [{ id: 'task-1', ok: true }] })

    const linkCtx = ctx({ query: { board: 'project-a' }, request: { body: { parent_id: 'task-1', child_id: 'task-2' } } })
    await ctrl.linkTasks(linkCtx)
    expect(mockLinkTasks).toHaveBeenCalledWith('task-1', 'task-2', { board: 'project-a' })
    expect(linkCtx.body).toEqual({ ok: true, output: 'linked' })

    const unlinkCtx = ctx({ query: { board: 'project-a', parent_id: 'task-1', child_id: 'task-2' } })
    await ctrl.unlinkTasks(unlinkCtx)
    expect(mockUnlinkTasks).toHaveBeenCalledWith('task-1', 'task-2', { board: 'project-a' })
    expect(unlinkCtx.body).toEqual({ ok: true, output: 'unlinked' })

    const bulkCtx = ctx({ query: { board: 'project-a' }, request: { body: { ids: ['task-1'], status: 'done', assignee: null, summary: 'closed' } } })
    await ctrl.bulkUpdateTasks(bulkCtx)
    expect(mockBulkUpdateTasks).toHaveBeenCalledWith({ board: 'project-a', ids: ['task-1'], status: 'done', assignee: null, archive: undefined, summary: 'closed', reason: undefined })
    expect(bulkCtx.body).toEqual({ results: [{ id: 'task-1', ok: true }] })
  })

  it('validates canonical parity endpoint inputs before shelling out', async () => {
    const invalidTailCtx = ctx({ query: { board: 'default', tail: '0' }, params: { id: 'task-1' } })
    await ctrl.taskLog(invalidTailCtx)
    expect(invalidTailCtx.status).toBe(400)
    expect(mockGetTaskLog).not.toHaveBeenCalled()

    const oversizedTailCtx = ctx({ query: { board: 'default', tail: '1000001' }, params: { id: 'task-1' } })
    await ctrl.taskLog(oversizedTailCtx)
    expect(oversizedTailCtx.status).toBe(400)
    expect(mockGetTaskLog).not.toHaveBeenCalled()

    const invalidSeverityCtx = ctx({ query: { board: 'default', severity: 'info' } })
    await ctrl.diagnostics(invalidSeverityCtx)
    expect(invalidSeverityCtx.status).toBe(400)
    expect(mockGetDiagnostics).not.toHaveBeenCalled()

    const emptyBoardCtx = ctx({ query: { board: ' ' } })
    await ctrl.list(emptyBoardCtx)
    expect(emptyBoardCtx.status).toBe(400)
    expect(mockListTasks).not.toHaveBeenCalled()

    const invalidDispatchCtx = ctx({ query: { board: 'default' }, request: { body: { dryRun: 'yes', max: -1, failureLimit: 0 } } })
    await ctrl.dispatch(invalidDispatchCtx)
    expect(invalidDispatchCtx.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()

    const oversizedDispatchCtx = ctx({ query: { board: 'default' }, request: { body: { dryRun: false, max: 999999999 } } })
    await ctrl.dispatch(oversizedDispatchCtx)
    expect(oversizedDispatchCtx.status).toBe(400)
    expect(mockDispatch).not.toHaveBeenCalled()
  })

  it('rejects malformed parity action bodies before shelling out', async () => {
    const cases: Array<{ name: string; invoke: (c: any) => Promise<void>; context: any; mock: ReturnType<typeof vi.fn> }> = [
      { name: 'comment body object', invoke: ctrl.addComment, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { body: {}, author: 'han' } } }), mock: mockAddComment },
      { name: 'comment request body array', invoke: ctrl.addComment, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: [] } }), mock: mockAddComment },
      { name: 'comment author object', invoke: ctrl.addComment, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { body: 'ok', author: {} } } }), mock: mockAddComment },
      { name: 'link missing child', invoke: ctrl.linkTasks, context: ctx({ query: { board: 'default' }, request: { body: { parent_id: 'task-1' } } }), mock: mockLinkTasks },
      { name: 'unlink missing parent', invoke: ctrl.unlinkTasks, context: ctx({ query: { board: 'default', child_id: 'task-2' } }), mock: mockUnlinkTasks },
      { name: 'bulk empty ids', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: [], status: 'done' } } }), mock: mockBulkUpdateTasks },
      { name: 'bulk invalid status', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: ['task-1'], status: 'invalid' } } }), mock: mockBulkUpdateTasks },
      { name: 'bulk archive with status', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: ['task-1'], archive: true, status: 'done' } } }), mock: mockBulkUpdateTasks },
      { name: 'bulk no action', invoke: ctrl.bulkUpdateTasks, context: ctx({ query: { board: 'default' }, request: { body: { ids: ['task-1'] } } }), mock: mockBulkUpdateTasks },
      { name: 'reclaim request body string', invoke: ctrl.reclaim, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: 'bad' } }), mock: mockReclaimTask },
      { name: 'reclaim reason array', invoke: ctrl.reclaim, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { reason: [] } } }), mock: mockReclaimTask },
      { name: 'reassign reclaim string', invoke: ctrl.reassign, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 'bob', reclaim: 'false' } } }), mock: mockReassignTask },
      { name: 'reassign reclaim number', invoke: ctrl.reassign, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 'bob', reclaim: 1 } } }), mock: mockReassignTask },
      { name: 'reassign profile number', invoke: ctrl.reassign, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { profile: 123 } } }), mock: mockReassignTask },
      { name: 'specify request body number', invoke: ctrl.specify, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: 123 } }), mock: mockSpecifyTask },
      { name: 'specify author object', invoke: ctrl.specify, context: ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { author: {} } } }), mock: mockSpecifyTask },
      { name: 'dispatch request body array', invoke: ctrl.dispatch, context: ctx({ query: { board: 'default' }, request: { body: [] } }), mock: mockDispatch },
    ]

    for (const testCase of cases) {
      vi.clearAllMocks()
      await testCase.invoke(testCase.context)
      expect(testCase.context.status, testCase.name).toBe(400)
      expect(testCase.mock, testCase.name).not.toHaveBeenCalled()
    }
  })

  it('proxies recovery and dispatch actions with explicit board context', async () => {
    mockReclaimTask.mockResolvedValue({ ok: true, output: 'reclaimed' })
    mockReassignTask.mockResolvedValue({ ok: true, output: 'reassigned' })
    mockSpecifyTask.mockResolvedValue([{ task_id: 'task-1' }])
    mockDispatch.mockResolvedValue({ spawned: 1 })

    const reclaimCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { reason: 'stale' } } })
    await ctrl.reclaim(reclaimCtx)
    expect(mockReclaimTask).toHaveBeenCalledWith('task-1', { board: 'project-a', reason: 'stale' })

    const reassignCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { profile: 'bob', reclaim: true, reason: 'handoff' } } })
    await ctrl.reassign(reassignCtx)
    expect(mockReassignTask).toHaveBeenCalledWith('task-1', 'bob', { board: 'project-a', reclaim: true, reason: 'handoff' })

    const specifyCtx = ctx({ query: { board: 'default' }, params: { id: 'task-1' }, request: { body: { author: 'han' } } })
    await ctrl.specify(specifyCtx)
    expect(mockSpecifyTask).toHaveBeenCalledWith('task-1', { board: 'default', author: 'han' })
    expect(specifyCtx.body).toEqual({ results: [{ task_id: 'task-1' }] })

    const dispatchCtx = ctx({ query: { board: 'default' }, request: { body: { dryRun: true, max: 2, failureLimit: 3 } } })
    await ctrl.dispatch(dispatchCtx)
    expect(mockDispatch).toHaveBeenCalledWith({ board: 'default', dryRun: true, max: 2, failureLimit: 3 })
    expect(dispatchCtx.body).toEqual({ result: { spawned: 1 } })
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

    const c = ctx({ params: { id: 'task-1' }, query: { board: 'project-a' } })
    await ctrl.get(c)

    expect(mockFindLatestExactSessionId).toHaveBeenCalledWith('task-1', 'fresh')
    expect(mockGetExactSessionDetail).toHaveBeenCalledWith('session-1', 'fresh')
    expect(c.body.session).toMatchObject({ id: 'session-1', title: 'Session one' })
  })

  it('enriches archived task details using the latest run profile', async () => {
    mockGetTask.mockResolvedValue({
      task: { id: 'task-archived', status: 'archived' },
      runs: [{ profile: 'reviewer' }],
      comments: [],
      events: [],
    })
    mockFindLatestExactSessionId.mockResolvedValue('session-archived')
    mockGetExactSessionDetail.mockResolvedValue({
      title: 'Archived session',
      source: 'codex',
      model: 'gpt-5.5',
      started_at: 1,
      ended_at: 2,
      messages: [],
    })

    const c = ctx({ params: { id: 'task-archived' }, query: { board: 'project-a' } })
    await ctrl.get(c)

    expect(mockFindLatestExactSessionId).toHaveBeenCalledWith('task-archived', 'reviewer')
    expect(mockGetExactSessionDetail).toHaveBeenCalledWith('session-archived', 'reviewer')
    expect(c.body.session).toMatchObject({ id: 'session-archived', title: 'Archived session' })
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

    const c = ctx({ params: { id: 't_348bfaaf' }, query: { board: 'project-a' } })
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
    expect(mockCreateTask).not.toHaveBeenCalled()

    const invalidCompleteCtx = ctx({ request: { body: { task_ids: ['task-1', 123] } } })
    await ctrl.complete(invalidCompleteCtx)
    expect(invalidCompleteCtx.status).toBe(400)
    expect(mockCompleteTasks).not.toHaveBeenCalled()

    const invalidBlockCtx = ctx({ params: { id: 'task-1' }, request: { body: { reason: [] } } })
    await ctrl.block(invalidBlockCtx)
    expect(invalidBlockCtx.status).toBe(400)
    expect(mockBlockTask).not.toHaveBeenCalled()

    const invalidUnblockCtx = ctx({ request: { body: [] } })
    await ctrl.unblock(invalidUnblockCtx)
    expect(invalidUnblockCtx.status).toBe(400)
    expect(mockUnblockTasks).not.toHaveBeenCalled()

    const invalidAssignCtx = ctx({ params: { id: 'task-1' }, request: { body: { profile: 123 } } })
    await ctrl.assign(invalidAssignCtx)
    expect(invalidAssignCtx.status).toBe(400)
    expect(mockAssignTask).not.toHaveBeenCalled()

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

    const createCtx = ctx({ query: { board: 'project-a' }, request: { body: { title: 'Ship', body: 'x' } } })
    await ctrl.create(createCtx)
    expect(mockCreateTask).toHaveBeenCalledWith('Ship', { board: 'project-a', body: 'x', assignee: undefined, priority: undefined, tenant: undefined })
    expect(createCtx.body).toEqual({ task: { id: 'task-2' } })

    const completeCtx = ctx({ query: { board: 'project-a' }, request: { body: { task_ids: ['task-1'], summary: 'done' } } })
    await ctrl.complete(completeCtx)
    expect(mockCompleteTasks).toHaveBeenCalledWith(['task-1'], 'done', { board: 'project-a' })

    const blockCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { reason: 'wait' } } })
    await ctrl.block(blockCtx)
    expect(mockBlockTask).toHaveBeenCalledWith('task-1', 'wait', { board: 'project-a' })

    const unblockCtx = ctx({ query: { board: 'project-a' }, request: { body: { task_ids: ['task-1'] } } })
    await ctrl.unblock(unblockCtx)
    expect(mockUnblockTasks).toHaveBeenCalledWith(['task-1'], { board: 'project-a' })

    const assignCtx = ctx({ query: { board: 'project-a' }, params: { id: 'task-1' }, request: { body: { profile: 'alice' } } })
    await ctrl.assign(assignCtx)
    expect(mockAssignTask).toHaveBeenCalledWith('task-1', 'alice', { board: 'project-a' })

    const statsCtx = ctx({ query: { board: 'project-a' } })
    await ctrl.stats(statsCtx)
    expect(mockGetStats).toHaveBeenCalledWith({ board: 'project-a' })
    expect(statsCtx.body).toEqual({ stats: { total: 1, by_status: {}, by_assignee: {} } })

    const assigneesCtx = ctx({ query: { board: 'project-a' } })
    await ctrl.assignees(assigneesCtx)
    expect(mockGetAssignees).toHaveBeenCalledWith({ board: 'project-a' })
    expect(assigneesCtx.body).toEqual({ assignees: [{ name: 'alice' }] })

    const searchCtx = ctx({ query: { task_id: 'task-1', profile: 'alice', q: 'custom' } })
    await ctrl.searchSessions(searchCtx)
    expect(mockSearchSessions).toHaveBeenCalledWith('custom', 'alice', undefined, 10)

    const exactSearchCtx = ctx({ query: { task_id: 'task-1', profile: 'alice' } })
    await ctrl.searchSessions(exactSearchCtx)
    expect(exactSearchCtx.body.results[0]).toMatchObject({ id: 'session-2', title: 'Matched session' })
  })
})
