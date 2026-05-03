// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const usageApiMock = vi.hoisted(() => ({
  fetchUsageStats: vi.fn(),
}))

vi.mock('@/api/hermes/sessions', () => ({
  fetchUsageStats: usageApiMock.fetchUsageStats,
}))

describe('usage store analytics adapter', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    usageApiMock.fetchUsageStats.mockReset()
  })

  it('loads 30-day usage stats and derives chart metrics from the native-style payload', async () => {
    usageApiMock.fetchUsageStats.mockResolvedValue({
      total_input_tokens: 100,
      total_output_tokens: 50,
      total_cache_read_tokens: 25,
      total_cache_write_tokens: 5,
      total_reasoning_tokens: 10,
      total_cost: 0.0123,
      total_sessions: 2,
      period_days: 30,
      model_usage: [
        { model: 'gpt-5', input_tokens: 80, output_tokens: 40, cache_read_tokens: 20, cache_write_tokens: 3, reasoning_tokens: 7, sessions: 1 },
        { model: '', input_tokens: 20, output_tokens: 10, cache_read_tokens: 5, cache_write_tokens: 2, reasoning_tokens: 3, sessions: 1 },
      ],
      daily_usage: [
        { date: '2026-04-29', tokens: 100, cache: 20, sessions: 1, cost: 0.01 },
        { date: '2026-04-30', tokens: 50, cache: 5, sessions: 1, cost: 0.0023 },
      ],
    })

    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    await store.loadSessions()

    expect(usageApiMock.fetchUsageStats).toHaveBeenCalledWith(30)
    expect(store.totalTokens).toBe(150)
    expect(store.cacheHitRate).toBeCloseTo(25 / 125 * 100)
    expect(store.hasData).toBe(true)
    expect(store.modelUsage).toEqual([
      { model: 'gpt-5', totalTokens: 120, inputTokens: 80, outputTokens: 40, cacheTokens: 20, sessions: 1 },
      { model: 'unknown', totalTokens: 30, inputTokens: 20, outputTokens: 10, cacheTokens: 5, sessions: 1 },
    ])
    expect(store.dailyUsage).toEqual([
      { date: '2026-04-29', tokens: 100, cache: 20, sessions: 1, cost: 0.01 },
      { date: '2026-04-30', tokens: 50, cache: 5, sessions: 1, cost: 0.0023 },
    ])
  })

  it('allows callers to request a different period', async () => {
    usageApiMock.fetchUsageStats.mockResolvedValue({
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cache_read_tokens: 0,
      total_cache_write_tokens: 0,
      total_reasoning_tokens: 0,
      total_cost: 0,
      total_sessions: 0,
      model_usage: [],
      daily_usage: [],
    })

    const { useUsageStore } = await import('@/stores/hermes/usage')
    const store = useUsageStore()
    await store.loadSessions(7)

    expect(usageApiMock.fetchUsageStats).toHaveBeenCalledWith(7)
    expect(store.hasData).toBe(false)
  })
})
