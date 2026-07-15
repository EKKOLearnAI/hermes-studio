// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import journeyFixture from '../fixtures/hermes-journey-redacted.json'

const fetchJourneyGraphMock = vi.hoisted(() => vi.fn())
const fetchSkillsMock = vi.hoisted(() => vi.fn())
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

vi.mock('@/composables/useTheme', async () => {
  const { ref } = await import('vue')
  return {
    useTheme: () => ({
      isDark: ref(false),
    }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
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

type ResizeObserverInstance = {
  observe: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

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

function createCanvasContext() {
  return {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    lineTo: vi.fn(),
  } as unknown as CanvasRenderingContext2D
}

async function settle() {
  await flushPromises()
  await nextTick()
}

function hudTexts(wrapper: VueWrapper<any>) {
  return wrapper.findAll('.galaxy-hud span').map(node => node.text())
}

function countWindowEventCalls(spy: { mock: { calls: any[][] } }, eventName: string) {
  return spy.mock.calls.filter(([name]) => name === eventName).length
}

function dispatchPointerEvent(
  element: Element,
  type: string,
  init: { pointerId: number; pointerType: string; clientX: number; clientY: number },
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX,
    clientY: init.clientY,
  })
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId },
    pointerType: { value: init.pointerType },
  })
  element.dispatchEvent(event)
}

const mountedWrappers: VueWrapper<any>[] = []

function mountPanel(): VueWrapper<any> {
  const wrapper: VueWrapper<any> = mount(JourneyView)
  mountedWrappers.push(wrapper)
  return wrapper
}

let resizeObserverInstances: ResizeObserverInstance[] = []
let rafCallbacks: FrameRequestCallback[] = []
let canvasContext: CanvasRenderingContext2D
let requestAnimationFrameMock: ReturnType<typeof vi.fn>
let cancelAnimationFrameMock: ReturnType<typeof vi.fn>

