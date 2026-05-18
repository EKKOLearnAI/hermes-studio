import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Pin os.homedir to a deterministic, test-controlled value. The artifact
// path-traversal assertions below must derive BOTH the attack path and the
// controller's kanbanDir (resolve(homedir(), '.hermes/kanban/workspaces'))
// from the SAME home, independent of the machine's real $HOME and immune to
// os mocks leaked by sibling test files (e.g. auth.test.ts's
// vi.doMock('os') without doUnmock, kanban-controller.test.ts's
// vi.mock('os')). vi.mock is hoisted and re-applied across the
// vi.resetModules() in loadController, so the controller and this file always
// agree on homedir. workspaces-evil remains a real sibling of workspaces
// under this home, so the containment boundary is genuinely exercised: if the
// impl's pathInsideDir guard were removed or weakened, the sibling-prefix
// assertion would still fail.
const FIXED_HOME = join(tmpdir(), 'kanban-isolation-home')
vi.mock('os', async () => ({
  ...(await vi.importActual<typeof import('os')>('os')),
  homedir: () => FIXED_HOME,
}))
const { homedir } = await import('os')

const mockListTasks = vi.hoisted(() => vi.fn())
const mockGetTask = vi.hoisted(() => vi.fn())
const mockCreateTask = vi.hoisted(() => vi.fn())
const mockAssignTask = vi.hoisted(() => vi.fn())
const mockCompleteTasks = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockUnblockTasks = vi.hoisted(() => vi.fn())
const mockReadFile = vi.hoisted(() => vi.fn())
const mockSearchSessions = vi.hoisted(() => vi.fn())
const mockGetSessionDetail = vi.hoisted(() => vi.fn())
const mockGetExactSessionDetail = vi.hoisted(() => vi.fn())
const mockFindLatestExactSessionId = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/hermes-kanban', () => ({
  normalizeBoardSlug: (board?: string | null) => {
    const value = board?.trim() || 'default'
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) throw new Error('Invalid kanban board slug')
    return value
  },
  listTasks: mockListTasks,
  getTask: mockGetTask,
  createTask: mockCreateTask,
  assignTask: mockAssignTask,
  completeTasks: mockCompleteTasks,
  blockTask: mockBlockTask,
  unblockTasks: mockUnblockTasks,
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  searchSessionSummariesWithProfile: mockSearchSessions,
  getSessionDetailFromDbWithProfile: mockGetSessionDetail,
  getExactSessionDetailFromDbWithProfile: mockGetExactSessionDetail,
  findLatestExactSessionIdWithProfile: mockFindLatestExactSessionId,
}))

const originalEnv = process.env

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
}))

function createRoutingDb() {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-isolation-'))
  const dbPath = join(dir, 'multitenancy.db')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE multitenancy_routing (
        user_id TEXT PRIMARY KEY,
        profile_name TEXT NOT NULL,
        open_id TEXT NOT NULL,
        owner_open_id TEXT,
        provenance TEXT,
        active INTEGER NOT NULL DEFAULT 1
      )
    `)

    db.prepare(`
      INSERT INTO multitenancy_routing (user_id, profile_name, open_id, owner_open_id, provenance, active)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('user-ouA', 'profA', 'ouA', 'ouA', 'sync', 1)
  } finally {
    db.close()
  }

  return { dir, dbPath }
}

function ctx({
  openid,
  query = {},
  params = {},
  body = {},
}: {
  openid?: string
  query?: Record<string, any>
  params?: Record<string, any>
  body?: Record<string, any>
} = {}) {
  return {
    state: openid ? { user: { openid } } : {},
    query,
    params,
    request: { body },
    status: 200,
    body: null,
  } as any
}

async function loadController(multitenancyDbPath: string) {
  vi.resetModules()
  process.env = { ...originalEnv, HERMES_MULTITENANCY_DB: multitenancyDbPath }
  return import('../../packages/server/src/controllers/hermes/kanban')
}

function taskDetail(task: { id: string; assignee: string | null; created_by?: string | null; status?: string; tenant?: string | null }) {
  return {
    task: {
      id: task.id,
      status: task.status ?? 'todo',
      assignee: task.assignee,
      created_by: task.created_by ?? null,
      tenant: task.tenant ?? null,
    },
    runs: [],
    comments: [],
    events: [],
  }
}

