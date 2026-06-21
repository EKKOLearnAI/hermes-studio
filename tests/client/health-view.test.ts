// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'

const healthOverview = vi.hoisted(() => ({
  generatedAt: '2026-06-21T16:00:00Z',
  profile: 'default',
  healthProfile: {
    displayName: null,
    birthDate: null,
    sex: null,
    heightCm: 175,
    weightKg: 80,
    weightTargetKg: 75,
    activityLevel: 'moderate',
    goals: ['cut'],
    conditions: [],
    allergies: [],
    nutritionTargets: { calories: 2200, protein: 160, carbs: 220, fat: 65, fiber: 30, water: 3 },
  },
  weightSummary: { currentKg: 80, previousKg: 81, deltaKg: -1, targetKg: 75 },
  nutritionSummary: {
    targets: { calories: 2200, protein: 160, carbs: 220, fat: 65, fiber: 30, water: 3 },
    consumed: { calories: 1100, protein: 80, carbs: 100, fat: 35, fiber: 12, water: 1.5 },
    remaining: { calories: 1100, protein: 80, carbs: 120, fat: 30, fiber: 18, water: 1.5 },
  },
  recentWorkouts: [{ id: 'workout-1', title: 'Bench Press', durationMinutes: 45, intensity: 'medium', startedAt: '2026-06-20T12:00:00Z' }],
  topBodyConcerns: [{ id: 'body-1', region: 'upper_chest', priority: 'high', score: 74 }],
  digitalTwinSummary: {
    currentWeightKg: 80,
    targetWeightKg: 75,
    externalConcernCount: 1,
    internalMarkerCount: 1,
    micronutrientGapCount: 2,
  },
  externalSummary: {
    currentWeightKg: 80,
    targetWeightKg: 75,
    topRegions: [{ id: 'body-1', region: 'upper_chest', priority: 'high', score: 74 }],
    recentWorkoutCount: 1,
  },
  internalMarkers: [
    { id: 'record-1', key: 'blood_pressure', label: 'blood_pressure', value: '118/75', unit: 'mmHg', status: 'ok', source: 'personal-assistant-import', recordedAt: '2026-06-21T07:05:00Z', referenceRange: null, notes: 'resting' },
  ],
  micronutrientSummary: {
    items: [
      { key: 'magnesium', consumed: 170, target: 350, remaining: 180, status: 'low' },
      { key: 'vitamin_d', consumed: 4, target: 10, remaining: 6, status: 'low' },
    ],
  },
  latestPlan: { id: 'plan-1', planDate: '2026-06-21', targets: {}, meals: [], workouts: [{ title: 'Upper Push' }], supplements: [], notes: 'Cut day' },
  supplementSummary: { total: 12, completedToday: 3, remainingToday: 9, items: [] },
  bodyMap: [
    { id: 'body-1', region: 'upper_chest', payload: { development_level: 2, activation_level: 2, priority: 'high', posture_constraint_level: 2 } },
    { id: 'body-2', region: 'rear_delts', payload: { development_level: 3, activation_level: 3, priority: 'medium', posture_constraint_level: 1 } },
  ],
  records: [],
  workouts: [],
  foodItems: [],
  foodLogs: [{ id: 'food-log-1', meal: 'lunch' }],
  foodTemplates: [],
  supplements: [],
  supplementLogs: [],
  dailyPlans: [],
  dailyCheckins: [],
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

import HealthView from '@/views/hermes/HealthView.vue'

describe('HealthView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchHealthOverview.mockResolvedValue(healthOverview)
    profilesStore.activeProfileName = 'default'
    profilesStore.profiles = [{ name: 'default' }]
    profilesStore.fetchProfiles.mockResolvedValue(undefined)
  })

  it('renders the health cockpit from the migrated health overview', async () => {
    const wrapper = mount(HealthView)
    await flushPromises()

    expect(fetchHealthOverview).toHaveBeenCalledWith({ profile: 'default' })
    expect(wrapper.text()).toContain('health.title')
    expect(wrapper.text()).toContain('80 kg')
    expect(wrapper.text()).toContain('75 kg')
    expect(wrapper.text()).toContain('1100')
    expect(wrapper.text()).toContain('Bench Press')
    expect(wrapper.text()).toContain('Body3D')
    expect(wrapper.text()).toContain('身体数字孪生')
    expect(wrapper.text()).toContain('外在健康')
    expect(wrapper.text()).toContain('内在健康')
    expect(wrapper.text()).toContain('blood_pressure')
    expect(wrapper.text()).toContain('magnesium')
    expect(wrapper.text()).toContain('Upper Push')
    expect(wrapper.find('[data-test="body-region-chest"]').exists()).toBe(true)
  })

  it('falls back to default profile when profile refresh fails', async () => {
    profilesStore.activeProfileName = ''
    profilesStore.profiles = []
    profilesStore.fetchProfiles.mockRejectedValueOnce(new Error('Bad Gateway'))

    mount(HealthView)
    await flushPromises()

    expect(fetchHealthOverview).toHaveBeenCalledWith({ profile: 'default' })
  })
})