describe('JourneyView interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()

    resizeObserverInstances = []
    rafCallbacks = []
    requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    cancelAnimationFrameMock = vi.fn((id: number) => {
      rafCallbacks[id - 1] = () => undefined
    })

    fetchJourneyGraphMock.mockReset()
    fetchSkillsMock.mockReset()
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

    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()

      constructor() {
        resizeObserverInstances.push(this as unknown as ResizeObserverInstance)
      }
    })
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock)
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)

    canvasContext = createCanvasContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width: 640,
      height: 480,
      top: 0,
      left: 0,
      right: 640,
      bottom: 480,
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
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fetches once on mount and renders the redacted HUD', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))

    const wrapper = mountPanel()
    await settle()

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(1)
    expect(hudTexts(wrapper)).toEqual(['default', '2 journey.nodes', '1 journey.edges'])
  })

  it('keeps the current HUD visible during manual refresh', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const refresh = deferred<JourneyResponse>()
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockReturnValueOnce(refresh.promise)

    const wrapper = mountPanel()
    await settle()

    expect(countWindowEventCalls(addEventListenerSpy, 'resize')).toBe(1)
    expect(resizeObserverInstances).toHaveLength(1)
    expect(resizeObserverInstances[0].observe).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.n-button-stub').find(button => button.text() === 'journey.refresh')!.trigger('click')
    await nextTick()

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)
    expect(hudTexts(wrapper)).toEqual(['default', '2 journey.nodes', '1 journey.edges'])

    refresh.resolve(cloneJourney('default'))
    await settle()

    expect(countWindowEventCalls(addEventListenerSpy, 'resize')).toBe(1)
    expect(resizeObserverInstances).toHaveLength(1)
    expect(resizeObserverInstances[0].observe).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1)
  })

  it('clears old data immediately and refetches when the profile changes', async () => {
    const nextJourney = deferred<JourneyResponse>()
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockReturnValueOnce(nextJourney.promise)

    const wrapper = mountPanel()
    await settle()

    useProfilesStore().activeProfileName = 'work'
    await nextTick()

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)
    expect(hudTexts(wrapper)).toEqual(['-', '0 journey.nodes', '0 journey.edges'])

    nextJourney.resolve(cloneJourney('work'))
    await settle()

    expect(hudTexts(wrapper)).toEqual(['work', '2 journey.nodes', '1 journey.edges'])
  })

  it('ignores stale request completions after a profile switch', async () => {
    const initial = deferred<JourneyResponse>()
    const nextJourney = deferred<JourneyResponse>()
    fetchJourneyGraphMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(nextJourney.promise)

    const wrapper = mountPanel()
    await nextTick()

    useProfilesStore().activeProfileName = 'work'
    await nextTick()

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)

    nextJourney.resolve(cloneJourney('work'))
    await settle()
    expect(hudTexts(wrapper)[0]).toBe('work')

    initial.resolve(cloneJourney('default'))
    await settle()
    expect(hudTexts(wrapper)[0]).toBe('work')
  })

  it('bootstraps listeners, observer, and renderer from the replacement profile request while the initial request is still pending', async () => {
    const initial = deferred<JourneyResponse>()
    const replacement = deferred<JourneyResponse>()
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    fetchJourneyGraphMock
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(replacement.promise)

    const wrapper = mountPanel()
    await nextTick()

    useProfilesStore().activeProfileName = 'work'
    await nextTick()

    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)

    replacement.resolve(cloneJourney('work'))
    await settle()

    expect(hudTexts(wrapper)).toEqual(['work', '2 journey.nodes', '1 journey.edges'])
    expect(countWindowEventCalls(addEventListenerSpy, 'resize')).toBe(1)
    expect(resizeObserverInstances).toHaveLength(1)
    expect(resizeObserverInstances[0].observe).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrameMock).not.toHaveBeenCalled()

    initial.resolve(cloneJourney('default'))
    await settle()

    expect(hudTexts(wrapper)).toEqual(['work', '2 journey.nodes', '1 journey.edges'])
    expect(countWindowEventCalls(addEventListenerSpy, 'resize')).toBe(1)
    expect(resizeObserverInstances).toHaveLength(1)
    expect(resizeObserverInstances[0].observe).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrameMock).not.toHaveBeenCalled()
  })

  it('toggles playback from play to pause', async () => {
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))

    const wrapper = mountPanel()
    await settle()

    const playButton = wrapper.get('[aria-label="journey.play"]')
    await playButton.trigger('click')
    await nextTick()
    expect((wrapper.vm as any).playing).toBe(true)

    await playButton.trigger('click')
    await nextTick()
    expect((wrapper.vm as any).playing).toBe(false)
    expect(clearTimeoutSpy).toHaveBeenCalled()
  })

  it('resets drawer, selection, and playback immediately on profile change', async () => {
    const nextJourney = deferred<JourneyResponse>()
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockReturnValueOnce(nextJourney.promise)

    const wrapper = mountPanel()
    await settle()

    const vm = wrapper.vm as any
    await wrapper.get('[aria-label="journey.play"]').trigger('click')
    Object.assign(vm, {
      selectedId: cloneJourney().graph.nodes[0].id,
      detailDrawerOpen: true,
    })
    await nextTick()

    expect(vm.playing).toBe(true)
    expect(wrapper.find('.n-drawer-stub').exists()).toBe(true)

    useProfilesStore().activeProfileName = 'work'
    await nextTick()

    expect(vm.playing).toBe(false)
    expect(vm.selectedId).toBe('')
    expect(vm.detailDrawerOpen).toBe(false)
    expect(wrapper.find('.n-drawer-stub').exists()).toBe(false)

    nextJourney.resolve(cloneJourney('work'))
    await settle()
  })

  it('does not create listeners or renderer resources if unmounted before the initial request resolves', async () => {
    const initial = deferred<JourneyResponse>()
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    fetchJourneyGraphMock.mockReturnValueOnce(initial.promise)

    const wrapper = mountPanel()
    await nextTick()
    wrapper.unmount()

    initial.resolve(cloneJourney('default'))
    await settle()

    expect(addEventListenerSpy).not.toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeEventListenerSpy).not.toHaveBeenCalledWith('resize', expect.any(Function))
    expect(resizeObserverInstances).toHaveLength(0)
    expect(requestAnimationFrameMock).not.toHaveBeenCalled()
    expect(cancelAnimationFrameMock).not.toHaveBeenCalled()
  })

  it('cleans installed listeners, observer, raf, and timer on normal unmount', async () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener')
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener')
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))

    const wrapper = mountPanel()
    await settle()

    expect(addEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(addEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(resizeObserverInstances).toHaveLength(1)
    expect(resizeObserverInstances[0].observe).toHaveBeenCalledTimes(1)
    expect(requestAnimationFrameMock).toHaveBeenCalledTimes(1)

    await wrapper.get('[aria-label="journey.play"]').trigger('click')
    await nextTick()
    const clearCountBeforeUnmount = clearTimeoutSpy.mock.calls.length

    wrapper.unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    expect(resizeObserverInstances[0].disconnect).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(clearCountBeforeUnmount)
  })

  it('keeps the graph usable when optional skill metadata fails', async () => {
    fetchSkillsMock.mockRejectedValueOnce(new Error('metadata unavailable'))
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))

    const wrapper = mountPanel()
    await settle()

    expect(hudTexts(wrapper)).toEqual(['default', '2 journey.nodes', '1 journey.edges'])
    expect(fetchSkillsMock).not.toHaveBeenCalled()
    const vm = wrapper.vm as any
    const canvas = wrapper.get('.galaxy-canvas')
    const skill = vm.projectedVisibleNodes().find((node: any) => node.kind === 'skill')
    dispatchPointerEvent(canvas.element, 'pointermove', {
      pointerId: 17,
      pointerType: 'mouse',
      clientX: skill.sx,
      clientY: skill.sy,
    })
    vi.advanceTimersByTime(249)
    await nextTick()
    expect(fetchSkillsMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await settle()

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)
    expect(messageMock.error).not.toHaveBeenCalled()
    expect(vm.skillDescriptions.size).toBe(0)
  })

  it('ignores stale skill metadata after a profile switch', async () => {
    const firstSkills = deferred<any>()
    const secondSkills = deferred<any>()
    fetchSkillsMock
      .mockReturnValueOnce(firstSkills.promise)
      .mockReturnValueOnce(secondSkills.promise)
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockResolvedValueOnce(cloneJourney('work'))

    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const defaultSkill = vm.visibleSceneNodes.find((node: any) => node.kind === 'skill')
    expect(fetchSkillsMock).not.toHaveBeenCalled()
    vm.updateNodeHover({ ...defaultSkill, sx: 120, sy: 140, depth: 0, size: 8, visible: true }, { x: 120, y: 140 })
    vi.advanceTimersByTime(250)
    await nextTick()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)

    useProfilesStore().activeProfileName = 'work'
    await settle()
    const workSkill = vm.visibleSceneNodes.find((node: any) => node.kind === 'skill')
    vm.updateNodeHover({ ...workSkill, sx: 130, sy: 150, depth: 0, size: 8, visible: true }, { x: 130, y: 150 })
    vi.advanceTimersByTime(250)
    await nextTick()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(2)

    secondSkills.resolve({
      categories: [{ name: 'research', description: '', skills: [{ name: 'Redacted Skill', description: 'work profile description' }] }],
      archived: [],
    })
    await settle()
    expect(vm.skillDescription(workSkill)).toBe('work profile description')

    firstSkills.resolve({
      categories: [{ name: 'research', description: '', skills: [{ name: 'Redacted Skill', description: 'stale default description' }] }],
      archived: [],
    })
    await settle()
    expect(vm.skillDescription(workSkill)).toBe('work profile description')
  })

  it('does not load skill metadata when hover ends before the preview appears', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const canvas = wrapper.get('.galaxy-canvas')
    const skill = vm.projectedVisibleNodes().find((node: any) => node.kind === 'skill')

    dispatchPointerEvent(canvas.element, 'pointermove', {
      pointerId: 18,
      pointerType: 'mouse',
      clientX: skill.sx,
      clientY: skill.sy,
    })
    vi.advanceTimersByTime(249)
    dispatchPointerEvent(canvas.element, 'pointermove', {
      pointerId: 18,
      pointerType: 'mouse',
      clientX: -1000,
      clientY: -1000,
    })
    vi.advanceTimersByTime(1)
    await settle()

    expect(vm.hoverTipId).toBe('')
    expect(fetchSkillsMock).not.toHaveBeenCalled()
  })

  it('does not restart the 250ms preview delay while the pointer remains on one node', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const hit = { ...vm.visibleSceneNodes[0], sx: 120, sy: 140, depth: 0, size: 8, visible: true }

    vm.updateNodeHover(hit, { x: 120, y: 140 })
    vi.advanceTimersByTime(100)
    vm.updateNodeHover(hit, { x: 122, y: 141 })
    vi.advanceTimersByTime(149)
    expect(vm.hoverTipId).toBe('')
    vi.advanceTimersByTime(1)
    await nextTick()
    expect(vm.hoverTipId).toBe(hit.id)
  })

  it('preserves category selection after a canvas pan but clears it on a later blank click', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    await wrapper.findAll('[data-category="research"]')[1].trigger('click')
    const canvas = wrapper.get('.galaxy-canvas')
    Object.assign(canvas.element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    })
    const vm = wrapper.vm as any

    vm.handlePointerDown({ pointerId: 1, clientX: 100, clientY: 100 })
    vm.handlePointerMove({ pointerId: 1, clientX: 130, clientY: 100 })
    vm.handlePointerUp({ pointerId: 1, clientX: 130, clientY: 100 })
    vm.handleClick({ clientX: -1000, clientY: -1000 })
    await nextTick()
    expect(vm.selectedCategories).toEqual(['research'])

    vi.advanceTimersByTime(201)
    vm.handleClick({ clientX: -1000, clientY: -1000 })
    await nextTick()
    expect(vm.selectedCategories).toEqual([])
  })

  it('clears pending previews during pinch cancel and recovers cleanly for later pointer hover', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const canvas = wrapper.get('.galaxy-canvas')
    Object.assign(canvas.element, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
    })
    const vm = wrapper.vm as any
    const skill = vm.projectedVisibleNodes().find((node: any) => node.kind === 'skill')

    dispatchPointerEvent(canvas.element, 'pointermove', {
      pointerId: 20,
      pointerType: 'mouse',
      clientX: skill.sx,
      clientY: skill.sy,
    })
    vi.advanceTimersByTime(100)
    dispatchPointerEvent(canvas.element, 'pointerdown', { pointerId: 21, pointerType: 'touch', clientX: skill.sx, clientY: skill.sy })
    dispatchPointerEvent(canvas.element, 'pointerdown', { pointerId: 22, pointerType: 'touch', clientX: skill.sx + 30, clientY: skill.sy })
    dispatchPointerEvent(canvas.element, 'pointermove', { pointerId: 22, pointerType: 'touch', clientX: skill.sx + 60, clientY: skill.sy })
    vi.advanceTimersByTime(300)
    await nextTick()
    expect(vm.hoverTipId).toBe('')
    expect(fetchSkillsMock).not.toHaveBeenCalled()

    dispatchPointerEvent(canvas.element, 'pointercancel', { pointerId: 22, pointerType: 'touch', clientX: skill.sx + 60, clientY: skill.sy })
    const recoveredSkill = vm.projectedVisibleNodes().find((node: any) => node.id === skill.id)
    dispatchPointerEvent(canvas.element, 'pointermove', {
      pointerId: 23,
      pointerType: 'mouse',
      clientX: recoveredSkill.sx,
      clientY: recoveredSkill.sy,
    })
    vi.advanceTimersByTime(250)
    await settle()
    expect(vm.hoverTipId).toBe(recoveredSkill.id)
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)
  })

  it('supports keyboard node preview and exposes skill descriptions in the detail drawer', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const canvas = wrapper.get('.galaxy-canvas')

    expect(canvas.attributes('tabindex')).toBe('0')
    expect(canvas.attributes('aria-label')).toContain('journey.canvasInstructions')
    expect(fetchSkillsMock).not.toHaveBeenCalled()
    await canvas.trigger('keydown', { key: 'ArrowRight' })
    await settle()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.journey-node-tooltip__name').text()).toBe('Redacted Skill')

    await canvas.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(wrapper.get('.n-drawer-stub').text()).toContain('A reusable redacted skill description.')
  })

  it('uses a stable general key while localizing the label for uncategorized nodes', async () => {
    const response = cloneJourney()
    delete (response.graph.nodes[0] as { category?: string }).category
    fetchJourneyGraphMock.mockResolvedValue(response)

    const wrapper = mountPanel()
    await settle()
    const controls = wrapper.findAll('[data-category="general"]')

    expect(controls).toHaveLength(2)
    expect(controls[1].text()).toContain('journey.noCategory')
    await controls[1].trigger('click')
    expect(controls.every(control => control.attributes('aria-pressed') === 'true')).toBe(true)
    expect((wrapper.vm as any).selectedCategories).toEqual(['general'])
    expect((wrapper.vm as any).emphasizedCategorySet.has('general')).toBe(true)

    wrapper.unmount()
  })

  it('toggles multiple categories by default without a selection-mode switch', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('.selection-mode').exists()).toBe(false)
    expect(wrapper.findAll('[data-selection-mode]')).toHaveLength(0)

    const researchControls = wrapper.findAll('[data-category="research"]')
    const journalControls = wrapper.findAll('[data-category="journal"]')
    expect(researchControls).toHaveLength(2)
    expect(journalControls).toHaveLength(2)

    await researchControls[1].trigger('click')
    await journalControls[0].trigger('click')
    expect(researchControls.every(control => control.attributes('aria-pressed') === 'true')).toBe(true)
    expect(journalControls.every(control => control.attributes('aria-pressed') === 'true')).toBe(true)
    expect((wrapper.vm as any).selectedCategories).toEqual(['research', 'journal'])

    await researchControls[0].trigger('click')
    expect(researchControls.every(control => control.attributes('aria-pressed') === 'false')).toBe(true)
    expect(journalControls.every(control => control.attributes('aria-pressed') === 'true')).toBe(true)

    await wrapper.get('.galaxy-canvas').trigger('click', { clientX: -1000, clientY: -1000 })
    expect((wrapper.vm as any).selectedCategories).toEqual([])
    expect(journalControls.every(control => control.attributes('aria-pressed') === 'false')).toBe(true)
  })

  it('renders and hit-tests skill circles and memory diamonds through production helpers', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const skill = {
      ...vm.visibleSceneNodes.find((node: any) => node.kind === 'skill'),
      sx: 100,
      sy: 100,
      depth: 0,
      size: 10,
      visible: true,
    }
    const memory = {
      ...vm.visibleSceneNodes.find((node: any) => node.kind === 'memory'),
      sx: 100,
      sy: 100,
      depth: 0,
      size: 10,
      visible: true,
    }
    const canvasSpies = canvasContext as unknown as {
      arc: ReturnType<typeof vi.fn>
      moveTo: ReturnType<typeof vi.fn>
      lineTo: ReturnType<typeof vi.fn>
    }

    canvasSpies.arc.mockClear()
    canvasSpies.moveTo.mockClear()
    canvasSpies.lineTo.mockClear()
    vm.traceNodeShape(memory)
    expect(canvasSpies.moveTo).toHaveBeenCalledWith(100, 87)
    expect(canvasSpies.lineTo.mock.calls).toEqual([
      [111.2, 100],
      [100, 113],
      [88.8, 100],
      [100, 87],
    ])
    expect(canvasSpies.arc).not.toHaveBeenCalled()

    canvasSpies.arc.mockClear()
    canvasSpies.lineTo.mockClear()
    vm.traceNodeShape(skill)
    expect(canvasSpies.arc).toHaveBeenCalledWith(100, 100, 10, 0, Math.PI * 2)
    expect(canvasSpies.lineTo).not.toHaveBeenCalled()

    canvasSpies.arc.mockClear()
    canvasSpies.lineTo.mockClear()
    vm.drawNode(memory, new Set([memory.id]), new Set(), new Set(), new Set(), 1000)
    expect(canvasSpies.lineTo.mock.calls.length).toBeGreaterThanOrEqual(16)
    expect(canvasSpies.arc).not.toHaveBeenCalled()

    const cornerOffset = (memory.size + 8) * 0.7
    expect(vm.pointHitsNode(memory, 100, 100)).toBe(true)
    expect(vm.pointHitsNode(memory, 100 + cornerOffset, 100 + cornerOffset)).toBe(false)
    expect(vm.pointHitsNode(skill, 100 + cornerOffset, 100 + cornerOffset)).toBe(true)
    expect(wrapper.get('.node-kind-marker--skill').classes()).toContain('node-kind-marker--circle')
    expect(wrapper.get('.node-kind-marker--memory').classes()).toContain('node-kind-marker--diamond')
  })

  it('stops active playback on Escape from toolbar, canvas, category, and drawer focus', async () => {
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const playButton = wrapper.findAll('.n-button-stub')[0]
    const playElement = playButton.element as HTMLButtonElement
    const canvasElement = wrapper.get('.galaxy-canvas').element as HTMLCanvasElement
    const categoryElement = wrapper.findAll('[data-category="research"]')[1].element as HTMLButtonElement
    document.body.appendChild(wrapper.element)

    const expectEscapeStopsPlayback = async (target: HTMLElement) => {
      target.focus()
      expect(document.activeElement).toBe(target)
      expect(vm.playing).toBe(true)
      expect(vm.selectedId).not.toBe('')
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      target.dispatchEvent(escapeEvent)
      await nextTick()
      expect(escapeEvent.defaultPrevented).toBe(true)
      expect(vm.playing).toBe(false)
      expect(vm.selectedId).toBe('')
    }

    await playButton.trigger('click')
    await expectEscapeStopsPlayback(playElement)

    vm.togglePlayback()
    await nextTick()
    await expectEscapeStopsPlayback(canvasElement)

    vm.togglePlayback()
    await nextTick()
    await expectEscapeStopsPlayback(categoryElement)

    const skill = vm.visibleSceneNodes.find((node: any) => node.kind === 'skill')
    vm.openNodeDetails(skill.id)
    await nextTick()
    const drawerElement = wrapper.get('.n-drawer-stub').element as HTMLElement
    drawerElement.tabIndex = 0
    vm.togglePlayback()
    await nextTick()
    await expectEscapeStopsPlayback(drawerElement)

    vi.advanceTimersByTime(500)
    await nextTick()
    expect(vm.playing).toBe(false)
    expect(vm.selectedId).toBe('')
  })

  it('rehydrates an open skill description after refreshing the graph', async () => {
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const canvas = wrapper.get('.galaxy-canvas')

    await canvas.trigger('keydown', { key: 'ArrowRight' })
    await settle()
    await canvas.trigger('keydown', { key: 'Enter' })
    await nextTick()
    expect(wrapper.get('.n-drawer-stub').text()).toContain('A reusable redacted skill description.')
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await settle()
    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)
    expect(fetchSkillsMock).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.n-drawer-stub').text()).toContain('A reusable redacted skill description.')
  })

  it('rehydrates a visible keyboard preview after refreshing the graph', async () => {
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const canvas = wrapper.get('.galaxy-canvas')

    await canvas.trigger('keydown', { key: 'ArrowRight' })
    await settle()
    expect(wrapper.get('.journey-node-tooltip__description').text()).toContain('A reusable redacted skill description.')
    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)

    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await settle()
    expect(fetchSkillsMock).toHaveBeenCalledTimes(2)
    expect(wrapper.get('.journey-node-tooltip__description').text()).toContain('A reusable redacted skill description.')
  })

  it('does not load skill metadata when refresh follows a playback-only selection', async () => {
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const playButton = wrapper.findAll('.n-button-stub')[0]

    await playButton.trigger('click')
    if (vm.nodeById.get(vm.selectedId)?.kind !== 'skill') {
      vi.advanceTimersByTime(150)
      await nextTick()
    }
    expect(vm.nodeById.get(vm.selectedId)?.kind).toBe('skill')
    await playButton.trigger('click')
    expect(vm.playing).toBe(false)
    expect(vm.detailDrawerOpen).toBe(false)
    expect(vm.hoverTipId).toBe('')

    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await settle()
    expect(fetchJourneyGraphMock).toHaveBeenCalledTimes(2)
    expect(fetchSkillsMock).not.toHaveBeenCalled()
  })

  it('keeps a valid category selected across refresh and clears it on profile reset', async () => {
    fetchJourneyGraphMock
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockResolvedValueOnce(cloneJourney('default'))
      .mockResolvedValueOnce(cloneJourney('work'))

    const wrapper = mountPanel()
    await settle()
    await wrapper.findAll('[data-category="research"]')[1].trigger('click')

    await wrapper.findAll('.n-button-stub').at(-1)!.trigger('click')
    await settle()
    expect((wrapper.vm as any).selectedCategories).toEqual(['research'])

    useProfilesStore().activeProfileName = 'work'
    await settle()
    expect((wrapper.vm as any).selectedCategories).toEqual([])
  })

  it('renders the recycled bounded hover preview for skill and memory nodes', async () => {
    const hiddenTail = 'TAIL-MARKER-XYZ'
    fetchSkillsMock.mockResolvedValueOnce({
      categories: [{
        name: 'research',
        description: '',
        skills: [{
          name: 'Redacted Skill',
          description: `  ${'🙂'.repeat(150)}  ${hiddenTail}`,
          enabled: true,
        }],
      }, {
        name: 'journal',
        description: '',
        skills: [{
          name: 'Redacted Skill',
          description: 'WRONG duplicate-category description',
          enabled: true,
        }],
      }],
      archived: [],
    })
    fetchJourneyGraphMock.mockResolvedValueOnce(cloneJourney('default'))
    const wrapper = mountPanel()
    await settle()
    const vm = wrapper.vm as any
    const skill = vm.visibleSceneNodes.find((node: any) => node.kind === 'skill')

    expect(fetchSkillsMock).not.toHaveBeenCalled()
    vm.updateNodeHover({ ...skill, sx: 320, sy: 240, depth: 0, size: 8, visible: true }, { x: 320, y: 240 })
    vi.advanceTimersByTime(250)
    await settle()

    expect(fetchSkillsMock).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.journey-node-tooltip__name').text()).toBe('Redacted Skill')
    const preview = wrapper.get('.journey-node-tooltip__description').text()
    expect(Array.from(preview)).toHaveLength(140)
    expect(preview.endsWith('…')).toBe(true)
    expect(preview).not.toContain(hiddenTail)
    expect(preview).not.toContain('WRONG')

    const memory = vm.visibleSceneNodes.find((node: any) => node.kind === 'memory')
    vm.updateNodeHover({ ...memory, sx: 340, sy: 250, depth: 0, size: 8, visible: true }, { x: 340, y: 250 })
    vi.advanceTimersByTime(250)
    await nextTick()
    expect(wrapper.get('.journey-node-tooltip__description').text()).toBe('Redacted memory body for fixture coverage.')
  })
})
