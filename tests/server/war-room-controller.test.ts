import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSnapshot = vi.hoisted(() => vi.fn())
const mockCreateTask = vi.hoisted(() => vi.fn())
const mockHandoffTask = vi.hoisted(() => vi.fn())
const mockBlockTask = vi.hoisted(() => vi.fn())
const mockCompleteTask = vi.hoisted(() => vi.fn())
const mockGetEvidence = vi.hoisted(() => vi.fn())

vi.mock('../../packages/server/src/services/hermes/war-room', () => ({
  getSnapshot: mockGetSnapshot,
  createTask: mockCreateTask,
  handoffTask: mockHandoffTask,
  blockTask: mockBlockTask,
  completeTask: mockCompleteTask,
  getEvidence: mockGetEvidence,
}))

import * as ctrl from '../../packages/server/src/controllers/hermes/war-room'

function ctx(overrides: Record<string, any> = {}) {
  const headers = overrides.headers || {}
  return {
    query: {},
    params: {},
    request: { body: {} },
    status: 200,
    body: null,
    headers,
    get: (name: string) => headers[name] || headers[name.toLowerCase()] || '',
    ...overrides,
  } as any
}

describe('war-room controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads snapshot with X-Hermes-Profile when query/body profile is absent', async () => {
    mockGetSnapshot.mockResolvedValue({ members: [], tasks: [], stats: null, reports: [], generated_at: 123 })

    const c = ctx({ headers: { 'X-Hermes-Profile': 'ops_profile' } })
    await ctrl.snapshot(c)

    expect(mockGetSnapshot).toHaveBeenCalledWith('ops_profile')
    expect(c.body).toEqual({ snapshot: { members: [], tasks: [], stats: null, reports: [], generated_at: 123 } })
  })

  it('prefers explicit query profile over the profile header', async () => {
    mockGetSnapshot.mockResolvedValue({ members: [], tasks: [], stats: null, generated_at: 456 })

    const c = ctx({ query: { profile: 'query_profile' }, headers: { 'X-Hermes-Profile': 'header_profile' } })
    await ctrl.snapshot(c)

    expect(mockGetSnapshot).toHaveBeenCalledWith('query_profile')
  })

  it('returns 400 for invalid request data instead of masking it as 500', async () => {
    const invalidProfileCtx = ctx({ headers: { 'X-Hermes-Profile': '../bad' } })
    await ctrl.snapshot(invalidProfileCtx)
    expect(invalidProfileCtx.status).toBe(400)
    expect(invalidProfileCtx.body).toEqual({ error: 'invalid profile' })
    expect(mockGetSnapshot).not.toHaveBeenCalled()

    const missingTitleCtx = ctx({ request: { body: {} } })
    await ctrl.createTask(missingTitleCtx)
    expect(missingTitleCtx.status).toBe(400)
    expect(missingTitleCtx.body).toEqual({ error: 'title is required' })
    expect(mockCreateTask).not.toHaveBeenCalled()
  })

  it('keeps unexpected service failures as 500', async () => {
    mockGetSnapshot.mockRejectedValue(new Error('sqlite unavailable'))

    const c = ctx()
    await ctrl.snapshot(c)

    expect(c.status).toBe(500)
    expect(c.body).toEqual({ error: 'sqlite unavailable' })
  })

  it('sanitizes task action payloads and preserves evidence 404 semantics', async () => {
    mockCreateTask.mockResolvedValue({ id: 'task-1' })
    mockHandoffTask.mockResolvedValue(undefined)
    mockBlockTask.mockResolvedValue(undefined)
    mockCompleteTask.mockResolvedValue(undefined)
    mockGetEvidence.mockResolvedValue(null)

    const createCtx = ctx({ request: { body: { title: '  Build UI  ', body: '  evidence  ', assignee: '  Reviewer  ', priority: '7', tenant: 'ops-team' } } })
    await ctrl.createTask(createCtx)
    expect(mockCreateTask).toHaveBeenCalledWith({ title: 'Build UI', body: 'evidence', assignee: 'Reviewer', priority: 7, tenant: 'ops-team' })
    expect(createCtx.body).toEqual({ task: { id: 'task-1' } })

    const handoffCtx = ctx({ params: { id: 'task-1' }, request: { body: { assignee: '  Builder  ' } } })
    await ctrl.handoffTask(handoffCtx)
    expect(mockHandoffTask).toHaveBeenCalledWith('task-1', 'Builder')
    expect(handoffCtx.body).toEqual({ ok: true })

    const blockCtx = ctx({ params: { id: 'task-1' }, request: { body: { reason: '  blocked  ' } } })
    await ctrl.blockTask(blockCtx)
    expect(mockBlockTask).toHaveBeenCalledWith('task-1', 'blocked')

    const completeCtx = ctx({ params: { id: 'task-1' }, request: { body: { summary: '  done  ' } } })
    await ctrl.completeTask(completeCtx)
    expect(mockCompleteTask).toHaveBeenCalledWith('task-1', 'done')

    const evidenceCtx = ctx({ params: { id: 'missing' } })
    await ctrl.evidence(evidenceCtx)
    expect(evidenceCtx.status).toBe(404)
    expect(evidenceCtx.body).toEqual({ error: 'Task not found' })
  })

  it('rejects invalid priority and malformed task ids before calling services', async () => {
    const badPriorityCtx = ctx({ request: { body: { title: 'Build UI', priority: 101 } } })
    await ctrl.createTask(badPriorityCtx)
    expect(badPriorityCtx.status).toBe(400)
    expect(badPriorityCtx.body).toEqual({ error: 'invalid priority' })
    expect(mockCreateTask).not.toHaveBeenCalled()

    const missingIdCtx = ctx({ params: { id: '   ' }, request: { body: { assignee: 'Builder' } } })
    await ctrl.handoffTask(missingIdCtx)
    expect(missingIdCtx.status).toBe(400)
    expect(missingIdCtx.body).toEqual({ error: 'task id is required' })
    expect(mockHandoffTask).not.toHaveBeenCalled()

    const longIdCtx = ctx({ params: { id: 'x'.repeat(129) } })
    await ctrl.evidence(longIdCtx)
    expect(longIdCtx.status).toBe(400)
    expect(longIdCtx.body).toEqual({ error: 'task id is too long' })
    expect(mockGetEvidence).not.toHaveBeenCalled()
  })
})
