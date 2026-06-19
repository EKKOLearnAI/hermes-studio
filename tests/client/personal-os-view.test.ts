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
const approveProposal = vi.hoisted(() => vi.fn())
const rejectProposal = vi.hoisted(() => vi.fn())
const checkInTask = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/personal-state', () => ({
  fetchPersonalStateOverview: fetchOverview,
  approvePersonalStateProposal: approveProposal,
  rejectPersonalStateProposal: rejectProposal,
  checkInPersonalStateTask: checkInTask,
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
    approveProposal.mockResolvedValue({ ...overview.proposals[0], status: 'approved' })
    rejectProposal.mockResolvedValue({ ...overview.proposals[0], status: 'rejected' })
    checkInTask.mockResolvedValue({ ...overview.tasks[0], status: 'done' })
  })

  it('renders memory context, pending proposals, and Personal State tasks', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    expect(wrapper.text()).toContain('Create the first dashboard-backed Personal State task.')
    expect(wrapper.text()).toContain('Add dashboard task')
    expect(wrapper.text()).toContain('Verify Studio Personal State')
  })

  it('approves a proposal and refreshes the overview', async () => {
    const wrapper = mount(PersonalOSView)
    await flushPromises()

    const approve = wrapper.find('[data-test="approve-proposal"]')
    await approve.trigger('click')
    await flushPromises()

    expect(approveProposal).toHaveBeenCalledWith('proposal-1', 'default')
    expect(fetchOverview).toHaveBeenCalledTimes(2)
  })
})
