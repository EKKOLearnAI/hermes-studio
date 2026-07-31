// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import journeyFixture from '../fixtures/hermes-journey-redacted.json'

const fetchJourneyGraphMock = vi.hoisted(() => vi.fn())
const fetchSkillsMock = vi.hoisted(() => vi.fn())
const fitViewMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const messageMock = vi.hoisted(() => ({
  error: vi.fn(),
}))

vi.mock('@/api/hermes/journey', () => ({
  fetchJourneyGraph: fetchJourneyGraphMock,
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: fetchSkillsMock,
}))

vi.mock('@/stores/hermes/profiles', async () => {
  const { reactive } = await import('vue')
  const store = reactive({
    activeProfileName: 'default' as string | null,
  })
  return {
    useProfilesStore: () => store,
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('@vue-flow/core', () => ({
  MarkerType: {
    ArrowClosed: 'arrowclosed',
  },
  Position: {
    Left: 'left',
    Right: 'right',
  },
  useVueFlow: () => ({
    fitView: fitViewMock,
  }),
  Handle: defineComponent({
    template: '<i class="handle-stub" />',
  }),
  VueFlow: defineComponent({
    props: {
      nodes: {
        type: Array,
        default: () => [],
      },
      edges: {
        type: Array,
        default: () => [],
      },
    },
    emits: ['pane-click'],
    template: `
      <div
        class="vue-flow-stub"
        :data-node-count="nodes.length"
        :data-edge-count="edges.length"
        @click.self="$emit('pane-click')"
      >
        <template v-for="node in nodes" :key="node.id">
          <slot name="node-journey" :data="node.data" />
        </template>
        <slot />
      </div>
    `,
  }),
}))

vi.mock('@vue-flow/background', () => ({
  Background: defineComponent({
    template: '<div class="background-stub" />',
  }),
}))

vi.mock('@vue-flow/controls', () => ({
  Controls: defineComponent({
    template: '<div class="controls-stub" />',
  }),
}))

vi.mock('@vue-flow/minimap', () => ({
  MiniMap: defineComponent({
    template: '<div class="minimap-stub" />',
  }),
}))

vi.mock('naive-ui', () => ({
  NButton: defineComponent({
    props: {
      disabled: Boolean,
      loading: Boolean,
    },
    emits: ['click'],
    template: '<button class="n-button-stub" :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
  }),
  NDrawer: defineComponent({
    props: {
      show: Boolean,
      width: [Number, String],
      placement: String,
    },
    emits: ['update:show'],
    template: '<div v-if="show" class="n-drawer-stub"><slot /></div>',
  }),
  NDrawerContent: defineComponent({
    props: {
      closable: Boolean,
      nativeScrollbar: Boolean,
    },
    template: '<div class="n-drawer-content-stub"><div class="n-drawer-header"><slot name="header" /></div><slot /></div>',
  }),
  NSpin: defineComponent({
    props: {
      show: Boolean,
    },
    template: '<div class="n-spin-stub" :data-show="String(show)"><slot /></div>',
  }),
  NTag: defineComponent({
    template: '<span class="n-tag-stub"><slot /></span>',
  }),
  useMessage: () => messageMock,
}))

import JourneyView from '@/views/hermes/JourneyView.vue'
import { useProfilesStore } from '@/stores/hermes/profiles'

type JourneyResponse = typeof journeyFixture

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => {
    resolve = res
  })
  return { promise, resolve }
}

function cloneJourney(profile = 'default'): JourneyResponse {
  const clone = JSON.parse(JSON.stringify(journeyFixture)) as JourneyResponse
  clone.profile = profile
  return clone
}

async function settle() {
  await flushPromises()
  await nextTick()
}

function hudTexts(wrapper: VueWrapper<any>) {
  return wrapper.findAll('.journey-hud span').map(node => node.text())
}

function nodeCard(wrapper: VueWrapper<any>, label: string) {
  return wrapper.findAll('.journey-node').find(card => card.text().includes(label))!
}

const mountedWrappers: VueWrapper<any>[] = []

function mountPanel(): VueWrapper<any> {
  const wrapper: VueWrapper<any> = mount(JourneyView)
  mountedWrappers.push(wrapper)
  return wrapper
}

describe('JourneyView interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    fetchJourneyGraphMock.mockReset()
    fetchSkillsMock.mockReset()
    fitViewMock.mockReset()
    fitViewMock.mockResolvedValue(undefined)
    fetchSkillsMock.mockResolvedValue({
      categories: [{
        name: 'research',
        description: '',
        skills: [{
          name: 'Redacted Skill',
          description: '  A reusable\n\nredacted skill description.  ',
          enabled: true,
        }],
      }],
      archived: [],
    })
    messageMock.error.mockReset()
    useProfilesStore().activeProfileName = 'default'

    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width: 960,
      height: 640,
      top: 0,
      left: 0,
      right: 960,
      bottom: 640,
      x: 0,
      y: 0,
      toJSON() {
        return {}
      },
    } as DOMRect))
  })

  afterEach(() => {
    while (mountedWrappers.length) {
      mountedWrappers.pop()?.unmount()
    }
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders a fitted memory-to-skill relationship map', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())

    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const memory = vm.flowNodes.find((node: any) => node.data.column === 'memory')
    const skill = vm.flowNodes.find((node: any) => node.data.column === 'skill')

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(1)
    expect(hudTexts(wrapper)).toEqual(['default', '2 journey.nodes', '1 journey.edges'])
    expect(wrapper.findAll('.journey-node')).toHaveLength(2)
    expect(memory.position.x).toBeLessThan(skill.position.x)
    expect(memory.style.pointerEvents).toBe('all')
    expect(vm.flowEdges).toHaveLength(1)
    expect(vm.flowEdges[0].markerEnd.type).toBe('arrowclosed')
    expect(fitViewMock).toHaveBeenCalledWith(expect.objectContaining({
      padding: 0.16,
      maxZoom: 1,
    }))
  })

  it('keeps the current graph visible during manual refresh without resetting the viewport', async () => {
    const refresh = deferred<JourneyResponse>()
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney())
      .mockReturnValueOnce(refresh.promise)

    const wrapper = mountPanel()
    await settle()
    fitViewMock.mockClear()

    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await nextTick()

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)
    expect(hudTexts(wrapper)).toEqual(['default', '2 journey.nodes', '1 journey.edges'])

    refresh.resolve(cloneJourney())
    await settle()
    expect(fitViewMock).not.toHaveBeenCalled()
  })

  it('clears old data on profile change and ignores stale request completions', async () => {
    const initial = deferred<JourneyResponse>()
    const replacement = deferred<JourneyResponse>()
    fetchJourneyGraphMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(replacement.promise)

    const wrapper = mountPanel()
    await nextTick()

    useProfilesStore().activeProfileName = 'work'
    await nextTick()
    expect(hudTexts(wrapper)).toEqual(['-', '0 journey.nodes', '0 journey.edges'])

    replacement.resolve(cloneJourney('work'))
    await settle()
    expect(hudTexts(wrapper)[0]).toBe('work')

    initial.resolve(cloneJourney('default'))
    await settle()
    expect(hudTexts(wrapper)[0]).toBe('work')
  })

  it('toggles chronological playback and progressively reveals the graph', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const playButton = wrapper.get('[aria-label="journey.play"]')

    await playButton.trigger('click')
    await nextTick()
    expect(vm.playing).toBe(true)
    expect(vm.visibleNodes).toHaveLength(1)
    expect(vm.flowEdges).toHaveLength(0)

    vi.advanceTimersByTime(150)
    await nextTick()
    expect(vm.visibleNodes).toHaveLength(2)
    expect(vm.flowEdges).toHaveLength(1)

    await playButton.trigger('click')
    expect(vm.playing).toBe(false)
  })

  it('highlights a selected node, its direct neighbor, and only their edge', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any

    await nodeCard(wrapper, 'Redacted Memory').trigger('click')
    await nextTick()

    const memory = vm.flowNodes.find((node: any) => node.id === 'memory:0')
    const skill = vm.flowNodes.find((node: any) => node.id === 'skill:redacted-0')
    expect(memory.data.active).toBe(true)
    expect(skill.data.related).toBe(true)
    expect(vm.flowEdges[0].style.opacity).toBe(0.95)
    expect(wrapper.find('.n-drawer-stub').exists()).toBe(true)
    expect(wrapper.get('.n-drawer-stub').text()).toContain('Redacted memory body for fixture coverage.')
  })

  it('opens skill details and lazily resolves the skill description', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()

    expect(fetchSkillsMock).not.toHaveBeenCalled()
    await nodeCard(wrapper, 'Redacted Skill').trigger('click')
    await settle()

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.n-drawer-stub').text()).toContain('A reusable redacted skill description.')
  })

  it('loads hover metadata after 250ms and cancels it when the pointer leaves', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()
    const skillCard = nodeCard(wrapper, 'Redacted Skill')

    await skillCard.trigger('mouseenter', { clientX: 400, clientY: 240 })
    vi.advanceTimersByTime(249)
    await nextTick()
    expect(fetchSkillsMock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await settle()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.journey-node-tooltip__name').text()).toBe('Redacted Skill')
    expect(wrapper.get('.journey-node-tooltip__description').text()).toContain('A reusable redacted skill description.')

    await skillCard.trigger('mouseleave')
    expect(wrapper.find('.journey-node-tooltip').exists()).toBe(false)

    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const secondWrapper = mountPanel()
    await settle()
    const secondSkill = nodeCard(secondWrapper, 'Redacted Skill')
    await secondSkill.trigger('mouseenter', { clientX: 400, clientY: 240 })
    vi.advanceTimersByTime(100)
    await secondSkill.trigger('mouseleave')
    vi.advanceTimersByTime(200)
    await settle()
    expect(secondWrapper.find('.journey-node-tooltip').exists()).toBe(false)
  })

  it('supports multi-category emphasis and clears it from the blank pane', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any

    const researchControls = wrapper.findAll('[data-category="research"]')
    const journalControls = wrapper.findAll('[data-category="journal"]')
    expect(researchControls).toHaveLength(2)
    expect(journalControls).toHaveLength(2)

    await researchControls[1].trigger('click')
    await journalControls[0].trigger('click')
    expect(vm.selectedCategories).toEqual(['research', 'journal'])
    expect(researchControls.every(control => control.attributes('aria-pressed') === 'true')).toBe(true)
    expect(journalControls.every(control => control.attributes('aria-pressed') === 'true')).toBe(true)

    await wrapper.get('.vue-flow-stub').trigger('click')
    expect(vm.selectedCategories).toEqual([])
  })

  it('uses a stable general category key while localizing its label', async () => {
    const response = cloneJourney()
    delete (response.graph.nodes[0] as { category?: string }).category
    fetchJourneyGraphMock.mockResolvedValueOnce(response)

    const wrapper = mountPanel()
    await settle()
    const controls = wrapper.findAll('[data-category="general"]')

    expect(controls).toHaveLength(2)
    expect(controls[1].text()).toContain('journey.noCategory')
    await controls[1].trigger('click')
    expect((wrapper.vm as any).selectedCategories).toEqual(['general'])
  })

  it('supports keyboard preview and opening details from the graph surface', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()
    const graph = wrapper.get('.journey-graph-wrap')

    expect(graph.attributes('tabindex')).toBe('0')
    expect(graph.attributes('aria-label')).toContain('journey.canvasInstructions')
    await graph.trigger('keydown', { key: 'ArrowRight' })
    await settle()

    expect(wrapper.get('.journey-node-tooltip__name').text()).toBe('Redacted Skill')
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)

    await graph.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(wrapper.get('.n-drawer-stub').text()).toContain('A reusable redacted skill description.')
  })

  it('resets playback, drawer, categories, and selection when the profile changes', async () => {
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney())
      .mockResolvedValueOnce(cloneJourney('work'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any

    await nodeCard(wrapper, 'Redacted Skill').trigger('click')
    await wrapper.findAll('[data-category="research"]')[1].trigger('click')
    await wrapper.get('[aria-label="journey.play"]').trigger('click')
    await nextTick()

    useProfilesStore().activeProfileName = 'work'
    await settle()

    expect(vm.playing).toBe(false)
    expect(vm.selectedId).toBe('')
    expect(vm.selectedCategories).toEqual([])
    expect(vm.detailDrawerOpen).toBe(false)
    expect(hudTexts(wrapper)[0]).toBe('work')
  })

  it('rehydrates an open skill description after refresh', async () => {
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney())
      .mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()

    await nodeCard(wrapper, 'Redacted Skill').trigger('click')
    await settle()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await settle()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.n-drawer-stub').text()).toContain('A reusable redacted skill description.')
  })

  it('keeps the graph usable when optional skill metadata fails', async () => {
    fetchSkillsMock.mockRejectedValueOnce(new Error('metadata unavailable'))
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()

    await nodeCard(wrapper, 'Redacted Skill').trigger('click')
    await settle()

    expect(wrapper.find('.n-drawer-stub').exists()).toBe(true)
    expect(messageMock.error).not.toHaveBeenCalled()
  })

  it('cleans up window listeners and pending timers on unmount', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney())
    const wrapper = mountPanel()
    await settle()

    await wrapper.get('[aria-label="journey.play"]').trigger('click')
    await nodeCard(wrapper, 'Redacted Skill').trigger('mouseenter', { clientX: 400, clientY: 240 })
    wrapper.unmount()

    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })
})
