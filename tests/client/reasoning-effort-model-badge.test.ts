// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import ReasoningEffortModelBadge from '@/components/hermes/chat/ReasoningEffortModelBadge.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'chat.reasoningEffort.tooltip') return 'Reasoning effort'
      if (key.startsWith('chat.reasoningEffort.options.')) return key.split('.').pop() || key
      if (params) return `${key}|${Object.entries(params).map(([name, value]) => `${name}=${value}`).join('|')}`
      return key
    },
  }),
}))

describe('ReasoningEffortModelBadge', () => {
  it('identifies a known reasoning-capable model and lists its levels in the label', () => {
    const wrapper = mount(ReasoningEffortModelBadge, {
      props: { provider: 'kimi-coding', model: 'kimi-k2.5' },
    })

    const badge = wrapper.get('[data-testid="reasoning-effort-badge"]')
    expect(badge.text()).toBe('Reasoning effort')
    expect(badge.attributes('title')).toContain('low / medium / high')
  })

  it('does not label an unknown model as reasoning-capable', () => {
    const wrapper = mount(ReasoningEffortModelBadge, {
      props: { provider: 'custom:gateway', model: 'model-a' },
    })

    expect(wrapper.find('[data-testid="reasoning-effort-badge"]').exists()).toBe(false)
  })
})
