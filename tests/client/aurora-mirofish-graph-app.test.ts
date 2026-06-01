// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import MiroFishGraphApp from '@/components/hermes/aurora/MiroFishGraphApp.vue'
import MiroFishCosmicCanvas from '@/components/hermes/aurora/MiroFishCosmicCanvas.vue'
import MiroFishAppEntry from '@/components/hermes/aurora/MiroFishAppEntry.vue'
import GraphRAGPipeline from '@/components/hermes/aurora/GraphRAGPipeline.vue'
import { fetchSystemStatus } from '@/api/hermes/system-status'
import type { SystemStatusResponse } from '@/api/hermes/system-status'
import {
  buildMiroFishSafeFallbackResult,
  MIROFISH_SAFE_GATEWAY_ALERT,
  runQuantLabMiroFish,
  type RunQuantLabMiroFishResult,
} from '@/api/hermes/quant-lab'

vi.mock('@/api/hermes/system-status', () => ({
  fetchSystemStatus: vi.fn(),
}))

const fetchSystemStatusMock = vi.mocked(fetchSystemStatus)

beforeAll(() => {
  const canvasContext = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    bezierCurveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 80 })),
  }

  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext as unknown as CanvasRenderingContext2D)
})

function systemStatus(overrides: Partial<SystemStatusResponse> = {}): SystemStatusResponse {
  return {
    status: 'ok',
    checked_at: '2026-05-29T12:00:00.000Z',
    profile: 'default',
    hermes_home: '/tmp/hermes',
    components: [
      {
        key: 'mirofish-frontend',
        label: 'MiroFish Frontend',
        status: 'ok',
        summary: 'MiroFish frontend is reachable.',
        url: 'http://127.0.0.1:5174',
        updated_at: '2026-05-29T12:00:00.000Z',
      },
    ],
    ...overrides,
  }
}

function miroFishResult(): RunQuantLabMiroFishResult {
  const scenarios = {
    bullish: {
      probability: 0.08,
      confidence: 0.73,
      reasoning: 'Upside requires confirmation before exposure.',
    },
    neutral: {
      probability: 0.22,
      confidence: 0.78,
      reasoning: 'Wait for breakout confirmation.',
    },
    bearish: {
      probability: 0.7,
      confidence: 0.8,
      reasoning: 'Risk gate remains blocked in a risk-off tape.',
    },
  }

  return {
    ok: true,
    phase: 'premarket',
    source: 'mock',
    generatedAt: '2026-05-29T12:00:00.000Z',
    evidenceCount: 32,
    topPicks: [
      {
        ticker: 'AVGO',
        score: 99,
        action: 'BUY',
        trend: 4.53,
        risk: 'High',
        reason: 'AI networking breakout candidate.',
        price: 436.35,
      },
    ],
    mirofish: {
      status: 'complete',
      inference: {
        status: 'complete',
        confidence: 'high',
        support: ['AVGO 99 BUY momentum remains strong.'],
        oppose: ['Risk-Off guardrail is active.'],
        neutral: ['Wait for confirmation.'],
        evidenceCount: 32,
        debate: {
          macro: {
            Regime: 'Risk-Off',
            RiskMultiplier: 0.35,
            MacroInsight: 'VIX and yields keep the macro gate defensive.',
          },
          scenarios,
          key_risks: ['Risk gate blocked.'],
          bull: {
            role: 'bull',
            title: 'Alpha digger',
            content: 'AVGO 99 BUY has upside evidence.',
            citations: [],
            generatedAt: '2026-05-29T12:00:00.000Z',
          },
          bear: {
            role: 'bear',
            title: 'Risk defender',
            content: 'Risk-Off blocks aggressive buys.',
            citations: [],
            generatedAt: '2026-05-29T12:00:00.000Z',
          },
          judgeRaw: JSON.stringify({ scenarios }),
          mode: 'local',
          ok: true,
          generatedAt: '2026-05-29T12:00:00.000Z',
        },
      },
      evidenceArchive: {
        path: '/tmp/evidence.json',
        relativePath: 'evidence.json',
        graphOk: true,
        journalNote: 'Mock evidence archive.',
        topDegrees: [{ ticker: 'AVGO', degree: 4 }],
      },
    },
  } as unknown as RunQuantLabMiroFishResult
}

