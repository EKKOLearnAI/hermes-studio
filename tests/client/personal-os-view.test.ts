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

vi.mock('@/api/hermes/personal-state', () => ({
  fetchPersonalStateOverview: fetchOverview,
}))

vi.mock('@/api/hermes/personal-autopilot', () => ({
  fetchPersonalAutopilotOverview: fetchAutopilotOverview,
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
    expect(wrapper.find('[data-test="module-grid"]').exists()).toBe(false)
    expect(wrapper.html()).toContain('/hermes/personal-os/planning')
    expect(wrapper.html()).toContain('/hermes/personal-os/health')
  })
})
