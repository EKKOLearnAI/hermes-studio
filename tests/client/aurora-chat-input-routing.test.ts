// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('naive-ui', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')

  const NButton = vue.defineComponent({
    name: 'NButton',
    setup(_, { attrs, slots }) {
      return () => vue.h('button', { ...attrs, type: 'button' }, [
        slots.icon?.(),
        slots.default?.(),
      ])
    },
  })

  const NTooltip = vue.defineComponent({
    name: 'NTooltip',
    setup(_, { slots }) {
      return () => vue.h('span', [
        slots.trigger?.(),
        slots.default?.(),
      ])
    },
  })

  const NSwitch = vue.defineComponent({
    name: 'NSwitch',
    inheritAttrs: false,
    props: ['value'],
    emits: ['update:value'],
    setup(props, { emit }) {
      return () => vue.h('input', {
        type: 'checkbox',
        checked: props.value,
        onChange: (event: Event) => emit('update:value', (event.target as HTMLInputElement).checked),
      })
    },
  })

  const NModal = vue.defineComponent({
    name: 'NModal',
    setup(_, { slots }) {
      return () => vue.h('div', slots.default?.())
    },
  })

  const NInputNumber = vue.defineComponent({
    name: 'NInputNumber',
    setup() {
      return () => vue.h('input', { type: 'number' })
    },
  })

  return {
    NButton,
    NTooltip,
    NSwitch,
    NModal,
    NInputNumber,
    useMessage: () => ({
      error: vi.fn(),
      success: vi.fn(),
    }),
  }
})

vi.mock('@/api/hermes/sessions', () => ({
  fetchContextLength: vi.fn(async () => 200000),
}))

vi.mock('@/api/hermes/model-context', () => ({
  setModelContext: vi.fn(async () => ({ ok: true })),
}))

vi.mock('@/api/hermes/skills', () => ({
  fetchSkills: vi.fn(async () => ({ categories: [] })),
}))

vi.mock('@/api/hermes/plugins', () => ({
  fetchPlugins: vi.fn(async () => ({ plugins: [] })),
}))

vi.mock('@/composables/useToolTraceVisibility', () => ({
  useToolTraceVisibility: () => ({
    toolTraceVisible: { value: true },
    toggleToolTraceVisible: vi.fn(),
  }),
}))

vi.mock('@/composables/useTerminalState', () => ({
  useTerminalState: () => ({
    activeTicker: { value: '' },
    getTickerLiveMetrics: vi.fn(() => null),
  }),
}))

import ChatInput from '@/components/hermes/chat/ChatInput.vue'
import { useAuroraAppWindowStore } from '@/stores/hermes/aurora-app-window'
import { useAuroraCommanderStore } from '@/stores/hermes/aurora-commander'
import { useChatStore } from '@/stores/hermes/chat'
import { useVibeCodingStore } from '@/stores/hermes/vibe-coding'
import { useAuroraWorkingMemoryStore, WORKING_MEMORY_CONTEXT_MARKER } from '@/stores/hermes/working-memory'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'