describe('MiroFishGraphApp', () => {
  beforeEach(() => {
    fetchSystemStatusMock.mockReset()
    fetchSystemStatusMock.mockResolvedValue(systemStatus())
  })

  it('builds a scoped project graph iframe URL from the provided base URL and project id', async () => {
    const wrapper = mount(MiroFishGraphApp, {
      props: {
        initialUrl: 'http://localhost:3000/',
        projectId: 'alpha graph',
      },
    })

    await flushPromises()

    expect(wrapper.find('iframe.graph-frame').attributes('src')).toBe('http://localhost:3000/process/alpha%20graph')
    expect(fetchSystemStatusMock).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('honors explicit graph paths while staying inside the MiroFish frontend origin', async () => {
    const wrapper = mount(MiroFishGraphApp, {
      props: {
        initialUrl: 'http://127.0.0.1:5174',
        graphPath: 'process/custom-project',
      },
    })

    await flushPromises()

    expect(wrapper.find('iframe.graph-frame').attributes('src')).toBe('http://127.0.0.1:5174/process/custom-project')

    wrapper.unmount()
  })

  it('adopts the reachable MiroFish frontend URL from system status when no base URL is provided', async () => {
    const wrapper = mount(MiroFishGraphApp, {
      props: {
        projectId: 'preview-project',
      },
    })

    await flushPromises()

    expect(wrapper.find('iframe.graph-frame').attributes('src')).toBe('http://127.0.0.1:5174/process/preview-project')
    expect(wrapper.find('.service-pill').classes()).toContain('ready')
    expect(wrapper.text()).toContain('MiroFish graph UI is reachable.')

    wrapper.unmount()
  })

  it('shows a clean service advisory when status checking fails', async () => {
    fetchSystemStatusMock.mockRejectedValueOnce(new Error('service offline'))

    const wrapper = mount(MiroFishGraphApp)

    await flushPromises()

    expect(wrapper.find('iframe.graph-frame').attributes('src')).toBe('http://localhost:3000/process/preview-project')
    expect(wrapper.find('.service-pill').classes()).toContain('error')
    expect(wrapper.text()).toContain('Aurora could not check MiroFish status.')
    expect(wrapper.text()).toContain('service offline')

    wrapper.unmount()
  })
})

describe('MiroFishCosmicCanvas', () => {
  it('hydrates the native canvas detail card from live MiroFish results without leaking raw JSON', async () => {
    const wrapper = mount(MiroFishCosmicCanvas, {
      props: {
        ticker: 'AVGO',
        focusPath: 'verdict',
        liveResult: miroFishResult(),
      },
    })

    await flushPromises()

    expect(wrapper.find('.cosmic-data-pill').text()).toContain('Live result · AVGO')
    expect(wrapper.find('.cosmic-detail-card').text()).toContain('Synth BUY')
    expect(wrapper.find('.cosmic-detail-card').text()).toContain('Final BUY')
    expect(wrapper.find('.cosmic-detail-card').text()).toContain('Bullish 8%')
    expect(wrapper.find('.cosmic-detail-card').text()).toContain('Bearish 70%')
    expect(wrapper.find('.cosmic-detail-card').text()).not.toContain('"scenarios"')
    expect(wrapper.findAll('.cosmic-detail-metrics article').length).toBeGreaterThan(0)

    wrapper.unmount()
  })

  it('uses Universal Brain wording for non-financial topic canvases', async () => {
    const universalResult = miroFishResult()
    universalResult.topPicks = [{
      ticker: 'TOPIC',
      score: 88,
      action: 'WATCH',
      trend: 0,
      risk: 'Medium',
      reason: 'Universal Brain topic evidence is ready for reversible pilot evaluation.',
      price: 0,
    }]
    const debate = universalResult.mirofish.inference?.debate
    if (debate) {
      debate.scenarios.bullish.probability = 0.62
      debate.scenarios.neutral.probability = 0.24
      debate.scenarios.bearish.probability = 0.14
      debate.macro.Regime = 'cognitive-sandbox'
      debate.macro.MacroInsight = 'Evaluate governance, maintenance, and reversibility before commitment.'
    }

    const wrapper = mount(MiroFishCosmicCanvas, {
      props: {
        topic: '將 Aurora OS 開源的利弊',
        focusPath: 'verdict',
        liveResult: universalResult,
      },
    })

    await flushPromises()

    const detailText = wrapper.find('.cosmic-detail-card').text()
    expect(wrapper.find('.cosmic-data-pill').text()).toContain('Live result · Universal Brain')
    expect(detailText).toContain('Synth PILOT')
    expect(detailText).toContain('Universal Brain topic')
    expect(detailText).toContain('將 Aurora OS 開源的利弊')
    expect(detailText).not.toContain('Price')
    expect(detailText).not.toContain('TOPIC WATCH')

    wrapper.unmount()
  })

  it('hydrates memory records as hoverable and clickable constellation stars', async () => {
    const originalFetch = global.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/hermes/quant-lab/mirofish-memory-records')) {
        return new Response(JSON.stringify({
          ok: true,
          path: '/tmp/hermes-knowledge/MiroFish_Records',
          relativePath: 'MiroFish_Records',
          directories: ['MiroFish_Records'],
          updatedAt: '2026-05-30T12:00:00.000Z',
          records: [
            {
              id: 'phase-21-memory',
              title: 'Phase 21 acceptance memory save TSLA',
              question: 'Phase 21 acceptance memory save TSLA',
              finalVerdict: 'AVGO BUY · bull 8% / bear 70%',
              verdict: 'AVGO BUY · bull 8% / bear 70%',
              date: '2026-05-30T06:03:40.555Z',
              source: 'alpaca-market-data+fred+yahoo-chart-macro',
              summary: 'Saved long-term MiroFish verdict.',
              path: '/tmp/hermes-knowledge/MiroFish_Records/phase-21.md',
              relativePath: 'MiroFish_Records/phase-21.md',
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    }))

    try {
      const wrapper = mount(MiroFishCosmicCanvas, {
        props: {
          ticker: 'TSLA',
          focusPath: 'verdict',
        },
      })

      await flushPromises()
      expect(wrapper.find('.memory-constellation-pill').text()).toContain('1 memory stars hydrated')

      const canvas = wrapper.find('canvas.cosmic-canvas')
      canvas.element.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: -27, clientY: -27 }))
      await flushPromises()
      expect(wrapper.find('.memory-tooltip-card').text()).toContain('Phase 21 acceptance memory save TSLA')

      canvas.element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: -27, clientY: -27 }))
      await flushPromises()
      expect(wrapper.find('.cosmic-detail-card.memory').text()).toContain('AVGO BUY')

      wrapper.unmount()
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it('rehydrates a requested memory record when App Mode passes its id', async () => {
    const originalFetch = global.fetch
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/hermes/quant-lab/mirofish-memory-records')) {
        return new Response(JSON.stringify({
          ok: true,
          path: '/tmp/hermes-knowledge/MiroFish_Records',
          relativePath: 'MiroFish_Records',
          directories: ['MiroFish_Records'],
          updatedAt: '2026-05-30T12:00:00.000Z',
          records: [
            {
              id: 'universal-memory',
              fileName: 'universal.md',
              title: '推演 Universal Brain 記憶治理策略',
              question: '推演 Universal Brain 記憶治理策略',
              finalVerdict: 'SYNTH HOLD · favorable 39% / pilot 31% / pause 30%',
              date: '2026-05-30T09:31:12.065Z',
              source: 'aurora-universal-brain',
              summary: 'Universal memory governance verdict.',
              path: '/tmp/hermes-knowledge/MiroFish_Records/universal.md',
              relativePath: 'MiroFish_Records/universal.md',
              tags: ['aurora'],
              size: 1024,
              updatedAt: '2026-05-30T09:31:12.065Z',
            },
          ],
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200 })
    }))

    try {
      const wrapper = mount(MiroFishCosmicCanvas, {
        props: {
          topic: '推演 Universal Brain 記憶治理策略',
          initialMemoryRecordId: 'universal-memory',
        },
      })

      await flushPromises()

      expect(wrapper.find('.cosmic-detail-card.memory').text()).toContain('推演 Universal Brain 記憶治理策略')
      expect(wrapper.find('.cosmic-detail-card.memory').text()).toContain('SYNTH HOLD')

      wrapper.unmount()
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })
})

