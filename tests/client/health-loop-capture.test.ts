// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

import HealthCaptureWizard from '@/components/hermes/health-loop/HealthCaptureWizard.vue'
import HealthConsentDialog from '@/components/hermes/health-loop/HealthConsentDialog.vue'

describe('health capture and consent', () => {
  it('shows capture requirements and reviews extracted values without rendering raw reports or local paths', async () => {
    const wrapper = mount(HealthCaptureWizard, {
      props: {
        requirements: ['health.loop.capture.requirementFormat', 'health.loop.capture.requirementPrivacy'],
        extractedValues: { weightKg: '82.4 kg', bodyFatPercent: '22.1%' },
        processors: ['health-parser'],
      },
    })

    expect(wrapper.find('[data-test="capture-file-input"]').attributes('aria-label')).toBe('health.loop.capture.fileLabel')
    expect(wrapper.findAll('[data-test="capture-requirement"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="extracted-value-review"]').text()).toContain('82.4 kg')
    expect(wrapper.text()).not.toContain('C:\\Users\\me\\private-report.pdf')
    expect(wrapper.text()).not.toContain('RAW REPORT BODY')

    await wrapper.find('[data-test="capture-submit"]').trigger('click')
    expect(wrapper.emitted('submit')).toBeFalsy()
  })

  it('renders a bounded one-time consent manifest with accessible confirm and cancel controls', async () => {
    const manifest = {
      artifactIds: ['artifact-1'], processor: 'health-parser', purpose: 'measurement',
      selectedRegions: ['whole_body'], requestedFields: ['weightKg', 'bodyFatPercent'], retention: 'no_retention',
    } as const
    const wrapper = mount(HealthConsentDialog, { props: { open: true, manifest } })

    expect(wrapper.attributes('role')).toBe('dialog')
    expect(wrapper.attributes('aria-labelledby')).toBe('health-consent-title')
    expect(wrapper.text()).toContain('health-parser')
    expect(wrapper.text()).toContain('weightKg')
    expect(wrapper.text()).toContain('health.loop.consent.oneTime')
    expect(wrapper.text()).not.toContain('token')
    expect(wrapper.find('[data-test="consent-confirm"]').attributes('aria-label')).toBeTruthy()

    await wrapper.find('[data-test="consent-confirm"]').trigger('click')
    expect(wrapper.emitted('confirm')?.[0]).toEqual([manifest])
    await wrapper.find('[data-test="consent-cancel"]').trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })
})
