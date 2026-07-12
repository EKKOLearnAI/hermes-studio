import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ request }))

import * as api from '@/api/hermes/action-fabric'

describe('Action Fabric client API', () => {
  beforeEach(() => request.mockReset())

  it('queries and unwraps capability and executor discovery with URLSearchParams', async () => {
    request.mockResolvedValueOnce({ capabilities: [{ id: 'simulator.echo' }] })
      .mockResolvedValueOnce({ executors: [{ id: 'internal-twin' }] })
    await expect(api.fetchActionCapabilities({ domain: 'life & work', risk: 'low', enabled: true, limit: 200 }))
      .resolves.toEqual([{ id: 'simulator.echo' }])
    await expect(api.fetchActionExecutors({ type: 'internal', environment: 'internal', health: 'healthy', enabled: false, limit: 20 }))
      .resolves.toEqual([{ id: 'internal-twin' }])
    expect(request).toHaveBeenNthCalledWith(1,
      '/api/hermes/action-fabric/capabilities?domain=life+%26+work&risk=low&enabled=true&limit=200')
    expect(request).toHaveBeenNthCalledWith(2,
      '/api/hermes/action-fabric/executors?type=internal&environment=internal&health=healthy&enabled=false&limit=20')
  })

  it('creates intents and unwraps the complete server result', async () => {
    const input = { capabilityId: 'simulator.echo', requestedByRoleId: 'operator', idempotencyKey: 'request-1',
      goal: 'Echo', target: {}, input: { message: 'hello' }, constraints: {}, rationale: 'test' }
    const result = { intent: { id: 'intent-1' }, policyDecision: { id: 'decision-1' }, workflow: { id: 'wf-1' } }
    request.mockResolvedValue(result)
    await expect(api.createActionIntent(input as never)).resolves.toEqual(result)
    expect(request).toHaveBeenCalledWith('/api/hermes/action-fabric/intents', {
      method: 'POST', body: JSON.stringify(input),
    })
  })

  it('lists workflows with encoded queries and fetches encoded details', async () => {
    request.mockResolvedValueOnce({ workflows: [{ id: 'wf-1' }], nextCursor: 'wf-1' })
      .mockResolvedValueOnce({ workflow: { id: 'wf / 1' } })
    await expect(api.fetchActionWorkflows({ state: 'waiting_user', capabilityId: 'cap / one',
      requestedByRoleId: 'role one', requestedByUserId: 'user/one', cursor: 'wf 0', limit: 100 }))
      .resolves.toEqual({ workflows: [{ id: 'wf-1' }], nextCursor: 'wf-1' })
    await expect(api.fetchActionWorkflow('wf / 1')).resolves.toEqual({ id: 'wf / 1' })
    expect(request).toHaveBeenNthCalledWith(1,
      '/api/hermes/action-fabric/workflows?state=waiting_user&capabilityId=cap+%2F+one&requestedByRoleId=role+one&requestedByUserId=user%2Fone&cursor=wf+0&limit=100')
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/action-fabric/workflows/wf%20%2F%201')
  })

  it('calls every workflow mutation with explicit methods and bodies', async () => {
    request.mockResolvedValue({ workflow: { id: 'wf / 1' } })
    await expect(api.approveActionWorkflow('wf / 1')).resolves.toEqual({ id: 'wf / 1' })
    await expect(api.rejectActionWorkflow('wf / 1', 'not approved')).resolves.toEqual({ id: 'wf / 1' })
    await expect(api.cancelActionWorkflow('wf / 1', 'cancel now')).resolves.toEqual({ id: 'wf / 1' })
    await expect(api.retryActionWorkflow('wf / 1')).resolves.toEqual({ id: 'wf / 1' })
    await expect(api.compensateActionWorkflow('wf / 1', 'restore prior')).resolves.toEqual({ id: 'wf / 1' })
    const base = '/api/hermes/action-fabric/workflows/wf%20%2F%201'
    expect(request).toHaveBeenNthCalledWith(1, `${base}/approve`, { method: 'POST', body: '{}' })
    expect(request).toHaveBeenNthCalledWith(2, `${base}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'not approved' }) })
    expect(request).toHaveBeenNthCalledWith(3, `${base}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'cancel now' }) })
    expect(request).toHaveBeenNthCalledWith(4, `${base}/retry`, { method: 'POST', body: '{}' })
    expect(request).toHaveBeenNthCalledWith(5, `${base}/compensate`, { method: 'POST', body: JSON.stringify({ reason: 'restore prior' }) })
  })

  it('lists and verifies audit endpoints with stable pagination', async () => {
    request.mockResolvedValueOnce({ events: [{ sequence: 9 }], nextAfterSequence: 9 })
      .mockResolvedValueOnce({ verification: { valid: true, checked: 9, firstInvalidSequence: null } })
    await expect(api.fetchActionAudit({ aggregateType: 'workflow', aggregateId: 'wf / 1',
      eventType: 'workflow.changed', afterSequence: 4, limit: 50 }))
      .resolves.toEqual({ events: [{ sequence: 9 }], nextAfterSequence: 9 })
    await expect(api.verifyActionAudit()).resolves.toEqual({ valid: true, checked: 9, firstInvalidSequence: null })
    expect(request).toHaveBeenNthCalledWith(1,
      '/api/hermes/action-fabric/audit?aggregateType=workflow&aggregateId=wf+%2F+1&eventType=workflow.changed&afterSequence=4&limit=50')
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/action-fabric/audit/verify')
  })

  it('reads and updates control state with optimistic concurrency', async () => {
    request.mockResolvedValueOnce({ control: { level: 0, version: 4 } })
      .mockResolvedValueOnce({ control: { level: 2, version: 5 } })
    await expect(api.fetchActionControl()).resolves.toEqual({ level: 0, version: 4 })
    await expect(api.updateActionEmergencyStop({ level: 2, reason: 'maintenance', expectedVersion: 4 }))
      .resolves.toEqual({ level: 2, version: 5 })
    expect(request).toHaveBeenNthCalledWith(1, '/api/hermes/action-fabric/control')
    expect(request).toHaveBeenNthCalledWith(2, '/api/hermes/action-fabric/control/emergency-stop', {
      method: 'PUT', body: JSON.stringify({ level: 2, reason: 'maintenance', expectedVersion: 4 }),
    })
  })

  it('does not expose a generic executor invocation surface', () => {
    expect(Object.keys(api).filter(name => /invoke|executeRaw|generic|provider/i.test(name))).toEqual([])
  })
})