describe('MiroFishAppEntry view routing', () => {
  it('switches the top navigation between graph, pipeline, and workbench layouts', async () => {
    const wrapper = mount(MiroFishAppEntry, {
      props: {
        launchContext: {
          source: 'aurora-omnibar',
          targetTicker: 'AVGO',
        },
      },
      global: {
        stubs: {
          MiroFishCosmicCanvas: {
            name: 'MiroFishCosmicCanvas',
            template: '<div class="canvas-stub">Canvas</div>',
          },
          GraphRAGPipeline: {
            name: 'GraphRAGPipeline',
            template: '<div class="pipeline-stub">Pipeline</div>',
          },
          MiroFishArena: {
            name: 'MiroFishArena',
            props: ['launchContext'],
            emits: ['focusPath', 'resultChange'],
            template: '<div class="arena-stub">Arena</div>',
          },
        },
      },
    })

    const tabs = wrapper.findAll('.view-mode-rail button')

    expect(wrapper.classes()).toContain('view-graph')
    expect(tabs.map(tab => tab.text())).toEqual(['圖譜Canvas', '構建Pipeline', '工作台Arena'])
    expect(tabs[0].classes()).toContain('active')
    expect(wrapper.find('.cosmic-canvas-stage').exists()).toBe(true)
    expect(wrapper.find('.pipeline-stage').exists()).toBe(false)
    expect(wrapper.find('.debate-stage').exists()).toBe(false)

    await tabs[1].trigger('click')
    expect(wrapper.classes()).toContain('view-pipeline')
    expect(tabs[1].classes()).toContain('active')
    expect(wrapper.find('.cosmic-canvas-stage').exists()).toBe(true)
    expect(wrapper.find('.pipeline-stage').exists()).toBe(true)
    expect(wrapper.find('.debate-stage').exists()).toBe(false)

    await tabs[2].trigger('click')
    expect(wrapper.classes()).toContain('view-workbench')
    expect(tabs[2].classes()).toContain('active')
    expect(wrapper.find('.cosmic-canvas-stage').exists()).toBe(false)
    expect(wrapper.find('.pipeline-stage').exists()).toBe(false)
    expect(wrapper.find('.debate-stage').exists()).toBe(true)

    wrapper.unmount()
  })

  it('honors App Mode initialView payloads for direct OmniBar launches', async () => {
    const wrapper = mount(MiroFishAppEntry, {
      props: {
        initialView: 'workbench',
        launchContext: {
          source: 'aurora-omnibar',
          targetTicker: 'AVGO',
        },
      },
      global: {
        stubs: {
          MiroFishCosmicCanvas: {
            name: 'MiroFishCosmicCanvas',
            template: '<div class="canvas-stub">Canvas</div>',
          },
          GraphRAGPipeline: {
            name: 'GraphRAGPipeline',
            template: '<div class="pipeline-stub">Pipeline</div>',
          },
          MiroFishArena: {
            name: 'MiroFishArena',
            props: ['launchContext'],
            emits: ['focusPath', 'resultChange'],
            template: '<div class="arena-stub">Arena</div>',
          },
        },
      },
    })

    expect(wrapper.classes()).toContain('view-workbench')
    expect(wrapper.find('.view-mode-rail button.active').text()).toBe('工作台Arena')
    expect(wrapper.find('.debate-stage').exists()).toBe(true)
    expect(wrapper.find('.pipeline-stage').exists()).toBe(false)
    expect(wrapper.find('.cosmic-canvas-stage').exists()).toBe(false)

    await wrapper.setProps({ initialView: 'pipeline' })
    expect(wrapper.classes()).toContain('view-pipeline')
    expect(wrapper.find('.view-mode-rail button.active').text()).toBe('構建Pipeline')
    expect(wrapper.find('.pipeline-stage').exists()).toBe(true)
    expect(wrapper.find('.cosmic-canvas-stage').exists()).toBe(true)
    expect(wrapper.find('.debate-stage').exists()).toBe(false)

    wrapper.unmount()
  })
})

