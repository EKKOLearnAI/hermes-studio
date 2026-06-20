// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

const mockFetchPendingWrites = vi.hoisted(() => vi.fn())
const mockFetchPendingWriteReview = vi.hoisted(() => vi.fn())
const mockApprovePendingWrite = vi.hoisted(() => vi.fn())
const mockRejectPendingWrite = vi.hoisted(() => vi.fn())

vi.mock('@/api/hermes/write-gate', () => ({
  fetchPendingWrites: mockFetchPendingWrites,
  fetchPendingWriteReview: mockFetchPendingWriteReview,
  approvePendingWrite: mockApprovePendingWrite,
  rejectPendingWrite: mockRejectPendingWrite,
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<any>('naive-ui')
  return {
    ...actual,
    useMessage: () => ({
      success: vi.fn(),
      error: vi.fn(),
    }),
  }
})

import PendingWriteApprovals from '@/components/hermes/skills/PendingWriteApprovals.vue'

function mountComponent() {
  return mount(PendingWriteApprovals, {
    global: {
      stubs: {
        NTag: { template: '<span><slot /></span>' },
        NButton: {
          props: ['loading'],
          template: '<button class="n-button" @click="$emit(\'click\')"><slot /></button>',
        },
        MarkdownRenderer: {
          props: ['content'],
          template: '<article class="markdown-renderer-stub">{{ content }}</article>',
        },
      },
    },
  })
}

describe('PendingWriteApprovals', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchPendingWrites.mockResolvedValue({ records: [], counts: { memory: 0, skills: 0 }, supported: true })
    mockFetchPendingWriteReview.mockResolvedValue({
      subsystem: 'skills',
      targetLabel: 'SKILL.md',
      language: 'markdown',
      current: 'old',
      proposed: 'new',
      diff: '-old\n+new',
      notes: [],
    })
    mockApprovePendingWrite.mockResolvedValue({ output: 'approved' })
    mockRejectPendingWrite.mockResolvedValue({ output: 'rejected' })
  })

  it('shows an unsupported state for older Hermes Agent versions', async () => {
    mockFetchPendingWrites.mockResolvedValue({ records: [], counts: { memory: 0, skills: 0 }, supported: false })

    const wrapper = mountComponent()
    await flushPromises()

    expect(wrapper.text()).toContain('skills.writeApprovalUnsupported')
    expect(wrapper.emitted('count-change')?.[0]).toEqual([0])
  })

  it('approves and rejects pending write gate records', async () => {
    mockFetchPendingWrites.mockResolvedValue({
      records: [
        {
          id: 'mem123',
          subsystem: 'memory',
          action: 'add',
          summary: 'remember concise answers',
          origin: 'foreground',
          created_at: 1765440000,
          payload: {},
        },
        {
          id: 'skill123',
          subsystem: 'skills',
          action: 'patch',
          summary: 'patch demo skill',
          origin: 'background_review',
          created_at: 1765440060,
          payload: {},
        },
      ],
      counts: { memory: 1, skills: 1 },
      supported: true,
    })

    const wrapper = mountComponent()
    await flushPromises()

    expect(wrapper.text()).toContain('remember concise answers')
    expect(wrapper.text()).toContain('patch demo skill')

    const approveButtons = () => wrapper.findAll('.n-button').filter(button => button.text() === 'skills.writeApprovalApprove')
    const rejectButtons = () => wrapper.findAll('.n-button').filter(button => button.text() === 'skills.writeApprovalReject')

    await approveButtons()[0].trigger('click')
    await flushPromises()
    await rejectButtons()[1].trigger('click')
    await flushPromises()

    expect(mockApprovePendingWrite).toHaveBeenCalledWith('memory', 'mem123')
    expect(mockRejectPendingWrite).toHaveBeenCalledWith('skills', 'skill123')
  })

  it('renders pending write review content as markdown', async () => {
    mockFetchPendingWrites.mockResolvedValue({
      records: [
        {
          id: 'skill123',
          subsystem: 'skills',
          action: 'patch',
          summary: 'patch demo skill',
          origin: 'foreground',
          created_at: 1765440060,
          payload: {},
        },
      ],
      counts: { memory: 0, skills: 1 },
      supported: true,
    })
    mockFetchPendingWriteReview.mockResolvedValue({
      subsystem: 'skills',
      targetLabel: 'SKILL.md',
      language: 'markdown',
      current: 'old',
      proposed: 'new',
      diff: '-old\n+new',
      requestedOldString: 'missing',
      notes: [{ type: 'patchOldStringMissing', targetLabel: 'SKILL.md' }],
    })

    const wrapper = mountComponent()
    await flushPromises()

    const diffButton = wrapper.findAll('.n-button').find(button => button.text() === 'skills.writeApprovalViewDiff')
    await diffButton?.trigger('click')
    await flushPromises()

    expect(mockFetchPendingWriteReview).toHaveBeenCalledWith('skills', 'skill123')
    expect(wrapper.find('.markdown-renderer-stub').text()).toContain('skills.writeApprovalCurrentFile')
    expect(wrapper.find('.markdown-renderer-stub').text()).toContain('skills.writeApprovalPatchOldStringMissing')
  })
})
