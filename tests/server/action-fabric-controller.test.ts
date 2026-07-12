import { beforeEach, describe, expect, it, vi } from 'vitest'

const fabric = vi.hoisted(() => ({
  listFabricCapabilities: vi.fn(), listFabricExecutors: vi.fn(), createFabricIntent: vi.fn(),
  listFabricWorkflows: vi.fn(), getFabricWorkflow: vi.fn(), approveFabricWorkflow: vi.fn(),
  rejectFabricWorkflow: vi.fn(), cancelFabricWorkflow: vi.fn(), retryFabricWorkflow: vi.fn(),
  requestFabricCompensation: vi.fn(), listFabricAuditEvents: vi.fn(), verifyFabricAuditChain: vi.fn(),
  getFabricControlState: vi.fn(), setFabricEmergencyStop: vi.fn(),
}))
const twin = vi.hoisted(() => ({ listAssistantRolesWithMappings: vi.fn() }))

vi.mock('../../packages/server/src/services/hermes/action-fabric', () => fabric)
vi.mock('../../packages/server/src/services/hermes/personal-twin', () => twin)

const role = {
  id: 'operator', enabled: true,
  capabilityScope: { allow: ['simulator.echo'], deny: [], enforcement: 'action_fabric_v1' },
}
const workflow = { id: 'wf-1', state: 'waiting_user', version: 1 }
const intentResult = { intent: { id: 'intent-1' }, policyDecision: { id: 'decision-1' }, workflow }

function context(options: {
  body?: unknown; query?: Record<string, unknown>; id?: string; user?: any; type?: string
} = {}): any {
  const request: Record<string, unknown> = {}
  if ('body' in options) request.body = options.body
  if (options.type !== undefined) request.type = options.type
  return {
    params: { id: options.id ?? 'wf-1' }, query: options.query ?? {}, request,
    state: { user: options.user ?? { id: 42, username: 'root', role: 'super_admin' } }, body: null,
  }
}

const validIntent = {
  capabilityId: 'simulator.echo', requestedByRoleId: 'operator', idempotencyKey: 'request-1',
  goal: 'Echo a bounded value', target: { subjectId: 'person:self' }, input: { text: 'hello' },
  constraints: { dryRun: false }, rationale: 'Integration test',
  expectedCost: { currency: 'CNY', amountMinor: 12 },
}

