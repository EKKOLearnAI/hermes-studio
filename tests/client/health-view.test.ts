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
  bodyProfile: {
    latestMeasurements: {
      id: 'body-measurement-baseline',
      title: 'Obsidian body measurements baseline',
      source: 'obsidian-import',
      notes: '2025-12-16 乐刻健身房测',
      recordedAt: '2025-12-16T10:30:00+08:00',
      measurements: {
        chest_cm: 102.5,
        waist_cm: 86,
        hip_cm: 102,
        left_upper_arm_relaxed_cm: 34.5,
        right_upper_arm_relaxed_cm: 34.8,
      },
      weightKg: 83.5,
      bodyFatPercent: 21.1,
    },
    posture: {
      id: 'posture-baseline',
      title: 'Posture assessment baseline',
      source: 'obsidian-import',
      notes: '右侧骨盆旋前、右侧肩胛下回旋、右侧肩颈紧绷',
      recordedAt: '2025-12-16T10:30:00+08:00',
      priority: 'high',
      issues: ['pelvic_rotation_right', 'right_scapula_downward_rotation'],
      compensationChain: ['pelvis_right_rotation', 'lumbar_right_rotation', 'thorax_right_posterior_rotation'],
      pain: [],
    },
    skin: {
      id: 'skin-routine-baseline',
      title: 'Skin routine baseline',
      source: 'obsidian-import',
      notes: '淡化痘印、消灭痘痘黑头、水润有光泽',
      recordedAt: '2025-12-16T10:30:00+08:00',
      concerns: ['acne_marks', 'acne', 'blackheads', 'hydration'],
      routine: { morning: ['cleanse', 'toner', 'serum', 'moisturizer', 'sunscreen'] },
    },
    nextDataNeeded: ['body_measurements_recheck', 'posture_recheck', 'skin_status_recheck'],
  },
  latestPlan: { id: 'plan-1', planDate: '2026-06-21', targets: {}, meals: [], workouts: [{ title: 'Upper Push' }], supplements: [], notes: 'Cut day' },
  latestScaleReading: {
    measuredAt: '2026-07-08T08:41:00+08:00',
    sourceDevice: 'Mi Body Composition Scale S400',
    sourceModel: 'yunmai.scales.ms103',
    weightKg: 85,
    bmi: 26.8,
    bodyFatPercent: 23.9,
    bodyScore: 81,
    muscleMassKg: 61.2,
    visceralFatLevel: 10,
    basalMetabolismKcal: 1768,
  },
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
const fetchScaleSyncSettings = vi.hoisted(() => vi.fn())
const updateScaleSyncSettings = vi.hoisted(() => vi.fn())
const runScaleSync = vi.hoisted(() => vi.fn())
const profilesStore = vi.hoisted(() => ({
  activeProfileName: 'default',
  profiles: [{ name: 'default' }],
  fetchProfiles: vi.fn(),
}))

vi.mock('@/api/hermes/health-state', () => ({
  fetchHealthOverview,
  fetchScaleSyncSettings,
  updateScaleSyncSettings,
  runScaleSync,
}))
const healthLoopStore = vi.hoisted(() => ({
  overview: {
    settings: { subjectId: 'self', liveDeliveryEnabled: false, profile: 'default', recipient: 'configured-self', configuredConnectors: ['xiaomi-s400'], configuredProcessors: ['health-parser'], version: 1, updatedAt: '2026-07-14T08:00:00Z' },
    connectors: [], summary: { interventionCount: 1, activeInterventionCount: 1, projectionCount: 0 },
  },
  connectors: [{ id: 'xiaomi-s400', configured: true, configurationState: 'configured', authorizationState: 'authorized', health: 'healthy', domains: ['body_composition'], freshnessByDomain: { body_composition: '2026-07-14T08:00:00Z' }, capabilities: { read: [], write: [] } }],
  interventions: [{ actionId: 'a1', interventionId: 'i1', workflowId: 'wf1', capabilityId: 'health.plan', category: 'recovery', priority: 1, risk: 'low', authority: 'inform_only', status: 'active', effectiveDate: '2026-07-14', createdAt: '2026-07-14T08:00:00Z', supersededAt: null }],
  settings: { subjectId: 'self', liveDeliveryEnabled: false, profile: 'default', recipient: 'configured-self', configuredConnectors: ['xiaomi-s400'], configuredProcessors: ['health-parser'], version: 1, updatedAt: '2026-07-14T08:00:00Z' },
  loading: false, saving: false, error: null,
  loadOverview: vi.fn(), loadConnectors: vi.fn(), loadInterventions: vi.fn(), loadSettings: vi.fn(),
  syncConnector: vi.fn(), createArtifact: vi.fn(), submitFeedback: vi.fn(), updateSettings: vi.fn(),
}))
const issueHealthConsent = vi.hoisted(() => vi.fn())
const requestHealthArtifactAnalysis = vi.hoisted(() => vi.fn())
const actionFabricApi = vi.hoisted(() => ({
  fetchActionWorkflow: vi.fn(), approveActionWorkflow: vi.fn(), rejectActionWorkflow: vi.fn(),
  cancelActionWorkflow: vi.fn(), retryActionWorkflow: vi.fn(), compensateActionWorkflow: vi.fn(),
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => profilesStore,
}))

