// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import HealthAutomationPanel from '@/components/hermes/health-loop/HealthAutomationPanel.vue'
import HealthDomainStatusGrid from '@/components/hermes/health-loop/HealthDomainStatusGrid.vue'
import HealthInterventionPanel from '@/components/hermes/health-loop/HealthInterventionPanel.vue'
import HealthReadinessPanel from '@/components/hermes/health-loop/HealthReadinessPanel.vue'

const connectors = [
  {
    id: 'xiaomi-s400', configured: true, configurationState: 'configured', authorizationState: 'authorized',
    health: 'healthy', lastSuccessAt: '2026-07-13T09:00:00Z',
    domains: ['body_composition', 'measurements', 'posture', 'skin'],
    freshnessByDomain: { body_composition: '2026-07-13T09:00:00Z', measurements: '2026-07-12T09:00:00Z' },
    capabilities: { read: [], write: [] },
  },
  {
    id: 'health-import', configured: true, configurationState: 'configured', authorizationState: 'not_required',
    health: 'degraded', errorCode: 'connector_timeout',
    domains: ['diet', 'fitness', 'sleep', 'internal_health'], freshnessByDomain: {}, capabilities: { read: [], write: [] },
  },
] as any

const workflow = {
  id: 'workflow-1', state: 'waiting_user', version: 3,
  availableActions: { approve: true, reject: true, cancel: false, retry: false, compensate: false },
} as any

describe('health closed-loop command center', () => {
  it('puts one readiness action first and keeps alternatives separately available', async () => {
    const wrapper = mount(HealthReadinessPanel, { props: { connectors, activeInterventionCount: 1 } })

    expect(wrapper.attributes('data-test')).toBe('health-readiness-panel')
    expect(wrapper.findAll('[data-test="primary-health-action"]')).toHaveLength(1)
    expect(wrapper.find('[data-test="primary-health-action"]').attributes('aria-label')).toBeTruthy()
    expect(wrapper.findAll('[data-test="alternative-health-action"]').length).toBeGreaterThan(0)

    await wrapper.find('[data-test="primary-health-action"]').trigger('click')
    expect(wrapper.emitted('action')).toBeTruthy()
  })

  it('renders all eight domain freshness states and sanitized connector failures', () => {
    const wrapper = mount(HealthDomainStatusGrid, { props: { connectors } })

    expect(wrapper.findAll('[data-test="health-domain-status"]')).toHaveLength(8)
    expect(wrapper.text()).toContain('health.loop.domains.body_composition')
    expect(wrapper.text()).toContain('health.loop.freshness.current')
    expect(wrapper.text()).toContain('health.loop.freshness.missing')
    expect(wrapper.find('[data-test="connector-error-health-import"]').text()).toContain('connector_timeout')
    expect(wrapper.text()).not.toContain('C:\\private\\health-report.pdf')
  })

  it('shows active workflows, feedback actions, and only server-authorized workflow actions', async () => {
    const wrapper = mount(HealthInterventionPanel, {
      props: {
        interventions: [{
          actionId: 'action-1', interventionId: 'intervention-1', workflowId: 'workflow-1', capabilityId: 'health.plan',
          category: 'recovery', priority: 1, risk: 'low', authority: 'approval', status: 'active',
          effectiveDate: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', supersededAt: null,
        }] as any,
        workflow,
      },
    })

    expect(wrapper.text()).toContain('workflow-1')
    expect(wrapper.text()).toContain('health.loop.workflow.waiting_user')
    expect(wrapper.find('[data-test="workflow-action-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="workflow-action-reject"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="workflow-action-cancel"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test^="feedback-"]').length).toBeGreaterThan(1)

    await wrapper.find('[data-test="workflow-action-approve"]').trigger('click')
    expect(wrapper.emitted('workflow-action')?.[0]).toEqual(['approve'])
  })

  it('keeps delivery in shadow mode until the exact live Weixin confirmation is typed', async () => {
    const wrapper = mount(HealthAutomationPanel, {
      props: { settings: { liveDeliveryEnabled: false, version: 4 } as any },
    })

    expect(wrapper.find('[data-test="automation-mode"]').text()).toContain('health.loop.automation.shadow')
    const enable = wrapper.find<HTMLButtonElement>('[data-test="enable-live-weixin"]')
    expect(enable.element.disabled).toBe(true)

    await wrapper.find('[data-test="live-confirmation-input"]').setValue('LIVE')
    expect(enable.element.disabled).toBe(true)
    await wrapper.find('[data-test="live-confirmation-input"]').setValue('LIVE WEIXIN')
    expect(enable.element.disabled).toBe(false)
    await enable.trigger('click')
    expect(wrapper.emitted('set-live')?.[0]).toEqual([true])
  })
})