describe('kanban owner isolation', () => {
  let dbDir = ''
  let dbPath = ''

  beforeEach(() => {
    vi.clearAllMocks()
    const db = createRoutingDb()
    dbDir = db.dir
    dbPath = db.dbPath
  })

  afterEach(() => {
    process.env = originalEnv
    if (dbDir) {
      rmSync(dbDir, { recursive: true, force: true })
      dbDir = ''
      dbPath = ''
    }
    vi.clearAllMocks()
  })

  it('filters task list by owned assignee and excludes null assignee tasks', async () => {
    mockListTasks.mockResolvedValue([
      { id: 't1', assignee: 'profA', created_by: null },
      { id: 't2', assignee: 'profB', created_by: null },
      { id: 't3', assignee: null, created_by: null },
    ])
    const ctrl = await loadController(dbPath)

    const c = ctx({ openid: 'ouA' })
    await ctrl.list(c)

    expect(c.status).toBe(200)
    expect(c.body.tasks).toEqual([{ id: 't1', assignee: 'profA', created_by: null }])
  })

  it('enforces ownership on assign and allows owned profile assignment', async () => {
    mockAssignTask.mockResolvedValue(undefined)
    const ctrl = await loadController(dbPath)

    const denied = ctx({ openid: 'ouA', params: { id: 't1' }, body: { profile: 'profB' } })
    await ctrl.assign(denied)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'You do not own this agent profile' })
    expect(mockAssignTask).not.toHaveBeenCalled()

    const allowed = ctx({ openid: 'ouA', params: { id: 't1' }, body: { profile: 'profA' } })
    await ctrl.assign(allowed)
    expect(allowed.status).toBe(200)
    expect(allowed.body).toEqual({ ok: true })
    expect(mockAssignTask).toHaveBeenCalledWith('t1', 'profA', { board: 'default' })
  })

  it('rejects searchSessions for an unowned profile', async () => {
    const ctrl = await loadController(dbPath)

    const c = ctx({ openid: 'ouA', query: { task_id: 't1', profile: 'profB' } })
    await ctrl.searchSessions(c)

    expect(c.status).toBe(403)
    expect(c.body).toEqual({ error: 'You do not own this agent profile' })
    expect(mockFindLatestExactSessionId).not.toHaveBeenCalled()
    expect(mockSearchSessions).not.toHaveBeenCalled()
  })

  it('returns 401 for unauthenticated list, assign, get, searchSessions, and create requests', async () => {
    const ctrl = await loadController(dbPath)

    const listCtx = ctx()
    await ctrl.list(listCtx)
    expect(listCtx.status).toBe(401)
    expect(listCtx.body).toEqual({ error: 'Unauthorized' })

    const assignCtx = ctx({ params: { id: 't1' }, body: { profile: 'profA' } })
    await ctrl.assign(assignCtx)
    expect(assignCtx.status).toBe(401)
    expect(assignCtx.body).toEqual({ error: 'Unauthorized' })

    const getCtx = ctx({ params: { id: 't9' } })
    await ctrl.get(getCtx)
    expect(getCtx.status).toBe(401)
    expect(getCtx.body).toEqual({ error: 'Unauthorized' })

    const searchCtx = ctx({ query: { task_id: 't1', profile: 'profA' } })
    await ctrl.searchSessions(searchCtx)
    expect(searchCtx.status).toBe(401)
    expect(searchCtx.body).toEqual({ error: 'Unauthorized' })

    const createCtx = ctx({ body: { title: 'Ship' } })
    await ctrl.create(createCtx)
    expect(createCtx.status).toBe(401)
    expect(createCtx.body).toEqual({ error: 'Unauthorized' })

    expect(mockListTasks).not.toHaveBeenCalled()
    expect(mockAssignTask).not.toHaveBeenCalled()
    expect(mockGetTask).not.toHaveBeenCalled()
    expect(mockFindLatestExactSessionId).not.toHaveBeenCalled()
    expect(mockSearchSessions).not.toHaveBeenCalled()
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('hides unowned task details and returns owned task details', async () => {
    mockGetTask
      .mockResolvedValueOnce({
        task: { id: 't9', status: 'todo', assignee: 'profB', created_by: null },
        runs: [],
        comments: [],
        events: [],
      })
      .mockResolvedValueOnce({
        task: { id: 't9', status: 'todo', assignee: 'profA', created_by: null },
        runs: [],
        comments: [],
        events: [],
      })
    const ctrl = await loadController(dbPath)

    const denied = ctx({ openid: 'ouA', params: { id: 't9' } })
    await ctrl.get(denied)
    expect(denied.status).toBe(404)
    expect(denied.body).toEqual({ error: 'Task not found' })

    const allowed = ctx({ openid: 'ouA', params: { id: 't9' } })
    await ctrl.get(allowed)
    expect(allowed.status).toBe(200)
    expect(allowed.body.task.id).toBe('t9')
  })

  it('prefers created_by ownership over assignee ownership in list results', async () => {
    mockListTasks.mockResolvedValue([
      { id: 'tc', assignee: 'profB', created_by: 'profA' },
    ])
    const ctrl = await loadController(dbPath)

    const c = ctx({ openid: 'ouA' })
    await ctrl.list(c)

    expect(c.body.tasks).toEqual([{ id: 'tc', assignee: 'profB', created_by: 'profA' }])
  })

  it('uses the same assign handler to allow owned profiles and deny unowned profiles', async () => {
    mockAssignTask.mockResolvedValue(undefined)
    const ctrl = await loadController(dbPath)

    const allowed = ctx({ openid: 'ouA', params: { id: 't1' }, body: { profile: 'profA' } })
    await ctrl.assign(allowed)
    expect(allowed.status).toBe(200)
    expect(allowed.body).toEqual({ ok: true })
    expect(mockAssignTask).toHaveBeenCalledTimes(1)

    const denied = ctx({ openid: 'ouA', params: { id: 't1' }, body: { profile: 'profB' } })
    await ctrl.assign(denied)
    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'You do not own this agent profile' })
    expect(mockAssignTask).toHaveBeenCalledTimes(1)
  })

  it('rejects created tasks assigned to unowned profiles or spoofed tenants', async () => {
    mockCreateTask.mockResolvedValue({ id: 'created' })
    const ctrl = await loadController(dbPath)

    const unownedAssignee = ctx({ openid: 'ouA', body: { title: 'Ship', assignee: 'profB' } })
    await ctrl.create(unownedAssignee)
    expect(unownedAssignee.status).toBe(403)
    expect(unownedAssignee.body).toEqual({ error: 'You do not own this agent profile' })
    expect(mockCreateTask).not.toHaveBeenCalled()

    const spoofedTenant = ctx({ openid: 'ouA', body: { title: 'Ship', assignee: 'profA', tenant: 'ouB' } })
    await ctrl.create(spoofedTenant)
    expect(spoofedTenant.status).toBe(403)
    expect(spoofedTenant.body).toEqual({ error: 'You cannot create tasks for another tenant' })
    expect(mockCreateTask).not.toHaveBeenCalled()

    const allowed = ctx({ openid: 'ouA', body: { title: 'Ship', assignee: 'profA' } })
    await ctrl.create(allowed)
    expect(allowed.status).toBe(200)
    expect(mockCreateTask).toHaveBeenCalledWith('Ship', {
      board: 'default',
      body: undefined,
      assignee: 'profA',
      priority: undefined,
      tenant: 'ouA',
    })
  })

  it('returns 403 and does not complete unowned tasks', async () => {
    mockGetTask.mockResolvedValue(taskDetail({ id: 't-complete', assignee: 'profB' }))
    const ctrl = await loadController(dbPath)

    const denied = ctx({ openid: 'ouA', body: { task_ids: ['t-complete'], summary: 'done' } })
    await ctrl.complete(denied)

    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'You do not own one or more of these tasks' })
    expect(mockCompleteTasks).not.toHaveBeenCalled()
  })

  it('returns 403 and does not block an unowned task', async () => {
    mockGetTask.mockResolvedValue(taskDetail({ id: 't-block', assignee: 'profB' }))
    const ctrl = await loadController(dbPath)

    const denied = ctx({ openid: 'ouA', params: { id: 't-block' }, body: { reason: 'waiting' } })
    await ctrl.block(denied)

    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'You do not own one or more of these tasks' })
    expect(mockBlockTask).not.toHaveBeenCalled()
  })

  it('returns 403 and does not unblock unowned tasks', async () => {
    mockGetTask.mockResolvedValue(taskDetail({ id: 't-unblock', assignee: 'profB' }))
    const ctrl = await loadController(dbPath)

    const denied = ctx({ openid: 'ouA', body: { task_ids: ['t-unblock'] } })
    await ctrl.unblock(denied)

    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'You do not own one or more of these tasks' })
    expect(mockUnblockTasks).not.toHaveBeenCalled()
  })

  it('fails closed for complete when any requested task is unowned', async () => {
    mockGetTask
      .mockResolvedValueOnce(taskDetail({ id: 'owned', assignee: 'profA' }))
      .mockResolvedValueOnce(taskDetail({ id: 'unowned', assignee: 'profB' }))
    const ctrl = await loadController(dbPath)

    const denied = ctx({ openid: 'ouA', body: { task_ids: ['owned', 'unowned'], summary: 'mixed' } })
    await ctrl.complete(denied)

    expect(denied.status).toBe(403)
    expect(denied.body).toEqual({ error: 'You do not own one or more of these tasks' })
    expect(mockCompleteTasks).not.toHaveBeenCalled()
  })

  it('allows owned complete, block, and unblock mutations', async () => {
    mockCompleteTasks.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockUnblockTasks.mockResolvedValue(undefined)
    mockGetTask.mockImplementation(async (taskId: string) => {
      if (taskId === 't-complete-owned') return taskDetail({ id: taskId, assignee: 'profA' })
      if (taskId === 't-block-owned') return taskDetail({ id: taskId, assignee: 'profA' })
      if (taskId === 't-unblock-owned') return taskDetail({ id: taskId, created_by: 'profA', assignee: 'profB' })
      return null
    })
    const ctrl = await loadController(dbPath)

    const completeCtx = ctx({ openid: 'ouA', body: { task_ids: ['t-complete-owned'], summary: 'ok' } })
    await ctrl.complete(completeCtx)
    expect(completeCtx.status).toBe(200)
    expect(completeCtx.body).toEqual({ ok: true })
    expect(mockCompleteTasks).toHaveBeenCalledWith(['t-complete-owned'], 'ok', { board: 'default' })

    const blockCtx = ctx({ openid: 'ouA', params: { id: 't-block-owned' }, body: { reason: 'hold' } })
    await ctrl.block(blockCtx)
    expect(blockCtx.status).toBe(200)
    expect(blockCtx.body).toEqual({ ok: true })
    expect(mockBlockTask).toHaveBeenCalledWith('t-block-owned', 'hold', { board: 'default' })

    const unblockCtx = ctx({ openid: 'ouA', body: { task_ids: ['t-unblock-owned'] } })
    await ctrl.unblock(unblockCtx)
    expect(unblockCtx.status).toBe(200)
    expect(unblockCtx.body).toEqual({ ok: true })
    expect(mockUnblockTasks).toHaveBeenCalledWith(['t-unblock-owned'], { board: 'default' })
  })

  it('returns 401 for unauthenticated complete, block, and unblock requests', async () => {
    const ctrl = await loadController(dbPath)

    const completeCtx = ctx({ body: { task_ids: ['t1'], summary: 'done' } })
    await ctrl.complete(completeCtx)
    expect(completeCtx.status).toBe(401)
    expect(completeCtx.body).toEqual({ error: 'Unauthorized' })

    const blockCtx = ctx({ params: { id: 't1' }, body: { reason: 'blocked' } })
    await ctrl.block(blockCtx)
    expect(blockCtx.status).toBe(401)
    expect(blockCtx.body).toEqual({ error: 'Unauthorized' })

    const unblockCtx = ctx({ body: { task_ids: ['t1'] } })
    await ctrl.unblock(unblockCtx)
    expect(unblockCtx.status).toBe(401)
    expect(unblockCtx.body).toEqual({ error: 'Unauthorized' })

    expect(mockGetTask).not.toHaveBeenCalled()
    expect(mockCompleteTasks).not.toHaveBeenCalled()
    expect(mockBlockTask).not.toHaveBeenCalled()
    expect(mockUnblockTasks).not.toHaveBeenCalled()
  })

  it('does not read artifacts for unowned tasks or sibling workspace prefixes', async () => {
    mockReadFile.mockResolvedValue('secret')
    mockGetTask.mockResolvedValue(taskDetail({ id: 'task-unowned', assignee: 'profB' }))
    const ctrl = await loadController(dbPath)

    const denied = ctx({
      openid: 'ouA',
      query: { path: join(homedir(), '.hermes', 'kanban', 'workspaces', 'task-unowned', 'out.txt') },
    })
    await ctrl.readArtifact(denied)
    expect(denied.status).toBe(404)
    expect(denied.body).toEqual({ error: 'Task not found' })
    expect(mockReadFile).not.toHaveBeenCalled()

    const siblingPrefix = ctx({
      openid: 'ouA',
      query: { path: join(homedir(), '.hermes', 'kanban', 'workspaces-evil', 'task-owned', 'out.txt') },
    })
    await ctrl.readArtifact(siblingPrefix)
    expect(siblingPrefix.status).toBe(403)
    expect(siblingPrefix.body).toEqual({ error: 'Path must be within kanban workspaces' })
    expect(mockReadFile).not.toHaveBeenCalled()
  })
})
