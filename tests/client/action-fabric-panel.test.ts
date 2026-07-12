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
vi.mock('@/components/hermes/action-fabric/WorkflowDetailDrawer.vue', () => ({ default: defineComponent({ props: ['show', 'workflow'], emits: ['close'], template: '<aside v-if="show" data-test="drawer-stub"><span>{{ workflow?.id }}</span><button data-test="drawer-close" @click="$emit(\'close\')">close</button></aside>' }) }))

import ActionFabricPanel from '@/components/hermes/action-fabric/ActionFabricPanel.vue'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

describe('ActionFabricPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks(); actionStore.workflows = workflows; actionStore.capabilities = [capability] as any; actionStore.executors = [executor] as any
    actionStore.selectedWorkflowId = null; actionStore.selectedWorkflow = null; actionStore.error = null; actionStore.loading = false
    actionStore.loadCapabilities.mockResolvedValue(actionStore.capabilities); actionStore.loadExecutors.mockResolvedValue(actionStore.executors)
    actionStore.loadWorkflows.mockResolvedValue(actionStore.workflows); actionStore.loadAudit.mockResolvedValue([]); actionStore.loadControl.mockResolvedValue(actionStore.control)
    actionStore.selectWorkflow.mockImplementation(async (id: string) => { actionStore.selectedWorkflowId = id; actionStore.selectedWorkflow = { ...detail, id }; return actionStore.selectedWorkflow })
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
})
