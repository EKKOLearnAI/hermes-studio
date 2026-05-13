// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

const mockUsageStore = vi.hoisted(() => ({
  isLoading: false,
  hasData: true,
  loadSessions: vi.fn(),
}))

vi.mock('@/stores/hermes/usage', () => ({
  useUsageStore: () => mockUsageStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    name: 'NButton',
    props: {
      loading: Boolean,
      type: String,
      secondary: Boolean,
      quaternary: Boolean,
      size: String,
      ariaPressed: [Boolean, String],
    },
    emits: ['click'],
    template: '<button class="n-button-stub" :data-type="type" :aria-pressed="ariaPressed" @click="$emit(\'click\')"><slot /></button>',
  }),
}))

vi.mock('@/components/hermes/usage/StatCards.vue', () => ({
  default: defineComponent({ name: 'StatCards', template: '<section class="stat-cards-stub" />' }),
}))

vi.mock('@/components/hermes/usage/ModelBreakdown.vue', () => ({
  default: defineComponent({ name: 'ModelBreakdown', template: '<section class="model-breakdown-stub" />' }),
}))

vi.mock('@/components/hermes/usage/DailyTrend.vue', () => ({
  default: defineComponent({ name: 'DailyTrend', template: '<section class="daily-trend-stub" />' }),
}))

import UsageView from '@/views/hermes/UsageView.vue'

describe('UsageView period selector', () => {
  beforeEach(() => {
    mockUsageStore.isLoading = false
    mockUsageStore.hasData = true
    mockUsageStore.loadSessions.mockReset()
  })

  it('loads the default 30-day period on mount', () => {
    mount(UsageView)

    expect(mockUsageStore.loadSessions).toHaveBeenCalledWith(30)
  })

  it('lets users switch usage statistics between common dashboard periods', async () => {
    const wrapper = mount(UsageView)

    const periodButtons = wrapper.findAll('.period-option')
    expect(periodButtons.map(button => button.text())).toEqual(['7d', '30d', '90d', '365d'])
    expect(wrapper.find('.period-selector').attributes('role')).toBe('group')

    await periodButtons[0].trigger('click')
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(7)
    expect(periodButtons[0].attributes('data-type')).toBe('primary')
    expect(periodButtons[0].attributes('aria-pressed')).toBe('true')

    await wrapper.find('.refresh-button').trigger('click')
    expect(mockUsageStore.loadSessions).toHaveBeenLastCalledWith(7)
  })
})
