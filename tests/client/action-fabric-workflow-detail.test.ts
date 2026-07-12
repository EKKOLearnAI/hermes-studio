// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'

const warnings: any[] = []
vi.mock('vue-i18n', () => ({ useI18n: () => ({ locale: ref('en') }) }))
vi.mock('naive-ui', () => ({
  NDrawer: defineComponent({ props: ['show'], emits: ['update:show'], template: '<div v-if="show"><slot /></div>' }),
  NDrawerContent: defineComponent({ template: '<section><slot /></section>' }),
  NTag: defineComponent({ template: '<span><slot /></span>' }),
  useDialog: () => ({ warning: (options: any) => warnings.push(options) }),
}))

import WorkflowDetailDrawer from '@/components/hermes/action-fabric/WorkflowDetailDrawer.vue'

const workflow = { id: 'wf-1', intentId: 'intent-1', executorId: 'internal-twin', policyDecisionId: 'policy-1', compensationIntentId: null, state: 'waiting_user', version: 1, attempt: 2, maxAttempts: 3, leaseExpiresAt: null, retryAt: 'later', lastErrorCode: 'temporary_failure', capabilityId: 'internal.twin.preference.set', goal: 'Set preference', requestedByRoleId: 'health-manager', requestedByUserId: 'user-1', createdAt: '', updatedAt: '', completedAt: null, availableActions: { approve: true, reject: true, cancel: true, retry: false, compensate: false }, intent: { id: 'intent-1', capabilityId: 'internal.twin.preference.set', capabilityVersion: 1, requestedByRoleId: 'health-manager', requestedByUserId: 'user-1', idempotencyKey: 'safe-key', goal: 'Set preference', target: {}, input: {}, constraints: {}, rationale: 'User request', sanitizedSummary: { key: 'theme' }, createdAt: '', updatedAt: '' }, policyDecision: { id: 'policy-1', intentId: 'intent-1', executorId: 'internal-twin', outcome: 'waiting_user', reasonCodes: ['risk_requires_approval'], policyVersion: 3, sanitizedSummary: { target: 'preference' }, budget: null, createdAt: '' }, steps: [{ id: 'step-1', workflowId: 'wf-1', ordinal: 1, kind: 'execute', state: 'failed', executorId: 'internal-twin', input: { safe: true }, output: null, evidence: [{ kind: 'verification', summary: '<b>sanitized</b>', data: { status: 'mismatch' }, capturedAt: '' }], attempt: 2, lastErrorCode: 'temporary_failure', createdAt: '', updatedAt: '', startedAt: '', completedAt: '' }] } as any
const audit = [{ id: 'audit-9', sequence: 9, eventType: 'workflow.waiting_user', aggregateId: 'wf-1', occurredAt: 'now' }] as any

