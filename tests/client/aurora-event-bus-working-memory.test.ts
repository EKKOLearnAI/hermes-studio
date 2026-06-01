// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/components/hermes/aurora/MiroFishCosmicCanvas.vue', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    default: vue.defineComponent({
      name: 'MiroFishCosmicCanvas',
      setup() {
        return () => vue.h('div', 'Cosmic Canvas')
      },
    }),
  }
})

vi.mock('@/components/hermes/aurora/GraphRAGPipeline.vue', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    default: vue.defineComponent({
      name: 'GraphRAGPipeline',
      setup() {
        return () => vue.h('div', 'GraphRAG Pipeline')
      },
    }),
  }
})

vi.mock('@/components/hermes/aurora/MiroFishArena.vue', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    default: vue.defineComponent({
      name: 'MiroFishArena',
      emits: ['result-change', 'focus-path'],
      setup() {
        return () => vue.h('div', 'MiroFish Arena')
      },
    }),
  }
})

vi.mock('@/components/hermes/aurora/TradingViewPanel.vue', async () => {
  const vue = await vi.importActual<typeof import('vue')>('vue')
  return {
    default: vue.defineComponent({
      name: 'TradingViewPanel',
      setup() {
        return () => vue.h('div', 'TradingView')
      },
    }),
  }
})

import MiroFishAppEntry from '@/components/hermes/aurora/MiroFishAppEntry.vue'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'
import { useAuroraWorkingMemoryStore, WORKING_MEMORY_CONTEXT_MARKER } from '@/stores/hermes/working-memory'

describe('Aurora Event Bus and Working Memory', () => {
  beforeEach(() => {
    window.localStorage.clear()
    setActivePinia(createPinia())
    auroraEventBus.clearTimeline()
  })

  it('publishes and subscribes typed Aurora IPC events', () => {
    const received: string[] = []
    const unsubscribe = auroraEventBus.subscribe('PAGE_ANALYZED', (event) => {
      received.push(`${event.payload.title}:${event.payload.url}`)
    })

    auroraEventBus.publish('PAGE_ANALYZED', {
      url: 'https://example.com/article',
      title: 'Example Article',
      source: 'unit-test',
      topic: 'Example Article',
      analyzedAt: '2026-05-31T00:00:00.000Z',
    })
    unsubscribe()

    expect(received).toEqual(['Example Article:https://example.com/article'])
    expect(window.__AURORA_EVENT_BUS__).toBe(auroraEventBus)
    expect(auroraEventBus.timeline.value[0]).toMatchObject({
      type: 'PAGE_ANALYZED',
      payload: {
        title: 'Example Article',
      },
    })
  })

  it('supports neural ticker focus events through emit/on aliases', () => {
    const received: string[] = []
    const unsubscribe = auroraEventBus.on('TICKER_FOCUSED', (payload) => {
      received.push(payload.symbol)
    })

    auroraEventBus.emit('TICKER_FOCUSED', {
      symbol: 'NASDAQ:TSLA',
      rawSymbol: 'TSLA',
      source: 'unit-test',
      input: '推演 TSLA',
      focusedAt: '2026-05-31T00:02:00.000Z',
    })
    unsubscribe()

    expect(received).toEqual(['NASDAQ:TSLA'])
    expect(auroraEventBus.timeline.value[0]).toMatchObject({
      type: 'TICKER_FOCUSED',
      payload: {
        symbol: 'NASDAQ:TSLA',
      },
    })
  })

  it('lets active MiroFish subscribe to Browser PAGE_ANALYZED events and queue a simulation', async () => {
    const queued: string[] = []
    auroraEventBus.subscribe('MIROFISH_BACKGROUND_SIMULATION_QUEUED', (event) => {
      queued.push(event.payload.topic)
    })

    const wrapper = mount(MiroFishAppEntry, {
      props: {
        initialView: 'workbench',
        launchContext: {
          source: 'aurora-omnibar',
          topic: 'Market',
        },
      },
    })

    auroraEventBus.publish('PAGE_ANALYZED', {
      url: 'https://example.com/macro-shock',
      title: 'Macro Shock Article',
      source: 'browser',
      topic: 'Macro Shock Article',
      analyzedAt: '2026-05-31T00:01:00.000Z',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('IPC queued')
    expect(wrapper.text()).toContain('Macro Shock Article')
    expect(queued).toEqual(['Macro Shock Article'])
    wrapper.unmount()
  })

  it('formats on-screen awareness as prompt RAM for the Commander and Hermes fallback', () => {
    const workingMemoryStore = useAuroraWorkingMemoryStore()
    workingMemoryStore.setBrowserContext({
      url: 'https://example.com/apple-q3',
      title: 'Apple Q3 Earnings',
      source: 'browser',
      topic: 'Apple Q3 Earnings',
      excerpt: 'Revenue accelerated while margins compressed slightly.',
    })

    const enriched = workingMemoryStore.enrichPrompt('Summarize this')

    expect(enriched).toContain('Summarize this')
    expect(enriched).toContain(WORKING_MEMORY_CONTEXT_MARKER)
    expect(enriched).toContain('Browser URL: https://example.com/apple-q3')
    expect(enriched).toContain('Apple Q3 Earnings')
    expect(enriched).toContain('Visible page excerpt: Revenue accelerated')
  })
})
