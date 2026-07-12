// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const api = vi.hoisted(() => ({
  fetchActionCapabilities: vi.fn(), fetchActionExecutors: vi.fn(), createActionIntent: vi.fn(),
  fetchActionWorkflows: vi.fn(), fetchActionWorkflow: vi.fn(), approveActionWorkflow: vi.fn(),
  rejectActionWorkflow: vi.fn(), cancelActionWorkflow: vi.fn(), retryActionWorkflow: vi.fn(),
  compensateActionWorkflow: vi.fn(), fetchActionAudit: vi.fn(), verifyActionAudit: vi.fn(),
  fetchActionControl: vi.fn(), updateActionEmergencyStop: vi.fn(),
}))
vi.mock('@/api/hermes/action-fabric', () => api)

import { useActionFabricStore } from '@/stores/hermes/action-fabric'

const capability = { id: 'simulator.echo', risk: 'none' }
const executor = { id: 'simulator-main', health: 'healthy' }
const summary = { id: 'wf-1', state: 'waiting_user', capabilityId: 'simulator.echo' }
const detail = { ...summary, intent: { id: 'intent-1' }, steps: [], policyDecision: null }
const audit = { id: 'audit-1', sequence: 1, aggregateId: 'wf-1' }
const control = { level: 0, version: 4, actorUserId: null, reason: '', updatedAt: 'now' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('Action Fabric store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.fetchActionCapabilities.mockResolvedValue([capability])
    api.fetchActionExecutors.mockResolvedValue([executor])
    api.fetchActionWorkflows.mockResolvedValue({ workflows: [summary], nextCursor: null })
    api.fetchActionWorkflow.mockResolvedValue(detail)
    api.fetchActionAudit.mockResolvedValue({ events: [audit], nextAfterSequence: null })
    api.verifyActionAudit.mockResolvedValue({ valid: true, checked: 1, firstInvalidSequence: null })
    api.fetchActionControl.mockResolvedValue(control)
    for (const name of ['approveActionWorkflow', 'rejectActionWorkflow', 'cancelActionWorkflow',
      'retryActionWorkflow', 'compensateActionWorkflow'] as const) api[name].mockResolvedValue(detail)
    api.createActionIntent.mockResolvedValue({ intent: detail.intent, policyDecision: null, workflow: detail })
    api.updateActionEmergencyStop.mockResolvedValue({ ...control, level: 2, version: 5 })
  })

  it('exposes the exact initial Action Fabric state and loading flags', () => {
    const store = useActionFabricStore()
    expect({ capabilities: store.capabilities, executors: store.executors, workflows: store.workflows,
      selectedWorkflowId: store.selectedWorkflowId, selectedWorkflow: store.selectedWorkflow,
      audit: store.audit, control: store.control, loading: store.loading, saving: store.saving, error: store.error }).toEqual({
      capabilities: [], executors: [], workflows: [], selectedWorkflowId: null, selectedWorkflow: null,
      audit: [], control: null, loading: false, saving: false, error: null,
    })
  })

  it('loads authoritative discovery, list, selected detail, audit, and control state', async () => {
    const store = useActionFabricStore()
    await Promise.all([store.loadCapabilities(), store.loadExecutors(), store.loadWorkflows(),
      store.loadAudit(), store.loadControl()])
    await store.selectWorkflow('wf-1')
    expect(store.capabilities).toEqual([capability])
    expect(store.executors).toEqual([executor])
    expect(store.workflows).toEqual([summary])
    expect(store.selectedWorkflowId).toBe('wf-1')
    expect(store.selectedWorkflow).toEqual(detail)
    expect(store.audit).toEqual([audit])
    expect(store.control).toEqual(control)
    expect(store.loading).toBe(false)
    expect(store.error).toBeNull()
  })

  it('keeps only newest list, detail, audit, and control responses when requests finish out of order', async () => {
    const firstList = deferred<{ workflows: any[]; nextCursor: null }>()
    const firstDetail = deferred<any>()
    const firstAudit = deferred<{ events: any[]; nextAfterSequence: null }>()
    const firstControl = deferred<any>()
    api.fetchActionWorkflows.mockImplementationOnce(() => firstList.promise)
      .mockResolvedValueOnce({ workflows: [summary, { ...summary, id: 'wf-new' }], nextCursor: null })
    api.fetchActionWorkflow.mockImplementationOnce(() => firstDetail.promise)
      .mockResolvedValueOnce({ ...detail, state: 'succeeded' })
    api.fetchActionAudit.mockImplementationOnce(() => firstAudit.promise)
      .mockResolvedValueOnce({ events: [{ ...audit, id: 'audit-new' }], nextAfterSequence: null })
    api.fetchActionControl.mockImplementationOnce(() => firstControl.promise)
      .mockResolvedValueOnce({ ...control, version: 6 })
    const store = useActionFabricStore()
    store.selectedWorkflowId = 'wf-1'
    const stale = [store.loadWorkflows(), store.loadWorkflow('wf-1'), store.loadAudit(), store.loadControl()]
    await Promise.all([store.loadWorkflows(), store.loadWorkflow('wf-1'), store.loadAudit(), store.loadControl()])
    firstList.resolve({ workflows: [summary], nextCursor: null })
    firstDetail.resolve({ ...detail, state: 'failed' })
    firstAudit.resolve({ events: [audit], nextAfterSequence: null })
    firstControl.resolve(control)
    await Promise.all(stale)
    expect(store.workflows).toEqual([summary, { ...summary, id: 'wf-new' }])
    expect(store.selectedWorkflow?.state).toBe('succeeded')
    expect(store.audit[0].id).toBe('audit-new')
    expect(store.control?.version).toBe(6)
  })

  it('invalidates missing list selections and clears a selected detail on 404', async () => {
    const store = useActionFabricStore()
    store.selectedWorkflowId = 'wf-1'
    store.selectedWorkflow = detail as never
    api.fetchActionWorkflows.mockResolvedValueOnce({ workflows: [], nextCursor: null })
    await store.loadWorkflows()
    expect(store.selectedWorkflowId).toBeNull()
    expect(store.selectedWorkflow).toBeNull()

    store.selectedWorkflowId = 'wf-1'
    store.selectedWorkflow = detail as never
    api.fetchActionWorkflow.mockRejectedValueOnce(new Error('API Error 404: Action workflow not found'))
    await expect(store.loadWorkflow('wf-1')).rejects.toThrow(/404/)
    expect(store.selectedWorkflowId).toBeNull()
    expect(store.selectedWorkflow).toBeNull()
  })

  it('authoritatively refreshes detail, list, and relevant audit after every workflow mutation', async () => {
    const store = useActionFabricStore()
    store.selectedWorkflowId = 'wf-1'
    await store.approveWorkflow('wf-1')
    await store.rejectWorkflow('wf-1', 'reject')
    await store.cancelWorkflow('wf-1', 'cancel')
    await store.retryWorkflow('wf-1')
    await store.compensateWorkflow('wf-1', 'restore')
    expect(api.fetchActionWorkflow).toHaveBeenCalledTimes(5)
    expect(api.fetchActionWorkflows).toHaveBeenCalledTimes(5)
    expect(api.fetchActionAudit).toHaveBeenCalledTimes(5)
    expect(api.fetchActionAudit).toHaveBeenLastCalledWith({ aggregateType: 'workflow', aggregateId: 'wf-1', limit: 100 })
    expect(store.saving).toBe(false)
  })

  it('refreshes authoritative state after intent and emergency-control mutations', async () => {
    const store = useActionFabricStore()
    await store.createIntent({ capabilityId: 'simulator.echo' } as never)
    expect(store.selectedWorkflowId).toBe('wf-1')
    expect(api.fetchActionWorkflow).toHaveBeenCalledWith('wf-1')
    expect(api.fetchActionWorkflows).toHaveBeenCalledTimes(1)
    expect(api.fetchActionAudit).toHaveBeenCalledWith({ aggregateType: 'workflow', aggregateId: 'wf-1', limit: 100 })

    await store.updateEmergencyStop({ level: 2, reason: 'maintenance', expectedVersion: 4 })
    expect(api.fetchActionControl).toHaveBeenCalledTimes(1)
    expect(api.fetchActionWorkflows).toHaveBeenCalledTimes(2)
    expect(api.fetchActionAudit).toHaveBeenLastCalledWith({ aggregateType: 'control', limit: 100 })
  })

  it('retains retryable state on errors, exposes the error, and clears flags after retry', async () => {
    const store = useActionFabricStore()
    await store.loadWorkflows()
    api.fetchActionWorkflows.mockRejectedValueOnce(new Error('network offline'))
    await expect(store.loadWorkflows()).rejects.toThrow('network offline')
    expect(store.workflows).toEqual([summary])
    expect(store.error).toBe('network offline')
    expect(store.loading).toBe(false)
    api.fetchActionWorkflows.mockResolvedValueOnce({ workflows: [{ ...summary, state: 'succeeded' }], nextCursor: null })
    await store.loadWorkflows()
    expect(store.workflows[0].state).toBe('succeeded')
    expect(store.error).toBeNull()
  })

  it('keeps saving true and authoritatively refreshes every concurrent mutation', async () => {
    const older = deferred<any>()
    api.approveActionWorkflow.mockImplementationOnce(() => older.promise)
    const store = useActionFabricStore()
    store.selectedWorkflowId = 'wf-1'
    const first = store.approveWorkflow('wf-1')
    const second = store.rejectWorkflow('wf-1', 'newer decision')
    await second
    expect(store.saving).toBe(true)
    expect(api.fetchActionWorkflow).toHaveBeenCalledTimes(1)
    older.resolve(detail)
    await first
    expect(store.saving).toBe(false)
    expect(api.fetchActionWorkflow).toHaveBeenCalledTimes(2)
    expect(api.fetchActionWorkflows).toHaveBeenCalledTimes(2)
    expect(api.fetchActionAudit).toHaveBeenCalledTimes(2)
    expect(store.error).toBeNull()
  })

  it('reset and dispose invalidate in-flight responses without leaving loading state behind', async () => {
    const pendingList = deferred<{ workflows: any[]; nextCursor: null }>()
    api.fetchActionWorkflows.mockImplementationOnce(() => pendingList.promise)
    const store = useActionFabricStore()
    const load = store.loadWorkflows()
    store.$reset()
    pendingList.resolve({ workflows: [summary], nextCursor: null })
    await load
    expect(store.workflows).toEqual([])
    expect(store.loading).toBe(false)

    const pendingControl = deferred<any>()
    api.fetchActionControl.mockImplementationOnce(() => pendingControl.promise)
    const controlLoad = store.loadControl()
    store.$dispose()
    pendingControl.resolve(control)
    await controlLoad
    expect(store.control).toBeNull()
  })
})