describe('WorkflowDetailDrawer', () => {
  it('renders only sanitized authoritative detail, retry/evidence/audit references, and eligibility', async () => {
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    await flushPromises()
    expect(wrapper.text()).toContain('health-manager')
    expect(wrapper.text()).toContain('internal.twin.preference.set')
    expect(wrapper.text()).toContain('risk_requires_approval')
    expect(wrapper.text()).toContain('2 / 3')
    expect(wrapper.text()).toContain('<b>sanitized</b>')
    expect(wrapper.find('b').exists()).toBe(false)
    expect(wrapper.text()).toContain('audit-9')
    expect(wrapper.find('[data-test="compensation-eligible"]').exists()).toBe(false)
    expect(wrapper.find('button button').exists()).toBe(false)
  })

  it('validates reasons, confirms every state action, and closes with Escape', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    await wrapper.get('[data-test="approve-workflow"]').trigger('click')
    warnings.pop().onPositiveClick()
    expect(wrapper.emitted('approve')).toHaveLength(1)
    ;(wrapper.emitted('approve')?.[0]?.[0] as () => void)()
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-test="reject-workflow"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="action-reason"]').setValue('Not authorized')
    for (const action of ['reject', 'cancel']) {
      await wrapper.get(`[data-test="${action}-workflow"]`).trigger('click')
      warnings.pop().onPositiveClick()
      ;(wrapper.emitted(action)?.[0]?.[1] as () => void)()
      await wrapper.vm.$nextTick()
    }
    expect(wrapper.emitted('reject')?.[0]?.[0]).toBe('Not authorized')
    expect(wrapper.emitted('cancel')?.[0]?.[0]).toBe('Not authorized')
    await wrapper.get('[data-test="workflow-drawer"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('offers confirmed retry and compensation only for server-derived eligible states', async () => {
    warnings.length = 0
    const failed = { ...workflow, state: 'failed', availableActions: { ...workflow.availableActions, approve: false, reject: false, cancel: false, retry: true } }
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow: failed, audit, saving: false } })
    await wrapper.get('[data-test="retry-workflow"]').trigger('click'); warnings.pop().onPositiveClick()
    expect(wrapper.emitted('retry')).toHaveLength(1)
    ;(wrapper.emitted('retry')?.[0]?.[0] as () => void)()
    await wrapper.setProps({ workflow: { ...workflow, state: 'succeeded', availableActions: { ...workflow.availableActions, approve: false, reject: false, cancel: false, compensate: true } } })
    await wrapper.get('[data-test="action-reason"]').setValue('Restore preference')
    expect(wrapper.get('[data-test="compensation-eligible"]').exists()).toBe(true)
    await wrapper.get('[data-test="compensate-workflow"]').trigger('click'); warnings.pop().onPositiveClick()
    expect(wrapper.emitted('compensate')?.[0]?.[0]).toBe('Restore preference')
  })

  it('serializes confirmation creation and positive submission until saving completes', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    const button = wrapper.get('[data-test="approve-workflow"]')

    await Promise.all([button.trigger('click'), button.trigger('click')])
    expect(warnings).toHaveLength(1)
    expect(button.attributes('disabled')).toBeDefined()
    warnings[0].onPositiveClick()
    warnings[0].onPositiveClick()
    expect(wrapper.emitted('approve')).toHaveLength(1)
    warnings[0].onClose()
    await wrapper.vm.$nextTick()
    expect(button.attributes('disabled')).toBeDefined()

    await wrapper.setProps({ saving: true })
    await wrapper.setProps({ saving: false })
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(warnings).toHaveLength(2)
  })

  it('releases an unsubmitted confirmation after cancellation', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    const button = wrapper.get('[data-test="approve-workflow"]')

    await button.trigger('click')
    warnings[0].onNegativeClick()
    await wrapper.vm.$nextTick()
    await button.trigger('click')

    expect(warnings).toHaveLength(2)
  })

  it('does not let a stale completion release a newer submitted confirmation', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    const button = wrapper.get('[data-test="approve-workflow"]')

    await button.trigger('click')
    warnings[0].onPositiveClick()
    const completeA = wrapper.emitted('approve')?.[0]?.[0] as () => void
    await wrapper.setProps({ saving: true })
    await wrapper.setProps({ saving: false })
    await button.trigger('click')
    warnings[1].onPositiveClick()
    const completeB = wrapper.emitted('approve')?.[1]?.[0] as () => void

    completeA()
    await wrapper.vm.$nextTick()
    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(warnings).toHaveLength(2)

    completeB()
    await wrapper.vm.$nextTick()
    expect(button.attributes('disabled')).toBeUndefined()
  })

  it('ignores stale dialog callbacks after close, reopen, and workflow replacement', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    await wrapper.get('[data-test="approve-workflow"]').trigger('click')
    const staleDialog = warnings[0]

    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true, workflow: { ...workflow, id: 'wf-2' } })
    const button = wrapper.get('[data-test="approve-workflow"]')
    await button.trigger('click')
    staleDialog.onNegativeClick()
    staleDialog.onClose()
    await wrapper.vm.$nextTick()

    expect(button.attributes('disabled')).toBeDefined()
    await button.trigger('click')
    expect(warnings).toHaveLength(2)
  })

  it('invalidates a confirmation when the same workflow advances version and state', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    await wrapper.get('[data-test="approve-workflow"]').trigger('click')
    const staleDialog = warnings[0]

    await wrapper.setProps({ workflow: { ...workflow, version: 2, state: 'failed', availableActions: { ...workflow.availableActions, approve: false, reject: false, cancel: false, retry: true } } })
    staleDialog.onPositiveClick()
    staleDialog.onPositiveClick()
    staleDialog.onNegativeClick()
    staleDialog.onClose()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('approve')).toBeUndefined()
    const retry = wrapper.get('[data-test="retry-workflow"]')
    expect(retry.attributes('disabled')).toBeUndefined()
    await Promise.all([retry.trigger('click'), retry.trigger('click')])
    expect(warnings).toHaveLength(2)
    warnings[1].onPositiveClick()
    warnings[1].onPositiveClick()
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('renders actions only when the server explicitly marks them available', async () => {
    const serverOnly = {
      ...workflow,
      state: 'failed',
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      availableActions: { approve: true, reject: false, cancel: false, retry: false, compensate: false },
    }
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow: serverOnly, audit, saving: false } })

    expect(wrapper.find('[data-test="approve-workflow"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="reject-workflow"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="cancel-workflow"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="retry-workflow"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="compensate-workflow"]').exists()).toBe(false)
  })

  it.each([
    { name: 'leased effectful work', patch: { state: 'executing', leaseExpiresAt: '2099-01-01T00:00:00.000Z' }, action: 'cancel' },
    { name: 'unsafe failed work', patch: { state: 'failed' }, action: 'retry' },
    { name: 'stale reversible contract', patch: { state: 'succeeded' }, action: 'compensate' },
  ])('does not infer $action from $name', ({ patch, action }) => {
    const authoritative = { ...workflow, ...patch, availableActions: { approve: false, reject: false, cancel: false, retry: false, compensate: false } }
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow: authoritative, audit, saving: false } })
    expect(wrapper.find(`[data-test="${action}-workflow"]`).exists()).toBe(false)
  })

  it('shows a control-recovery retry even when local state would not infer it', () => {
    const resumed = { ...workflow, state: 'waiting_user', availableActions: { approve: false, reject: false, cancel: false, retry: true, compensate: false } }
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow: resumed, audit, saving: false } })
    expect(wrapper.find('[data-test="retry-workflow"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="approve-workflow"]').exists()).toBe(false)
  })

  it.each([
    { name: 'missing', availableActions: undefined },
    { name: 'unknown', availableActions: { destroy: true } },
  ])('fails closed for $name availableActions', ({ availableActions }) => {
    const malformed = { ...workflow, availableActions } as any
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow: malformed, audit, saving: false } })
    for (const action of ['approve', 'reject', 'cancel', 'retry', 'compensate']) {
      expect(wrapper.find(`[data-test="${action}-workflow"]`).exists()).toBe(false)
    }
  })

  it('invalidates an old confirmation when refreshed server actions revoke it', async () => {
    warnings.length = 0
    const wrapper = mount(WorkflowDetailDrawer, { props: { show: true, workflow, audit, saving: false } })
    await wrapper.get('[data-test="approve-workflow"]').trigger('click')
    const staleDialog = warnings[0]

    await wrapper.setProps({ workflow: { ...workflow, version: 2, availableActions: { ...workflow.availableActions, approve: false } } })
    staleDialog.onPositiveClick()
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted('approve')).toBeUndefined()
    expect(wrapper.find('[data-test="approve-workflow"]').exists()).toBe(false)
  })
})
