// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TradingViewApp from '@/components/hermes/aurora/TradingViewApp.vue'
import { auroraEventBus } from '@/services/hermes/aurora/aurora-event-bus'

describe('Aurora TradingView App', () => {
  let setSymbolSpy: ReturnType<typeof vi.fn>
  let openSpy: ReturnType<typeof vi.spyOn>
  let fetchSpy: ReturnType<typeof vi.fn>
  let openedWindow: {
    close: ReturnType<typeof vi.fn>
    document: { write: ReturnType<typeof vi.fn> }
    focus: ReturnType<typeof vi.fn>
    location: { href: string }
    opener: unknown
  }

  beforeEach(() => {
    window.localStorage.clear()
    auroraEventBus.clearTimeline()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    setSymbolSpy = vi.fn()
    fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    }))
    vi.stubGlobal('fetch', fetchSpy)
    openedWindow = {
      close: vi.fn(),
      document: { write: vi.fn() },
      focus: vi.fn(),
      location: { href: '' },
      opener: {},
    }
    openSpy = vi.spyOn(window, 'open').mockReturnValue(openedWindow as unknown as Window)
    window.TradingView = {
      widget: vi.fn(() => ({
        activeChart: () => ({
          setSymbol: setSymbolSpy,
        }),
        onChartReady: (callback: () => void) => callback(),
        remove: vi.fn(),
      })),
    }
  })

  it('updates the active chart when TICKER_FOCUSED is emitted', async () => {
    const wrapper = mount(TradingViewApp, {
      props: {
        symbol: 'NASDAQ:NVDA',
      },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('NASDAQ:NVDA')

    auroraEventBus.emit('TICKER_FOCUSED', {
      symbol: 'NASDAQ:TSLA',
      rawSymbol: 'TSLA',
      source: 'unit-test',
      input: '推演 TSLA',
      focusedAt: '2026-05-31T00:03:00.000Z',
    })
    await flushPromises()

    expect(wrapper.text()).toContain('NASDAQ:TSLA')
    expect(setSymbolSpy).toHaveBeenCalledWith('NASDAQ:TSLA', '15')

    wrapper.unmount()
  })

  it('ignores legacy account-mode preferences and renders Lite AI Sync only', async () => {
    window.localStorage.setItem('aurora.tradingview.mode.v1', 'pro')

    const wrapper = mount(TradingViewApp)
    await flushPromises()

    expect(window.TradingView?.widget).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.tradingview-widget-host').exists()).toBe(true)
    expect(wrapper.text()).toContain('Lite')
    expect(wrapper.text()).not.toContain('Pro')

    wrapper.unmount()
  })

  it('opens the focused symbol in TradingView through the explicit launch button', async () => {
    const wrapper = mount(TradingViewApp, {
      props: {
        symbol: 'NASDAQ:TSLA',
      },
    })
    await flushPromises()

    await wrapper.get('button.tradingview-external-button').trigger('click')
    await flushPromises()

    expect(fetchSpy).toHaveBeenCalledWith('/api/aurora/open-external', expect.objectContaining({
      body: JSON.stringify({ url: 'https://www.tradingview.com/chart/?symbol=NASDAQ%3ATSLA' }),
      method: 'POST',
    }))
    expect(openSpy).toHaveBeenCalledWith('about:blank', 'aurora_tradingview_login')
    expect(openedWindow.close).toHaveBeenCalled()

    wrapper.unmount()
  })

  it('falls back to browser open when the host launcher is unavailable', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ ok: false }),
    })

    const wrapper = mount(TradingViewApp, {
      props: {
        symbol: 'NASDAQ:NVDA',
      },
    })
    await flushPromises()

    await wrapper.get('button.tradingview-external-button').trigger('click')
    await flushPromises()

    expect(openSpy).toHaveBeenCalledWith('about:blank', 'aurora_tradingview_login')
    expect(openedWindow.location.href).toBe('https://www.tradingview.com/chart/?symbol=NASDAQ%3ANVDA')
    expect(openedWindow.focus).toHaveBeenCalled()

    wrapper.unmount()
  })
})
