import { fetchUsageStats, type UsageStatsResponse } from '@/api/hermes/sessions'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

interface DailyUsage {
  date: string
  tokens: number
  cache: number
  sessions: number
  cost: number
}

interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheTokens: number
  totalTokens: number
  sessions: number
}

export const useUsageStore = defineStore('usage', () => {
  const stats = ref<UsageStatsResponse | null>(null)
  const isLoading = ref(false)

  async function loadSessions() {
    isLoading.value = true
    try {
      stats.value = await fetchUsageStats()
    } catch (err) {
      console.error('Failed to load usage stats:', err)
    } finally {
      isLoading.value = false
    }
  }

  const hasData = computed(() => !!stats.value && stats.value.total_sessions > 0)

  const totalInputTokens = computed(() => stats.value?.total_input_tokens ?? 0)
  const totalOutputTokens = computed(() => stats.value?.total_output_tokens ?? 0)
  const totalTokens = computed(() => totalInputTokens.value + totalOutputTokens.value)
  const totalSessions = computed(() => stats.value?.total_sessions ?? 0)

  const totalCacheTokens = computed(() => stats.value?.total_cache_read_tokens ?? 0)

  const cacheHitRate = computed(() => {
    const total = totalInputTokens.value + totalCacheTokens.value
    if (total === 0) return null
    return ((totalCacheTokens.value / total) * 100)
  })

  const estimatedCost = computed(() => stats.value?.total_cost ?? 0)

  const modelUsage = computed<ModelUsage[]>(() => {
    if (!stats.value) return []
    return stats.value.model_usage.map(m => ({
      model: m.model,
      inputTokens: m.input_tokens,
      outputTokens: m.output_tokens,
      cacheTokens: m.cache_read_tokens,
      totalTokens: m.input_tokens + m.output_tokens,
      sessions: m.sessions,
    })).sort((a, b) => b.totalTokens - a.totalTokens)
  })

  const dailyUsage = computed<DailyUsage[]>(() => stats.value?.daily_usage ?? [])

  const avgSessionsPerDay = computed(() => {
    if (!stats.value || stats.value.daily_usage.length === 0) return 0
    const daysWithActivity = stats.value.daily_usage.filter(d => d.sessions > 0).length
    const days = Math.max(1, daysWithActivity)
    return totalSessions.value / days
  })

  return {
    stats,
    isLoading,
    hasData,
    loadSessions,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalSessions,
    totalCacheTokens,
    cacheHitRate,
    estimatedCost,
    modelUsage,
    dailyUsage,
    avgSessionsPerDay,
  }
})