describe('GraphRAGPipeline', () => {
  it('renders Aurora glass pipeline steps, entity tags, graph stats, and terminal hydration logs', () => {
    const wrapper = mount(GraphRAGPipeline, {
      props: {
        ticker: 'AVGO',
        liveResult: miroFishResult(),
      },
    })

    expect(wrapper.text()).toContain('推演前構建檢查')
    expect(wrapper.text()).toContain('01 本體構建')
    expect(wrapper.text()).toContain('02 GraphRAG 構建')
    expect(wrapper.text()).toContain('03 推演預檢')
    expect(wrapper.text()).toContain('Scenario')
    expect(wrapper.text()).toContain('AVGO')
    expect(wrapper.text()).toContain('6')
    expect(wrapper.text()).toContain('Nodes')
    expect(wrapper.text()).toContain('5')
    expect(wrapper.text()).toContain('Edges')
    expect(wrapper.find('.pipeline-terminal').text()).toContain('Preview graph hydrated')
    expect(wrapper.find('.status-pill.complete').exists()).toBe(true)

    wrapper.unmount()
  })

  it('renders gateway parsing interceptions as safe system dashboard alerts', () => {
    const wrapper = mount(GraphRAGPipeline, {
      props: {
        ticker: 'TSLA',
        liveResult: buildMiroFishSafeFallbackResult({ phase: 'premarket', targetTicker: 'TSLA' }),
      },
    })

    const terminalText = wrapper.find('.pipeline-terminal').text()
    expect(terminalText).toContain(MIROFISH_SAFE_GATEWAY_ALERT)
    expect(terminalText).toContain('action=WATCH')
    expect(terminalText).not.toContain('Traceback')
    expect(terminalText).not.toContain('NoneType')

    wrapper.unmount()
  })
})

describe('MiroFish gateway API interceptor', () => {
  it('returns a valid safe fallback result instead of leaking raw Python errors', async () => {
    const originalFetch = global.fetch
    const fetchMock = vi.fn(async () => new Response(
      'Traceback (most recent call last): TypeError: NoneType object is not iterable',
      { status: 500, statusText: 'Internal Server Error' },
    ))
    vi.stubGlobal('fetch', fetchMock)

    try {
      const result = await runQuantLabMiroFish({ phase: 'premarket', targetTicker: 'TSLA' })
      const serialized = JSON.stringify(result)

      expect(result.source).toBe('aurora-safe-mode')
      expect(result.topPicks[0]?.ticker).toBe('TSLA')
      expect(result.mirofish.inference?.debate?.mode).toBe('safe-fallback')
      expect(serialized).toContain(MIROFISH_SAFE_GATEWAY_ALERT)
      expect(serialized).not.toContain('Traceback')
      expect(serialized).not.toContain('NoneType')
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })
})
