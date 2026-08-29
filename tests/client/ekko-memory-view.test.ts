// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { EkkoMemoryNode } from '@/api/ekko/memory'

const fetchMemoryMock = vi.hoisted(() => vi.fn())
const fetchReviewStatusMock = vi.hoisted(() => vi.fn())
const fetchReviewJobsMock = vi.hoisted(() => vi.fn())
const reviewJobNowMock = vi.hoisted(() => vi.fn())
const fitViewMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/api/ekko/memory', () => ({
  fetchEkkoMemory: fetchMemoryMock,
  fetchEkkoMemoryReviewStatus: fetchReviewStatusMock,
  fetchEkkoMemoryReviewJobs: fetchReviewJobsMock,
  reviewEkkoMemoryJobNow: reviewJobNowMock,
  updateEkkoMemory: vi.fn(),
  deleteEkkoMemory: vi.fn(),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('@vue-flow/core', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  useVueFlow: () => ({ fitView: fitViewMock }),
  Handle: defineComponent({ template: '<i class="handle-stub" />' }),
  VueFlow: defineComponent({
    props: { nodes: { type: Array, default: () => [] }, edges: { type: Array, default: () => [] } },
    emits: ['pane-click'],
    template: `<div class="vue-flow-stub" :data-node-count="nodes.length" :data-edge-count="edges.length">
      <template v-for="node in nodes" :key="node.id"><slot name="node-memory-card" :data="node.data" /></template>
      <slot />
    </div>`,
  }),
}))
vi.mock('@vue-flow/background', () => ({ Background: defineComponent({ template: '<div />' }) }))
vi.mock('@vue-flow/controls', () => ({ Controls: defineComponent({ template: '<div />' }) }))
vi.mock('@vue-flow/minimap', () => ({ MiniMap: defineComponent({ template: '<div />' }) }))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    props: { disabled: Boolean, loading: Boolean }, emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
  }),
  NDrawer: defineComponent({
    props: { show: Boolean }, emits: ['update:show'],
    template: '<aside v-if="show" class="n-drawer-stub"><slot /></aside>',
  }),
  NDrawerContent: defineComponent({ template: '<div><header><slot name="header" /></header><slot /></div>' }),
  NEmpty: defineComponent({ props: { description: String }, template: '<div class="n-empty-stub">{{ description }}</div>' }),
  NInput: defineComponent({
    props: { value: String }, emits: ['update:value'],
    template: '<input class="n-input-stub" :value="value" @input="$emit(\'update:value\', $event.target.value)" />',
  }),
  NModal: defineComponent({ props: { show: Boolean }, template: '<div v-if="show"><slot /></div>' }),
  NPopconfirm: defineComponent({ template: '<div><slot name="trigger" /><slot /></div>' }),
  NSelect: defineComponent({
    props: { value: String, options: Array }, emits: ['update:value'],
    template: '<select class="n-select-stub" :value="value" @change="$emit(\'update:value\', $event.target.value)"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>',
  }),
  NSpin: defineComponent({ props: { show: Boolean }, template: '<div class="n-spin-stub"><slot /></div>' }),
  NTag: defineComponent({ template: '<span class="n-tag-stub"><slot /></span>' }),
  useMessage: () => messageMock,
}))

import MemoryView from '@/views/ekko/MemoryView.vue'

function memory(id: string, overrides: Partial<EkkoMemoryNode> = {}): EkkoMemoryNode {
  return {
    id, profileId: 'default', scope: { type: 'profile' }, domain: 'user',
    categoryPath: ['preference'], type: 'preference', key: `key:${id}`, revision: 1,
    title: `Memory ${id}`, content: `Content ${id}`, status: 'active', confidence: 0.9,
    importance: 0.8, tags: [], entities: [], sourceMessageIds: ['source-1'],
    createdAt: `2026-01-0${id === 'a' ? '1' : '2'}T00:00:00.000Z`,
    updatedAt: `2026-01-0${id === 'a' ? '1' : '2'}T00:00:00.000Z`,
    ...overrides,
  }
}

let wrapper: VueWrapper<any> | undefined

beforeEach(() => {
  vi.clearAllMocks()
  fetchMemoryMock.mockResolvedValue([memory('a'), memory('b')])
  fetchReviewStatusMock.mockResolvedValue({
    reviewing: false, activeJobs: 0, pending: 0, running: 0, retry: 0,
    waitingForModel: 0, needsConfirmation: 0,
  })
  fetchReviewJobsMock.mockResolvedValue([])
  reviewJobNowMock.mockResolvedValue({})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    width: 960, height: 640, top: 0, left: 0, right: 960, bottom: 640, x: 0, y: 0,
    toJSON() { return {} },
  } as DOMRect))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.restoreAllMocks()
})

describe('Ekko MemoryView', () => {
  it('opens as a fitted relationship graph and preserves the list view', async () => {
    wrapper = mount(MemoryView)
    await flushPromises()
    await nextTick()

    expect(fetchMemoryMock).toHaveBeenCalledWith({ query: '', status: 'active' })
    expect(wrapper.find('.vue-flow-stub').attributes('data-node-count')).toBe('2')
    expect(wrapper.find('.vue-flow-stub').attributes('data-edge-count')).toBe('1')
    expect(wrapper.findAll('.memory-node')).toHaveLength(2)
    expect(fitViewMock).toHaveBeenCalledWith(expect.objectContaining({ padding: 0.18, maxZoom: 1 }))

    await wrapper.find('.memory-node').trigger('click')
    expect(wrapper.find('.n-drawer-stub').exists()).toBe(true)
    expect(wrapper.find('.related-memory-link').exists()).toBe(true)

    const listButton = wrapper.findAll('.n-button-stub')
      .find(button => button.text().includes('ekkoConfig.listView'))!
    await listButton.trigger('click')
    expect(wrapper.findAll('.memory-card')).toHaveLength(2)
  })

  it('shows the live reviewing status reported by the memory queue', async () => {
    fetchReviewStatusMock.mockResolvedValueOnce({
      reviewing: true, activeJobs: 1, pending: 0, running: 1, retry: 0,
      waitingForModel: 0, needsConfirmation: 0,
    })
    wrapper = mount(MemoryView)
    await flushPromises()

    expect(fetchReviewStatusMock).toHaveBeenCalled()
    expect(wrapper.find('.memory-reviewing').text()).toBe('ekkoConfig.memoryReviewing')
    expect(wrapper.find('option[value="reviewing"]').exists()).toBe(true)

    fetchReviewJobsMock.mockResolvedValueOnce([{
      id: 'review-1', sessionId: 'session-1', throughMessageId: 'message-1',
      trigger: 'review', status: 'running', attempt: 1, userConfirmed: false,
      evidencePreview: 'hermes-studio 是我的开源项目',
      createdAt: '2026-08-29T00:00:00.000Z', updatedAt: '2026-08-29T00:00:01.000Z',
    }])
    await wrapper.find('.memory-review-filter').trigger('click')
    await flushPromises()

    expect(fetchReviewJobsMock).toHaveBeenCalled()
    expect(wrapper.find('.memory-review-evidence').text()).toBe('hermes-studio 是我的开源项目')
  })
})