describe('action fabric controller', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(fabric).forEach(mock => mock.mockReset())
    twin.listAssistantRolesWithMappings.mockReset().mockReturnValue([role])
    fabric.listFabricCapabilities.mockReturnValue([])
    fabric.listFabricExecutors.mockReturnValue([])
    fabric.createFabricIntent.mockReturnValue(intentResult)
    fabric.listFabricWorkflows.mockReturnValue([workflow])
    fabric.getFabricWorkflow.mockReturnValue(workflow)
    fabric.approveFabricWorkflow.mockReturnValue({ ...workflow, state: 'preparing' })
    fabric.rejectFabricWorkflow.mockReturnValue({ ...workflow, state: 'cancelled' })
    fabric.cancelFabricWorkflow.mockReturnValue({ ...workflow, state: 'cancelled' })
    fabric.retryFabricWorkflow.mockReturnValue({ ...workflow, state: 'retrying' })
    fabric.requestFabricCompensation.mockReturnValue({ ...workflow, state: 'compensating' })
    fabric.listFabricAuditEvents.mockReturnValue([])
    fabric.verifyFabricAuditChain.mockReturnValue({ valid: true, checked: 3, firstInvalidSequence: null })
    fabric.getFabricControlState.mockReturnValue({ level: 0, version: 4, actorUserId: null, reason: '', updatedAt: '2026-07-12T00:00:00.000Z' })
    fabric.setFabricEmergencyStop.mockReturnValue({ level: 2, version: 5, actorUserId: '42', reason: 'maintenance', updatedAt: '2026-07-12T00:01:00.000Z' })
  })

  it('returns bounded allowlisted capability and executor discovery views', async () => {
    fabric.listFabricCapabilities.mockReturnValue([{
      id: 'simulator.echo', version: 1, domain: 'simulator', verb: 'echo', description: 'Echo',
      inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, risk: 'none', sideEffect: false,
      idempotency: 'supported', reversible: false, compensationCapabilityId: null,
      verificationStrategy: 'canonical', authentication: [], targetRestrictions: [],
      cost: { currency: null, estimatedMinor: 0 }, contractDigest: 'private-digest', enabled: true,
      createdAt: 'now', updatedAt: 'now', configuration: { token: 'secret' },
    }])
    fabric.listFabricExecutors.mockReturnValue([{
      id: 'simulator-main', type: 'simulator', name: 'Simulator', environment: 'simulator', health: 'healthy',
      healthDetails: { rawError: 'sqlite C:\\Users\\alice\\action-fabric.db' },
      configuration: { credential: 'sk-private-value' }, enabled: true, policyVersion: 2,
      createdAt: 'now', updatedAt: 'now',
    }])
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const capabilityCtx = context({ query: { limit: '20' } })
    await ctrl.capabilities(capabilityCtx)
    const executorCtx = context({ query: { limit: '20' } })
    await ctrl.executors(executorCtx)
    expect(capabilityCtx.body.capabilities[0]).not.toHaveProperty('contractDigest')
    expect(capabilityCtx.body.capabilities[0]).not.toHaveProperty('configuration')
    expect(executorCtx.body.executors[0]).not.toHaveProperty('configuration')
    expect(executorCtx.body.executors[0]).not.toHaveProperty('healthDetails')
    expect(JSON.stringify([capabilityCtx.body, executorCtx.body])).not.toMatch(/private|action-fabric\.db|alice/i)
  })

  it('sanitizes non-data discovery metadata without invoking accessors', async () => {
    let accessed = false
    const schema: Record<string, unknown> = { type: 'object' }
    Object.defineProperty(schema, 'credential', {
      enumerable: true,
      get: () => { accessed = true; return 'sk-private-value' },
    })
    fabric.listFabricCapabilities.mockReturnValue([{
      id: 'simulator.echo', version: 1, domain: 'simulator', verb: 'echo', description: 'Echo',
      inputSchema: schema, outputSchema: {}, risk: 'none', sideEffect: false,
      idempotency: 'supported', reversible: false, compensationCapabilityId: null,
      verificationStrategy: 'canonical', authentication: [], targetRestrictions: [],
      cost: { currency: null, estimatedMinor: 0 }, contractDigest: 'digest', enabled: true,
      createdAt: 'now', updatedAt: 'now',
    }])
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const ctx = context()
    await ctrl.capabilities(ctx)
    expect(accessed).toBe(false)
    expect(ctx.body.capabilities[0].inputSchema.credential).toBe('[REDACTED]')
  })

  it('creates an intent with the authenticated actor and preserves idempotent replay status', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const ctx = context({ body: validIntent })
    await ctrl.createIntent(ctx)
    expect(fabric.createFabricIntent).toHaveBeenCalledWith({ ...validIntent, requestedByUserId: '42' })
    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(intentResult)

    const existing = { ...intentResult, workflow: { ...workflow, state: 'succeeded' } }
    fabric.createFabricIntent.mockReturnValueOnce(existing)
    const replay = context({ body: validIntent })
    await ctrl.createIntent(replay)
    expect(replay.status).toBe(200)
    expect(replay.body).toEqual(existing)
  })

  it('rejects actor spoofing and missing, disabled, or legacy roles before intent creation', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const spoofed = context({ body: { ...validIntent, requestedByUserId: 'victim' } })
    await ctrl.createIntent(spoofed)
    expect(spoofed.status).toBe(400)

    for (const candidate of [[], [{ ...role, enabled: false }], [{ ...role, capabilityScope: { ...role.capabilityScope, enforcement: 'declarative_phase_2' } }]]) {
      twin.listAssistantRolesWithMappings.mockReturnValueOnce(candidate)
      const invalid = context({ body: validIntent })
      await ctrl.createIntent(invalid)
      expect(invalid.status).toBe(candidate.length ? 422 : 404)
    }
    expect(fabric.createFabricIntent).not.toHaveBeenCalled()
  })

  it('parses deterministic workflow pagination and returns list/detail', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const list = context({ query: { state: 'failed', capabilityId: 'simulator.echo', requestedByRoleId: 'operator', cursor: 'wf-0', limit: '25' } })
    await ctrl.workflows(list)
    expect(fabric.listFabricWorkflows).toHaveBeenCalledWith({ state: 'failed', capabilityId: 'simulator.echo', requestedByRoleId: 'operator', cursor: 'wf-0', limit: 25 })
    expect(list.body).toEqual({ workflows: [workflow], nextCursor: null })
    const detail = context({ id: 'wf-1' })
    await ctrl.workflowDetail(detail)
    expect(fabric.getFabricWorkflow).toHaveBeenCalledWith('wf-1')
    expect(detail.body).toEqual({ workflow })
  })

  it('delegates server-owned approve, reject, cancel, retry, and compensation actions', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    await ctrl.approveWorkflow(context({ body: {} }))
    await ctrl.rejectWorkflow(context({ body: { reason: 'not approved' } }))
    await ctrl.cancelWorkflow(context({ body: { reason: 'operator cancel' } }))
    await ctrl.retryWorkflow(context({ body: {} }))
    await ctrl.compensateWorkflow(context({ body: { reason: 'restore prior value' } }))
    expect(fabric.approveFabricWorkflow).toHaveBeenCalledWith('wf-1', '42')
    expect(fabric.rejectFabricWorkflow).toHaveBeenCalledWith('wf-1', '42', 'not approved')
    expect(fabric.cancelFabricWorkflow).toHaveBeenCalledWith('wf-1', '42', 'operator cancel')
    expect(fabric.retryFabricWorkflow).toHaveBeenCalledWith('wf-1', '42')
    expect(fabric.requestFabricCompensation).toHaveBeenCalledWith('wf-1', '42', 'restore prior value')
  })

  it('lists bounded audit data, verifies a safe summary, and controls emergency stop with optimistic concurrency', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const audit = context({ query: { aggregateType: 'workflow', aggregateId: 'wf-1', eventType: 'workflow.changed', afterSequence: '4', limit: '10' } })
    await ctrl.auditEvents(audit)
    expect(fabric.listFabricAuditEvents).toHaveBeenCalledWith({ aggregateType: 'workflow', aggregateId: 'wf-1', eventType: 'workflow.changed', afterSequence: 4, limit: 10 })
    const verify = context()
    await ctrl.verifyAudit(verify)
    expect(verify.body).toEqual({ verification: { valid: true, checked: 3, firstInvalidSequence: null } })
    const read = context()
    await ctrl.control(read)
    expect(read.body.control.level).toBe(0)
    const update = context({ body: { level: 2, reason: 'maintenance', expectedVersion: 4 } })
    await ctrl.updateEmergencyStop(update)
    expect(fabric.setFabricEmergencyStop).toHaveBeenCalledWith(2, '42', 'maintenance', 4)
    expect(update.body.control.version).toBe(5)
  })

  it.each([
    [undefined], [null], [[]], [{ ...validIntent, desiredState: 'succeeded' }],
    [{ ...validIntent, expectedCost: { currency: 'usd', amountMinor: 1 } }],
    [{ ...validIntent, expectedCost: { currency: 'USD', amountMinor: 1.5 } }],
  ])('returns 400 for malformed intent body %#', async (body) => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const ctx = context({ body })
    await ctrl.createIntent(ctx)
    expect(ctx.status).toBe(400)
  })

  it('rejects non-JSON content types, overlong strings, deep/large JSON, unsafe prototypes, accessors, and symbols', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    const accessor: any = { ...validIntent }
    Object.defineProperty(accessor, 'goal', { enumerable: true, get: () => 'unsafe' })
    const symbol: any = { ...validIntent, [Symbol('secret')]: true }
    const inherited = Object.assign(Object.create({ inherited: true }), validIntent)
    let deep: any = { value: true }; for (let i = 0; i < 10; i += 1) deep = { nested: deep }
    const candidates = [
      context({ body: validIntent, type: 'text/plain' }),
      context({ body: { ...validIntent, goal: 'x'.repeat(5000) } }),
      context({ body: { ...validIntent, input: deep } }), accessor, symbol, inherited,
    ]
    for (const candidate of candidates) {
      const ctx = candidate.request ? candidate : context({ body: candidate })
      await ctrl.createIntent(ctx)
      expect(ctx.status).toBe(400)
    }
  })

  it('rejects malformed queries, encoded/overlong path IDs, and mutation body extras', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    for (const query of [{ limit: '0' }, { limit: '201' }, { limit: '1.5' }, { state: 'owned' }, { cursor: ['bad'] }]) {
      const ctx = context({ query })
      await ctrl.workflows(ctx)
      expect(ctx.status).toBe(400)
    }
    const badId = context({ id: '%E0%A4%A', body: {} })
    await ctrl.approveWorkflow(badId)
    expect(badId.status).toBe(400)
    const extra = context({ body: { reason: 'x', state: 'succeeded' } })
    await ctrl.cancelWorkflow(extra)
    expect(extra.status).toBe(400)
  })

  it.each([
    ['FABRIC_WORKFLOW_NOT_FOUND', 404, 'Action workflow not found'],
    ['FABRIC_CONTROL_VERSION_CONFLICT', 409, 'Action Fabric state changed'],
    ['FABRIC_WORKFLOW_NOT_RETRYABLE', 422, 'Action workflow cannot be retried'],
    ['FABRIC_EMERGENCY_STOP', 503, 'Action Fabric is unavailable'],
    ['FABRIC_WORKFLOW_INVALID_ID', 400, 'Invalid request'],
  ])('maps %s to stable sanitized HTTP errors', async (code, status, message) => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    fabric.getFabricWorkflow.mockImplementationOnce(() => { throw new Error(`${code}: fabric_action_intents at C:\\Users\\alice\\action-fabric.db password=secret`) })
    const ctx = context()
    await ctrl.workflowDetail(ctx)
    expect(ctx.status).toBe(status)
    expect(ctx.body).toEqual({ error: message, code })
    expect(JSON.stringify(ctx.body)).not.toMatch(/fabric_action_intents|alice|password|action-fabric\.db/i)
  })

  it('maps unknown failures to a sanitized 500', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/action-fabric')
    fabric.listFabricExecutors.mockImplementationOnce(() => { throw new Error('SQLITE failure with credential at /home/alice/action-fabric.db') })
    const ctx = context()
    await ctrl.executors(ctx)
    expect(ctx.status).toBe(500)
    expect(ctx.body).toEqual({ error: 'Internal server error', code: 'FABRIC_INTERNAL_ERROR' })
  })
})
