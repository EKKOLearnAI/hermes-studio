// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, reactive, ref } from 'vue'

const capability = { id: 'internal.twin.preference.set', version: 1, domain: 'twin', verb: 'set', description: 'Set preference', inputSchema: {}, outputSchema: {}, risk: 'low', sideEffect: true, idempotency: 'required', reversible: true, compensationCapabilityId: 'internal.twin.preference.restore', verificationStrategy: 'canonical read', authentication: [], targetRestrictions: ['preference'], cost: { currency: null, estimatedMinor: 0 }, enabled: true, createdAt: '', updatedAt: '' }
const executor = { id: 'internal-twin', type: 'internal', name: 'Internal Twin', environment: 'internal', health: 'degraded', enabled: true, policyVersion: 1, createdAt: '', updatedAt: '' }
const base = { intentId: 'intent-1', executorId: 'internal-twin', policyDecisionId: 'policy-1', compensationIntentId: null, version: 1, attempt: 1, maxAttempts: 3, leaseExpiresAt: null, retryAt: null, lastErrorCode: null, capabilityId: capability.id, goal: 'Set preference', requestedByRoleId: 'role-1', requestedByUserId: 'user-1', createdAt: '', updatedAt: '', completedAt: null }
const workflows = [
  { ...base, id: 'running', state: 'executing' }, { ...base, id: 'waiting', state: 'waiting_user' },
  { ...base, id: 'failed', state: 'failed', lastErrorCode: 'temporary_failure' },
  { ...base, id: 'reversible', state: 'succeeded', completedAt: 'now' },
  { ...base, id: 'completed', state: 'cancelled', completedAt: 'now' },
] as any[]
const detail = { ...workflows[1], intent: { id: 'intent-1', requestedByRoleId: 'role-1', sanitizedSummary: {} }, steps: [], policyDecision: { reasonCodes: ['risk_requires_approval'] } }
const actionStore = reactive({
  capabilities: [capability] as any[], executors: [executor] as any[], workflows, selectedWorkflowId: null as string | null,
  selectedWorkflow: null as any, audit: [] as any[], control: { level: 0, version: 1, actorUserId: null, reason: '', updatedAt: '' } as any,
  loading: false, saving: false, error: null as string | null,
  loadCapabilities: vi.fn(), loadExecutors: vi.fn(), loadWorkflows: vi.fn(), loadAudit: vi.fn(), loadControl: vi.fn(),
  selectWorkflow: vi.fn(), approveWorkflow: vi.fn(), rejectWorkflow: vi.fn(), retryWorkflow: vi.fn(), cancelWorkflow: vi.fn(), compensateWorkflow: vi.fn(), updateEmergencyStop: vi.fn(),
})
const rolesStore = reactive({ roles: [{ id: 'role-1', name: 'Operator', enabled: true, capabilityScope: { allow: [capability.id], deny: [], enforcement: 'action_fabric_v1' } }] as any[], fetchRoles: vi.fn() })

