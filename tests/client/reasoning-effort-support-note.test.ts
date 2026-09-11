// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ReasoningEffortSupportNote from '@/components/hermes/chat/ReasoningEffortSupportNote.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key.startsWith('chat.reasoningEffort.options.')) return key.split('.').pop() || key
      if (!params) return key
      return `${key}|${Object.entries(params).map(([name, value]) => `${name}=${value}`).join('|')}`
    },
  }),
}))

describe('ReasoningEffortSupportNote', () => {
  it('shows the official and extension levels for a known model', () => {
    const wrapper = mount(ReasoningEffortSupportNote, {
      props: { provider: 'xai', model: 'grok-4.6-0309' },
    })

    expect(wrapper.get('[data-testid="reasoning-effort-support"]').text()).toContain('official=low / medium / high / xhigh')
    expect(wrapper.get('[data-testid="reasoning-effort-support"]').text()).toContain('extensions=max')
  })

  it('does not claim a capability for an unknown model', () => {
    const wrapper = mount(ReasoningEffortSupportNote, {
      props: { provider: 'custom:gateway', model: 'model-a' },
    })

    expect(wrapper.find('[data-testid="reasoning-effort-support"]').exists()).toBe(false)
  })
})