describe('Aurora ChatInput MiroFish routing', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    auroraEventBus.clearTimeline()
  })

  it('routes MiroFish commands from the OmniBar into App Mode before build/chat fallbacks', async () => {
    const wrapper = mount(ChatInput)
    const chatStore = useChatStore()
    const vibeCodingStore = useVibeCodingStore()
    const appWindowStore = useAuroraAppWindowStore()
    const chatSendSpy = vi.spyOn(chatStore, 'sendMessage')
    const vibeStartSpy = vi.spyOn(vibeCodingStore, 'start')

    await wrapper.findAll('.omni-mode-button')[1].trigger('click')
    await wrapper.find('textarea.input-textarea').setValue('推演 TSLA')
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('mirofish')
    expect(appWindowStore.activePayload).toMatchObject({
      query: '推演 TSLA',
      initialView: 'workbench',
      launchContext: {
        source: 'aurora-omnibar',
        targetTicker: 'TSLA',
      },
    })
    expect(chatSendSpy).not.toHaveBeenCalled()
    expect(vibeStartSpy).not.toHaveBeenCalled()
    expect(auroraEventBus.timeline.value.find(event => event.type === 'TICKER_FOCUSED')).toMatchObject({
      type: 'TICKER_FOCUSED',
      payload: {
        symbol: 'NASDAQ:TSLA',
        rawSymbol: 'TSLA',
      },
    })
    expect((wrapper.find('textarea.input-textarea').element as HTMLTextAreaElement).value).toBe('')

    wrapper.unmount()
  })

  it('routes video creation prompts into Video Studio before the Build pipeline', async () => {
    const wrapper = mount(ChatInput)
    const chatStore = useChatStore()
    const vibeCodingStore = useVibeCodingStore()
    const appWindowStore = useAuroraAppWindowStore()
    const chatSendSpy = vi.spyOn(chatStore, 'sendMessage')
    const vibeStartSpy = vi.spyOn(vibeCodingStore, 'start')

    await wrapper.findAll('.omni-mode-button')[1].trigger('click')
    await wrapper.find('textarea.input-textarea').setValue('請製作一支 9:16 直式搞笑短影片，時長 12 秒')
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('video-studio')
    expect(appWindowStore.activePayload).toMatchObject({
      initialPrompt: '製作一支 9:16 直式搞笑短影片，時長 12 秒',
      source: 'aurora-omnibar',
    })
    expect(chatSendSpy).not.toHaveBeenCalled()
    expect(vibeStartSpy).not.toHaveBeenCalled()

    wrapper.unmount()
  })

  it('clears passive Aurora result cards when composing a new intent', async () => {
    const wrapper = mount(ChatInput)
    const commanderStore = useAuroraCommanderStore()

    commanderStore.result = {
      id: 'phase-check',
      title: 'Quant Phase Check',
      subtitle: 'Aurora Legacy Bridge',
      toolName: 'RunQuantPhaseCheckTool',
      securityLevel: 'L1_ReadOnly',
      summary: '10/10 phases PASS',
      sections: [],
      rawJson: '{}',
    }

    expect(commanderStore.isVisible).toBe(true)

    await wrapper.findAll('.omni-mode-button')[2].trigger('click')
    await flushPromises()

    expect(commanderStore.result).toBeNull()
    expect(commanderStore.isVisible).toBe(false)

    wrapper.unmount()
  })

  it('dismisses stale running bridge cards when the user starts a new intent', async () => {
    const wrapper = mount(ChatInput)
    const commanderStore = useAuroraCommanderStore()

    commanderStore.isRunning = true

    expect(commanderStore.isVisible).toBe(true)

    await wrapper.find('textarea.input-textarea').trigger('focus')
    await flushPromises()

    expect(commanderStore.isRunning).toBe(false)
    expect(commanderStore.isVisible).toBe(false)

    wrapper.unmount()
  })

  it('broadcasts ticker focus before falling back to Hermes chat for prefixed market analysis', async () => {
    const wrapper = mount(ChatInput)
    const chatStore = useChatStore()
    const chatSendSpy = vi.spyOn(chatStore, 'sendMessage')

    await wrapper.find('textarea.input-textarea').setValue('!analyze MU')
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatSendSpy).toHaveBeenCalledTimes(1)
    expect(chatSendSpy.mock.calls[0][0]).toContain('analyze MU')
    expect(auroraEventBus.timeline.value.find(event => event.type === 'TICKER_FOCUSED')).toMatchObject({
      type: 'TICKER_FOCUSED',
      payload: {
        symbol: 'NASDAQ:MU',
        rawSymbol: 'MU',
      },
    })

    wrapper.unmount()
  })

  it('syncs the raw textarea value before routing MiroFish commands', async () => {
    const wrapper = mount(ChatInput)
    const appWindowStore = useAuroraAppWindowStore()
    const textarea = wrapper.find('textarea.input-textarea')

    ;(textarea.element as HTMLTextAreaElement).value = 'Run MiroFish on TSLA'
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('mirofish')
    expect(appWindowStore.activePayload).toMatchObject({
      query: 'Run MiroFish on TSLA',
      launchContext: {
        source: 'aurora-omnibar',
        targetTicker: 'TSLA',
      },
    })

    wrapper.unmount()
  })

  it('routes non-financial MiroFish topics into Universal Brain App Mode', async () => {
    const wrapper = mount(ChatInput)
    const appWindowStore = useAuroraAppWindowStore()

    await wrapper.find('textarea.input-textarea').setValue('!推演 將 Aurora OS 開源的利弊')
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(appWindowStore.isOpen).toBe(true)
    expect(appWindowStore.activeApp?.kind).toBe('mirofish')
    expect(appWindowStore.activePayload).toMatchObject({
      query: '推演 將 Aurora OS 開源的利弊',
      launchContext: {
        source: 'aurora-omnibar',
        topic: '將 Aurora OS 開源的利弊',
      },
    })
    expect(JSON.stringify(appWindowStore.activePayload)).not.toContain('targetTicker')

    wrapper.unmount()
  })

  it('keeps unprefixed freeform debate-like drafts in Hermes chat', async () => {
    const wrapper = mount(ChatInput)
    const chatStore = useChatStore()
    const appWindowStore = useAuroraAppWindowStore()
    const chatSendSpy = vi.spyOn(chatStore, 'sendMessage')

    await wrapper.find('textarea.input-textarea').setValue('推演 將 Aurora OS 開源的利弊')
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatSendSpy).toHaveBeenCalledTimes(1)
    expect(chatSendSpy.mock.calls[0][0]).toContain('推演 將 Aurora OS 開源的利弊')
    expect(appWindowStore.isOpen).toBe(false)

    wrapper.unmount()
  })

  it('falls back to Hermes chat with Aurora Working Memory context attached', async () => {
    const wrapper = mount(ChatInput)
    const chatStore = useChatStore()
    const workingMemoryStore = useAuroraWorkingMemoryStore()
    const chatSendSpy = vi.spyOn(chatStore, 'sendMessage')

    workingMemoryStore.setBrowserContext({
      url: 'https://example.com/apple-q3',
      title: 'Apple Q3 Earnings',
      source: 'browser',
      topic: 'Apple Q3 Earnings',
    })

    await wrapper.find('textarea.input-textarea').setValue('Summarize this')
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatSendSpy).toHaveBeenCalledTimes(1)
    expect(chatSendSpy.mock.calls[0][0]).toContain('Summarize this')
    expect(chatSendSpy.mock.calls[0][0]).toContain(WORKING_MEMORY_CONTEXT_MARKER)
    expect(chatSendSpy.mock.calls[0][0]).toContain('Browser URL: https://example.com/apple-q3')

    wrapper.unmount()
  })

  it('does not let Working Memory context trigger legacy bridge cards for freeform drafts', async () => {
    const wrapper = mount(ChatInput)
    const chatStore = useChatStore()
    const workingMemoryStore = useAuroraWorkingMemoryStore()
    const commanderStore = useAuroraCommanderStore()
    const appWindowStore = useAuroraAppWindowStore()
    const chatSendSpy = vi.spyOn(chatStore, 'sendMessage')

    workingMemoryStore.setBrowserContext({
      url: 'https://example.com/quant-phase-check',
      title: 'Quant Phase Check',
      source: 'browser',
      topic: 'Quant Phase Check',
      excerpt: 'RunQuantPhaseCheckTool / Quant Lab legacy bridge status was visible earlier.',
    })

    const freeformDraft = [
      '學術派、市場理論與金融模型',
      '週期模組 Dalio、Minsky、Kondratiev',
      '行為心理模組 Kahneman、Tversky、Thaler',
      '因子選股模組 Fama、French、Asness',
      'AI 自適應模組 Andrew Lo、López de Prado',
      '趨勢交易模組 Druckenmiller、Soros、Simons',
    ].join('\n')

    await wrapper.find('textarea.input-textarea').setValue(freeformDraft)
    await wrapper.find('textarea.input-textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(chatSendSpy).toHaveBeenCalledTimes(1)
    expect(chatSendSpy.mock.calls[0][0]).toContain(freeformDraft)
    expect(chatSendSpy.mock.calls[0][0]).toContain(WORKING_MEMORY_CONTEXT_MARKER)
    expect(commanderStore.isRunning).toBe(false)
    expect(commanderStore.result).toBeNull()
    expect(appWindowStore.isOpen).toBe(false)

    wrapper.unmount()
  })
})