vi.mock('@/stores/hermes/action-fabric', () => ({ useActionFabricStore: () => actionStore }))
vi.mock('@/stores/hermes/assistant-roles', () => ({ useAssistantRolesStore: () => rolesStore }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  NAlert: defineComponent({ template: '<div><slot /></div>' }),
  NButton: defineComponent({ props: ['disabled'], emits: ['click'], template: '<button :disabled="disabled" @click="$emit(\'click\', $event)"><slot /></button>' }),
  NEmpty: defineComponent({ props: ['description'], template: '<div>{{ description }}<slot /></div>' }),
  NSpin: defineComponent({ template: '<div><slot /></div>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useDialog: () => ({ warning: vi.fn() }),
}))
vi.mock('@/components/hermes/action-fabric/WorkflowDetailDrawer.vue', () => ({ default: defineComponent({ props: ['show', 'workflow', 'audit'], emits: ['close', 'approve', 'retry'], template: '<aside data-test="drawer-stub" :data-show="show"><span>{{ workflow?.id }}</span><span data-test="drawer-audit">{{ audit.map((item) => item.id).join(\',\') }}</span><button v-if="show" data-test="drawer-close" @click="$emit(\'close\')">close</button><button v-if="show" data-test="drawer-approve" @click="$emit(\'approve\')">approve</button><button v-if="show" data-test="drawer-retry" @click="$emit(\'retry\')">retry</button></aside>' }) }))
vi.mock('@/components/hermes/action-fabric/EmergencyStopPanel.vue', () => ({ default: defineComponent({ emits: ['update'], template: '<button data-test="control-update" @click="$emit(\'update\', { level: 2, reason: \'incident\', expectedVersion: 1 })">control</button>' }) }))

import ActionFabricPanel from '@/components/hermes/action-fabric/ActionFabricPanel.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('ActionFabricPanel', () => {
  beforeEach(() => {
    vi.resetAllMocks(); actionStore.workflows = workflows; actionStore.capabilities = [capability] as any; actionStore.executors = [executor] as any
    actionStore.selectedWorkflowId = null; actionStore.selectedWorkflow = null; actionStore.audit = []; actionStore.error = null; actionStore.loading = false
    actionStore.loadCapabilities.mockResolvedValue(actionStore.capabilities); actionStore.loadExecutors.mockResolvedValue(actionStore.executors)
    actionStore.loadWorkflows.mockResolvedValue(actionStore.workflows); actionStore.loadAudit.mockResolvedValue([]); actionStore.loadControl.mockResolvedValue(actionStore.control)
    actionStore.selectWorkflow.mockImplementation(async (id: string) => { actionStore.selectedWorkflowId = id; actionStore.selectedWorkflow = { ...detail, id }; return actionStore.selectedWorkflow })
    actionStore.approveWorkflow.mockResolvedValue(detail); actionStore.retryWorkflow.mockResolvedValue(detail); actionStore.updateEmergencyStop.mockResolvedValue(actionStore.control)
    rolesStore.fetchRoles.mockResolvedValue(rolesStore.roles)
  })

  it('groups authoritative workflows and shows local capability, executor, and role declarations', async () => {
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    for (const group of ['running', 'waiting', 'failed', 'reversible', 'completed']) expect(wrapper.find(`[data-test="group-${group}"]`).exists()).toBe(true)
    expect(wrapper.find('[data-test="group-running"]').text()).toContain('running')
    expect(wrapper.find('[data-test="group-reversible"]').text()).toContain('reversible')
    expect(wrapper.text()).toContain('Only simulator and reversible internal executors are available')
    expect(wrapper.text()).not.toMatch(/MCP|browser/i)
    expect(wrapper.text()).toContain('required')
    expect(wrapper.text()).toContain('internal')
    expect(wrapper.text()).toContain('degraded')
    expect(wrapper.text()).toContain('Operator')
    expect(wrapper.text()).toContain('Allowed declaration')
    expect(actionStore.loadWorkflows).toHaveBeenCalled()
    expect(rolesStore.fetchRoles).toHaveBeenCalled()
  })

  it('shows loading, empty, degraded retry, and stale-selection states from the store', async () => {
    actionStore.workflows = []; actionStore.capabilities = []; actionStore.executors = []; actionStore.loading = true
    const wrapper = mount(ActionFabricPanel)
    expect(wrapper.find('[data-test="action-loading"]').exists()).toBe(true)
    actionStore.loading = false; actionStore.error = 'ACTION_FABRIC_REFRESH_FAILED'; actionStore.selectedWorkflowId = 'missing'; actionStore.selectedWorkflow = null
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="action-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="action-stale-selection"]').exists()).toBe(true)
    expect(wrapper.get('[role="status"]').text()).toContain('Some authoritative data could not be refreshed')
    await wrapper.get('[data-test="action-retry"]').trigger('click')
    await flushPromises()
    expect(actionStore.loadWorkflows).toHaveBeenCalledTimes(2)
  })

  it('announces degraded data when any initial authoritative read fails', async () => {
    actionStore.loadCapabilities.mockRejectedValueOnce(new Error('capabilities unavailable'))
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Action Fabric data is degraded')
  })

  it('opens the authoritative detail and restores focus when the drawer closes', async () => {
    const wrapper = mount(ActionFabricPanel, { attachTo: document.body })
    await flushPromises()
    const trigger = wrapper.get('[data-test="workflow-waiting"]')
    await trigger.trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-stub"]').text()).toContain('waiting')
    expect(actionStore.loadAudit).toHaveBeenCalledWith({ aggregateType: 'workflow', aggregateId: 'waiting', limit: 100 })
    await wrapper.get('[data-test="drawer-close"]').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('does not start stale audit loading when an older workflow selection finishes last', async () => {
    const oldSelection = deferred<any>()
    actionStore.selectWorkflow.mockImplementationOnce(() => oldSelection.promise)
      .mockImplementationOnce(async (id: string) => { actionStore.selectedWorkflowId = id; actionStore.selectedWorkflow = { ...detail, id }; return actionStore.selectedWorkflow })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()

    const oldOpen = wrapper.get('[data-test="workflow-running"]').trigger('click')
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    oldSelection.resolve({ ...detail, id: 'running' })
    await oldOpen
    await flushPromises()

    expect(actionStore.loadAudit).toHaveBeenCalledTimes(1)
    expect(actionStore.loadAudit).toHaveBeenCalledWith({ aggregateType: 'workflow', aggregateId: 'waiting', limit: 100 })
  })

  it('never shows workflow A audit while workflow B detail is pending when A audit returns first', async () => {
    const auditA = deferred<any[]>()
    const detailB = deferred<any>()
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = await auditA.promise; actionStore.audit = events; return events })
      .mockImplementationOnce(async () => { const events = [{ id: 'audit-b', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
    actionStore.selectWorkflow.mockImplementationOnce(async (id: string) => { actionStore.selectedWorkflowId = id; actionStore.selectedWorkflow = { ...detail, id }; return actionStore.selectedWorkflow })
      .mockImplementationOnce(async (id: string) => { actionStore.selectedWorkflowId = id; actionStore.selectedWorkflow = null; const next = await detailB.promise; actionStore.selectedWorkflow = next; return next })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()

    await wrapper.get('[data-test="workflow-running"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    auditA.resolve([{ id: 'audit-a', aggregateType: 'workflow', aggregateId: 'running' }])
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('')

    detailB.resolve({ ...detail, id: 'waiting' })
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b')
  })

  it('keeps workflow B audit when workflow A audit returns after B', async () => {
    const auditA = deferred<any[]>()
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = await auditA.promise; actionStore.audit = events; return events })
      .mockImplementationOnce(async () => { const events = [{ id: 'audit-b', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()

    await wrapper.get('[data-test="workflow-running"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b')
    auditA.resolve([{ id: 'audit-a', aggregateType: 'workflow', aggregateId: 'running' }])
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b')
  })

  it('keeps the selected workflow audit snapshot when control audit replaces the global store audit', async () => {
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b')

    actionStore.audit = [{ id: 'audit-control', aggregateType: 'control', aggregateId: 'global' }]
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b')
  })

  it('keeps the snapshot empty when a later control request evicts the selected workflow audit load', async () => {
    const auditB = deferred<any[]>()
    actionStore.loadAudit.mockImplementationOnce(() => auditB.promise)
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()

    actionStore.audit = [{ id: 'audit-control', aggregateType: 'control', aggregateId: 'global' }]
    auditB.resolve([{ id: 'audit-b', aggregateType: 'workflow', aggregateId: 'waiting' }])
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('')
  })

  it('clears the selected workflow audit snapshot immediately when the drawer closes', async () => {
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b')
    await wrapper.get('[data-test="drawer-close"]').trigger('click')
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('')
  })

  it.each([
    { workflowId: 'waiting', button: 'approve', operation: 'approveWorkflow' },
    { workflowId: 'failed', button: 'retry', operation: 'retryWorkflow' },
  ])('refreshes the selected workflow audit after a successful $button mutation', async ({ workflowId, button, operation }) => {
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: `audit-${workflowId}-old`, aggregateType: 'workflow', aggregateId: workflowId }]; actionStore.audit = events; return events })
      .mockImplementationOnce(async () => { const events = [{ id: `audit-${workflowId}-new`, aggregateType: 'workflow', aggregateId: workflowId }]; actionStore.audit = events; return events })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get(`[data-test="workflow-${workflowId}"]`).trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe(`audit-${workflowId}-old`)

    await wrapper.get(`[data-test="drawer-${button}"]`).trigger('click')
    await flushPromises()
    expect((actionStore as any)[operation]).toHaveBeenCalledWith(workflowId)
    expect(actionStore.loadAudit).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe(`audit-${workflowId}-new`)
  })

  it('does not write mutation audit for B after selection changes to C while the mutation is pending', async () => {
    const mutation = deferred<any>()
    actionStore.approveWorkflow.mockImplementationOnce(() => mutation.promise)
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b-old', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
      .mockImplementationOnce(async () => { const events = [{ id: 'audit-c', aggregateType: 'workflow', aggregateId: 'completed' }]; actionStore.audit = events; return events })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="drawer-approve"]').trigger('click')
    await wrapper.get('[data-test="workflow-completed"]').trigger('click')
    await flushPromises()
    mutation.resolve(detail)
    await flushPromises()

    expect(actionStore.loadAudit).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-c')
  })

  it('clears old workflow audit and announces degraded when mutation audit refresh is evicted by control', async () => {
    const refreshedAudit = deferred<any[]>()
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b-old', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
      .mockImplementationOnce(() => refreshedAudit.promise)
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="drawer-approve"]').trigger('click')
    await flushPromises()
    actionStore.audit = [{ id: 'audit-control', aggregateType: 'control', aggregateId: 'global' }]
    refreshedAudit.resolve([{ id: 'audit-b-new', aggregateType: 'workflow', aggregateId: 'waiting' }])
    await flushPromises()

    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('')
    expect(wrapper.get('[role="status"]').text()).toContain('Action Fabric data is degraded')
  })

  it('invalidates a pending mutation audit refresh as soon as a concurrent control mutation starts', async () => {
    const refreshedAudit = deferred<any[]>()
    const controlMutation = deferred<any>()
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b-old', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
      .mockImplementationOnce(() => refreshedAudit.promise)
    actionStore.updateEmergencyStop.mockImplementationOnce(() => controlMutation.promise)
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="drawer-approve"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="control-update"]').trigger('click')
    refreshedAudit.resolve([{ id: 'audit-b-new', aggregateType: 'workflow', aggregateId: 'waiting' }])
    await flushPromises()

    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('')
    expect(wrapper.get('[role="status"]').text()).toContain('Action Fabric data is degraded')
    controlMutation.resolve(actionStore.control)
    await flushPromises()
  })

  it('clears old workflow audit and announces degraded when post-mutation audit loading fails', async () => {
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b-old', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
      .mockRejectedValueOnce(new Error('audit unavailable'))
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="drawer-approve"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('')
    expect(wrapper.get('[role="status"]').text()).toContain('Action Fabric data is degraded')
  })

  it('keeps the old workflow audit and exposes the store error when the mutation itself fails', async () => {
    actionStore.loadAudit.mockImplementationOnce(async () => { const events = [{ id: 'audit-b-old', aggregateType: 'workflow', aggregateId: 'waiting' }]; actionStore.audit = events; return events })
    actionStore.approveWorkflow.mockImplementationOnce(async () => { actionStore.error = 'mutation denied'; throw new Error('mutation denied') })
    const wrapper = mount(ActionFabricPanel)
    await flushPromises()
    await wrapper.get('[data-test="workflow-waiting"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-test="drawer-approve"]').trigger('click')
    await flushPromises()

    expect(actionStore.loadAudit).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-test="drawer-audit"]').text()).toBe('audit-b-old')
    expect(wrapper.get('[role="status"]').text()).toContain('mutation denied')
  })
})