vi.mock('@/stores/hermes/health-loop', () => ({
  useHealthLoopStore: () => healthLoopStore,
  issueHealthConsent,
  requestHealthArtifactAnalysis,
}))

vi.mock('@/api/hermes/action-fabric', () => actionFabricApi)

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
    fetchScaleSyncSettings.mockResolvedValue({
      enabled: true,
      source: 'xiaomihome',
      username: 'xiaomi-user',
      hasPassword: true,
      passwordMasked: '********',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: 'C:\\tools\\SmartScaleConnect.exe',
      configured: true,
    })
    updateScaleSyncSettings.mockResolvedValue({
      enabled: true,
      source: 'xiaomihome',
      username: 'xiaomi-user',
      hasPassword: true,
      passwordMasked: '********',
      region: 'cn',
      scaleModel: 'yunmai.scales.ms103',
      scaleconnectPath: 'C:\\tools\\SmartScaleConnect.exe',
      configured: true,
    })
    runScaleSync.mockResolvedValue({ status: 'skipped', reason: 'missing_scaleconnect_path', importedCount: 0, readings: [] })
    profilesStore.activeProfileName = 'default'
    profilesStore.profiles = [{ name: 'default' }]
    profilesStore.fetchProfiles.mockResolvedValue(undefined)
    healthLoopStore.loadOverview.mockResolvedValue(healthLoopStore.overview)
    healthLoopStore.loadConnectors.mockResolvedValue(healthLoopStore.connectors)
    healthLoopStore.loadInterventions.mockResolvedValue(healthLoopStore.interventions)
    healthLoopStore.loadSettings.mockResolvedValue(healthLoopStore.settings)
    healthLoopStore.createArtifact.mockResolvedValue({ id: 'artifact-1', manifestDigest: 'digest-1' })
    actionFabricApi.fetchActionWorkflow.mockResolvedValue({
      id: 'wf1', state: 'waiting_user', version: 2,
      availableActions: { approve: true, reject: true, cancel: false, retry: false, compensate: false },
    })
    issueHealthConsent.mockResolvedValue({ consentId: 'consent-1', token: 'secret-token' })
    requestHealthArtifactAnalysis.mockResolvedValue({
      workflow: { id: 'analysis-wf', state: 'executing', version: 1, availableActions: { approve: false, reject: false, cancel: true, retry: false, compensate: false } },
    })
  })

  it('renders the health cockpit from the migrated health overview', async () => {
    const wrapper = mount(HealthView)
    await flushPromises()

    expect(fetchHealthOverview).toHaveBeenCalledWith({ profile: 'default', includeRecords: false })
    expect(fetchScaleSyncSettings).toHaveBeenCalledWith('default')
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
    expect(wrapper.text()).toContain('Mi Body Composition Scale S400')
    expect(wrapper.text()).toContain('S400 / 米家自动同步')
    const twinPanel = wrapper.find('[data-test="body-digital-twin-panel"]')
    expect(twinPanel.exists()).toBe(true)
    expect(twinPanel.text()).toContain('身体数字孪生')
    expect(twinPanel.text()).toContain('体成分层')
    expect(twinPanel.text()).toContain('Mi Body Composition Scale S400')
    expect(twinPanel.text()).toContain('S400 / 米家自动同步')
    expect(twinPanel.text()).toContain('数据源')
    expect(twinPanel.text()).toContain('复测围度')
    expect(twinPanel.text()).not.toContain('外形尺寸层')
    expect(twinPanel.text()).not.toContain('体态代偿链')
    expect(twinPanel.text()).not.toContain('皮肤外观层')
    const selectedRegionData = wrapper.find('[data-test="selected-region-data"]')
    expect(selectedRegionData.text()).toContain('胸部数据')
    expect(selectedRegionData.text()).toContain('胸围')
    expect(selectedRegionData.text()).toContain('102.5 cm')
    expect(selectedRegionData.text()).toContain('体脂率')
    expect(wrapper.find('[data-test="skin-appearance-layer"]').text()).toContain('全身皮肤外观层')
    expect(wrapper.find('[data-test="skin-appearance-layer"]').text()).toContain('黑头')
    expect(selectedRegionData.text()).toContain('102.5 cm')
    expect(wrapper.text()).toContain('痘印')
    expect(wrapper.text()).toContain('黑头')
    expect(wrapper.find('[data-test="scale-sync-username"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="latest-scale-reading"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="body-profile-panel"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('23.9%')
    expect(wrapper.text()).toContain('1768 kcal')
    expect(wrapper.find('[data-test="body-region-chest"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-test="health-summary-metric"]')).toHaveLength(4)
  })

  it('renders page-level health system tabs', async () => {
    const wrapper = mount(HealthView)
    await flushPromises()

    const tabs = wrapper.find('[data-test="health-system-tabs"]')
    expect(tabs.exists()).toBe(true)
    expect(tabs.text()).toContain('health.tabs.overview')
    expect(tabs.text()).toContain('health.tabs.body3d')
    expect(tabs.text()).toContain('health.tabs.diet')
    expect(tabs.text()).toContain('health.tabs.fitness')
    expect(tabs.text()).toContain('health.tabs.skin')
    expect(tabs.text()).toContain('health.tabs.internal')
  })

  it('puts the closed-loop command center before retained health drill-downs', async () => {
    const wrapper = mount(HealthView)
    await flushPromises()

    expect(healthLoopStore.loadOverview).toHaveBeenCalled()
    expect(healthLoopStore.loadConnectors).toHaveBeenCalled()
    expect(healthLoopStore.loadInterventions).toHaveBeenCalledWith({ status: 'active' })
    expect(healthLoopStore.loadSettings).toHaveBeenCalled()
    expect(actionFabricApi.fetchActionWorkflow).toHaveBeenCalledWith('wf1')
    const commandCenter = wrapper.find('[data-test="health-loop-command-center"]')
    const bodyTwin = wrapper.find('[data-test="body-digital-twin-panel"]')
    expect(commandCenter.exists()).toBe(true)
    expect(commandCenter.element.compareDocumentPosition(bodyTwin.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(wrapper.find('[data-test="health-readiness-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="health-domain-status-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="health-intervention-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="health-automation-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="body-digital-twin-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="health-system-tabs"]').text()).toContain('health.tabs.internal')
  })

  it('recovers the active workflow on refresh and ignores an older workflow response', async () => {
    let resolveOld!: (value: any) => void
    const old = new Promise(resolve => { resolveOld = resolve })
    const newest = {
      id: 'wf1', state: 'waiting_user', version: 4,
      availableActions: { approve: false, reject: true, cancel: false, retry: false, compensate: false },
    }
    actionFabricApi.fetchActionWorkflow.mockImplementationOnce(() => old).mockResolvedValueOnce(newest)

    const wrapper = mount(HealthView)
    await vi.waitFor(() => expect(actionFabricApi.fetchActionWorkflow).toHaveBeenCalledTimes(1))
    await wrapper.find('[data-test="health-refresh"]').trigger('click')
    await flushPromises()

    expect(actionFabricApi.fetchActionWorkflow).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-test="workflow-action-reject"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="workflow-action-approve"]').exists()).toBe(false)
    resolveOld({ ...newest, version: 1, availableActions: { ...newest.availableActions, approve: true, reject: false } })
    await flushPromises()
    expect(wrapper.find('[data-test="workflow-action-reject"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="workflow-action-approve"]').exists()).toBe(false)
  })

  it('uses user-reviewed extracted values to create a non-empty consent manifest', async () => {
    const wrapper = mount(HealthView)
    await flushPromises()
    const fileInput = wrapper.find<HTMLInputElement>('[data-test="capture-file-input"]')
    Object.defineProperty(fileInput.element, 'files', {
      configurable: true,
      value: [new File(['report'], 'health-report.txt', { type: 'text/plain' })],
    })
    await fileInput.trigger('change')
    await wrapper.find('[data-test="extracted-value-weightKg"]').setValue('82.4 kg')
    await wrapper.find('[data-test="extracted-value-bodyFatPercent"]').setValue('22.1%')
    await wrapper.find('[data-test="capture-submit"]').trigger('click')
    await flushPromises()

    expect(healthLoopStore.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { healthAnalysis: expect.objectContaining({ requestedFields: ['weightKg', 'bodyFatPercent'] }) },
    }))
    const dialog = wrapper.find('[data-test="health-consent-dialog"]')
    expect(dialog.text()).toContain('weightKg')
    expect(dialog.text()).toContain('bodyFatPercent')
    await dialog.find('[data-test="consent-confirm"]').trigger('click')
    await flushPromises()
    expect(issueHealthConsent).toHaveBeenCalledWith(healthLoopStore, {
      manifest: expect.objectContaining({ requestedFields: ['weightKg', 'bodyFatPercent'] }),
    })
  })

  it('falls back to default profile when profile refresh fails', async () => {
    profilesStore.activeProfileName = ''
    profilesStore.profiles = []
    profilesStore.fetchProfiles.mockRejectedValueOnce(new Error('Bad Gateway'))

    mount(HealthView)
    await flushPromises()

    expect(fetchHealthOverview).toHaveBeenCalledWith({ profile: 'default', includeRecords: false })
  })
})
