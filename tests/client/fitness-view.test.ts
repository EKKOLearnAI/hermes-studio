// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const healthOverview = vi.hoisted(() => ({
  generatedAt: '2026-07-06T09:00:00Z',
  profile: 'default',
  latestPlan: {
    id: 'plan-1',
    planDate: '2026-07-06',
    workouts: [{ title: 'Upper Push', focus: 'chest' }],
    notes: 'Cut day',
  },
  recentWorkouts: [
    { id: 'workout-1', title: 'Bench Press', durationMinutes: 45, intensity: 'medium', startedAt: '2026-07-05T12:00:00Z' },
  ],
  topBodyConcerns: [
    { id: 'body-1', region: 'upper_chest', priority: 'high', score: 74 },
  ],
  externalSummary: {
    currentWeightKg: 80,
    targetWeightKg: 75,
    topRegions: [{ id: 'body-1', region: 'upper_chest', priority: 'high', score: 74 }],
    recentWorkoutCount: 1,
  },
  bodyMap: [
    { id: 'body-1', region: 'upper_chest', payload: { development_level: 2, activation_level: 2, priority: 'high' } },
  ],
  dailyCheckins: [
    { id: 'checkin-1', energyScore: 7, painScore: 2, notes: 'sleep ok' },
  ],
}))

const fetchHealthOverview = vi.hoisted(() => vi.fn())
const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/api/hermes/health-state', () => ({
  fetchHealthOverview,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStore,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ error: vi.fn() }),
  NButton: defineComponent({
    name: 'NButton',
    props: { loading: Boolean },
    template: '<button class="n-button-stub"><slot /></button>',
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    props: { show: Boolean },
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
}))

import FitnessView from '@/views/hermes/FitnessView.vue'

describe('FitnessView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchHealthOverview.mockResolvedValue(healthOverview)
    profilesStore.activeProfileName = 'default'
    profilesStore.profiles = [{ name: 'default' }]
    profilesStore.fetchProfiles.mockResolvedValue(undefined)
  })

  it('renders a dedicated fitness system with page-level tabs', async () => {
    const wrapper = mount(FitnessView)
    await flushPromises()

    expect(fetchHealthOverview).toHaveBeenCalledWith({ profile: 'default' })
    expect(wrapper.text()).toContain('fitness.title')
    expect(wrapper.find('[data-test="fitness-tabs"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('fitness.tabs.today')
    expect(wrapper.text()).toContain('fitness.tabs.plan')
    expect(wrapper.text()).toContain('fitness.tabs.logs')
    expect(wrapper.text()).toContain('fitness.tabs.body')
    expect(wrapper.text()).toContain('fitness.tabs.recovery')
    expect(wrapper.text()).toContain('Upper Push')
    expect(wrapper.text()).toContain('Bench Press')
    expect(wrapper.text()).toContain('upper_chest')
    expect(wrapper.text()).toContain('7')
  })
})
