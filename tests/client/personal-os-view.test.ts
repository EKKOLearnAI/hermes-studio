// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'

const overview = vi.hoisted(() => ({
  generatedAt: '2026-06-19T00:00:00Z',
  profile: 'default',
  query: null,
  proposals: [
    {
      id: 'proposal-1',
      title: 'Add dashboard task',
      summary: 'Create the first dashboard-backed Personal State task.',
      riskLevel: 'medium',
      status: 'pending',
      proposedAction: { type: 'task.create', payload: { title: 'Create dashboard-backed state task' } },
      targetRecordIds: ['project-hermes-personal-os'],
      provenance: { source: 'hermes', confidence: 0.82, evidence: [], confirmationState: 'pending', actor: 'hermes', createdAt: '2026-06-19T00:00:00Z', updatedAt: '2026-06-19T00:00:00Z', reviewedBy: null, reviewedAt: null },
    },
  ],
  tasks: [
    {
      kind: 'task',
      id: 'task-1',
      title: 'Verify Studio Personal State',
      summary: 'Task from approved proposal',
      notes: 'Task from approved proposal',
      status: 'open',
      sourceProposalId: 'proposal-0',
      provenance: { source: 'hermes', confidence: 1, evidence: [], confirmationState: 'confirmed', actor: 'user', createdAt: '2026-06-19T00:00:00Z', updatedAt: '2026-06-19T00:00:00Z' },
    },
  ],
  pendingProposals: [] as any[],
  memoryContext: {
    id: 'context-1',
    generatedAt: '2026-06-19T00:00:00Z',
    profile: 'default',
    query: null,
    summary: 'Create the first dashboard-backed Personal State task.',
    relevantRecordIds: ['proposal-1'],
    contextBlocks: [],
  },
}))

const fetchOverview = vi.hoisted(() => vi.fn())
const fetchAutopilotOverview = vi.hoisted(() => vi.fn())
const createQuickLog = vi.hoisted(() => vi.fn())
const fetchReminderSettings = vi.hoisted(() => vi.fn())
const updateReminderSettings = vi.hoisted(() => vi.fn())
const fetchReminderDeliveries = vi.hoisted(() => vi.fn())
const sendReminderTest = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/personal-state', () => ({
  fetchPersonalStateOverview: fetchOverview,
}))

vi.mock('@/api/hermes/personal-autopilot', () => ({
  fetchPersonalAutopilotOverview: fetchAutopilotOverview,
  createPersonalAutopilotQuickLog: createQuickLog,
}))

vi.mock('@/api/hermes/autopilot-reminders', () => ({
  fetchAutopilotReminderSettings: fetchReminderSettings,
  updateAutopilotReminderSettings: updateReminderSettings,
  fetchAutopilotReminderDeliveries: fetchReminderDeliveries,
  sendAutopilotReminderTest: sendReminderTest,
}))

vi.mock('@/stores/hermes/profiles', () => ({
  useProfilesStore: () => ({
    activeProfileName: 'default',
    profiles: [{ name: 'default' }],
    fetchProfiles: vi.fn(),
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn() }),
  NButton: defineComponent({
    name: 'NButton',
    props: { loading: Boolean, disabled: Boolean },
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled" @click="$emit(\'click\')"><slot /><slot name="icon" /></button>',
  }),
  NSwitch: defineComponent({
    name: 'NSwitch',
    props: { value: Boolean, loading: Boolean },
    emits: ['update:value'],
    template: '<button class="n-switch-stub" data-test="weixin-reminder-switch" @click="$emit(\'update:value\', !value)">{{ value ? "on" : "off" }}</button>',
  }),
  NSpin: defineComponent({
    name: 'NSpin',
    template: '<div class="n-spin-stub"><slot /></div>',
  }),
}))

import PersonalOSView from '@/views/hermes/PersonalOSView.vue'

describe('PersonalOSView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    overview.pendingProposals = [overview.proposals[0]]
    fetchOverview.mockResolvedValue(overview)
    fetchAutopilotOverview.mockResolvedValue({
      generatedAt: '2026-07-04T09:00:00Z',
      mode: 'nudge',
      state: {
        body: 'needs_attention',
        diet: 'below_target',
        skin: 'observing',
        recovery: 'observing',
        order: 'observing',
      },
      nextAction: {
        id: 'autopilot-action-task-breakfast',
        domain: 'diet',
        title: '吃高蛋白早餐',
        reason: '当前窗口适合处理这个动作。',
        sourceId: 'task-breakfast',
        fallbackTitle: '补一份高蛋白食物',
      },
      signals: [
        { key: 'weight', label: '体重', status: 'tracked', value: '80 kg' },
        { key: 'tasks', label: '今日动作', status: 'active', value: '1' },
      ],
    })
    createQuickLog.mockResolvedValue({ kind: 'diet' })
    fetchReminderSettings.mockResolvedValue({
      profile: 'default',
      enabled: false,
      channel: 'weixin',
      dailyLimit: 5,
      minimumIntervalMinutes: 60,
      quietStart: '23:30',
      quietEnd: '08:00',
    })
    fetchReminderDeliveries.mockResolvedValue([
      { id: 'delivery-1', status: 'failed', error: 'missing_weixin_credentials', actionTitle: '吃高蛋白早餐' },
    ])
    updateReminderSettings.mockResolvedValue({ enabled: true, quietStart: '23:30', quietEnd: '08:00', dailyLimit: 5 })
    sendReminderTest.mockResolvedValue({ status: 'failed', reason: 'missing_weixin_credentials' })
  })

  it('renders the command center next action from Personal Autopilot', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    expect(fetchAutopilotOverview).toHaveBeenCalledWith({ profile: 'default' })
    expect(wrapper.text()).toContain('personalOS.nextAction')
    expect(wrapper.text()).toContain('吃高蛋白早餐')
    expect(wrapper.text()).toContain('当前窗口适合处理这个动作。')
    expect(wrapper.text()).toContain('补一份高蛋白食物')
    expect(wrapper.text()).toContain('personalOS.openFullPlan')
  })

  it('keeps Smart Planning and Health as secondary routes instead of rendering task boards first', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    expect(wrapper.find('[data-test="autopilot-command-center"]').exists()).toBe(true)
    expect(wrapper.html()).toContain('/hermes/personal-os/planning')
    expect(wrapper.html()).toContain('/hermes/personal-os/health')
  })

  it('keeps full Personal OS systems available from the command center', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    expect(wrapper.find('[data-test="autopilot-command-center"]').exists()).toBe(true)
    const moduleGrid = wrapper.find('[data-test="module-grid"]')
    expect(moduleGrid.exists()).toBe(true)
    expect(moduleGrid.text()).toContain('personalOS.systems.planning.title')
    expect(moduleGrid.text()).toContain('personalOS.systems.fitness.title')
    expect(moduleGrid.text()).toContain('personalOS.systems.diet.title')
    expect(moduleGrid.text()).toContain('personalOS.systems.skin.title')
    expect(moduleGrid.text()).toContain('personalOS.systems.health.title')
    expect(moduleGrid.text()).toContain('personalOS.systems.home.title')
    expect(moduleGrid.text()).toContain('personalOS.systems.internet.title')
    expect(moduleGrid.html()).toContain('/hermes/personal-os/fitness')
    expect(moduleGrid.html()).toContain('/hermes/personal-os/home')
    expect(moduleGrid.html()).toContain('/hermes/personal-os/internet-execution')
  })

  it('submits one-sentence quick logs from the command center', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    expect(wrapper.find('[data-test="autopilot-quick-log-input"]').exists()).toBe(true)
    await wrapper.find('[data-test="autopilot-quick-log-input"] input').setValue('午饭吃了鸡腿饭')
    await wrapper.find('[data-test="autopilot-quick-log-submit"]').trigger('click')
    await flushPromises()

    expect(createQuickLog).toHaveBeenCalledWith({ text: '午饭吃了鸡腿饭' }, 'default')
  })

  it('shows and updates Weixin reminder controls', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    expect(fetchReminderSettings).toHaveBeenCalledWith('default')
    expect(fetchReminderDeliveries).toHaveBeenCalledWith('default')
    expect(wrapper.find('[data-test="weixin-reminder-panel"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('personalOS.weixinReminders')
    expect(wrapper.text()).toContain('missing_weixin_credentials')

    await wrapper.find('[data-test="weixin-reminder-switch"]').trigger('click')
    await flushPromises()

    expect(updateReminderSettings).toHaveBeenCalledWith({ enabled: true }, 'default')
  })

  it('sends a Weixin reminder test from the command center', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    await wrapper.find('[data-test="weixin-reminder-test"]').trigger('click')
    await flushPromises()

    expect(sendReminderTest).toHaveBeenCalledWith('default')
  })
})
