import { fetchSessions } from '@/api/hermes/sessions';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
export const useUsageStore = defineStore('usage', () => {
    const sessions = ref([]);
    const isLoading = ref(false);
    async function loadSessions() {
        isLoading.value = true;
        try {
            sessions.value = await fetchSessions();
        }
        catch (err) {
            console.error('Failed to load sessions for usage:', err);
        }
        finally {
            isLoading.value = false;
        }
    }
    const totalInputTokens = computed(() => sessions.value.reduce((sum, s) => sum + (s.input_tokens || 0), 0));
    const totalOutputTokens = computed(() => sessions.value.reduce((sum, s) => sum + (s.output_tokens || 0), 0));
    const totalTokens = computed(() => totalInputTokens.value + totalOutputTokens.value);
    const totalSessions = computed(() => sessions.value.length);
    const totalCacheTokens = computed(() => sessions.value.reduce((sum, s) => sum + (s.cache_read_tokens || 0), 0));
    const cacheHitRate = computed(() => {
        const total = totalInputTokens.value;
        if (total === 0)
            return null;
        return ((totalCacheTokens.value / total) * 100);
    });
    const estimatedCost = computed(() => sessions.value.reduce((sum, s) => {
        const cost = s.actual_cost_usd ?? s.estimated_cost_usd ?? 0;
        return sum + cost;
    }, 0));
    const modelUsage = computed(() => {
        const map = new Map();
        for (const s of sessions.value) {
            const key = s.model || 'unknown';
            if (!map.has(key)) {
                map.set(key, {
                    model: key,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheTokens: 0,
                    totalTokens: 0,
                    sessions: 0,
                });
            }
            const entry = map.get(key);
            entry.inputTokens += s.input_tokens || 0;
            entry.outputTokens += s.output_tokens || 0;
            entry.cacheTokens += s.cache_read_tokens || 0;
            entry.totalTokens += (s.input_tokens || 0) + (s.output_tokens || 0);
            entry.sessions += 1;
        }
        return [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    });
    const dailyUsage = computed(() => {
        const map = new Map();
        const now = new Date();
        // Initialize last 30 days
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now);
            d.setDate(d.getDate() - i);
            const key = d.toISOString().slice(0, 10);
            map.set(key, { date: key, tokens: 0, cache: 0, sessions: 0, cost: 0 });
        }
        for (const s of sessions.value) {
            const d = new Date(s.started_at * 1000);
            const key = d.toISOString().slice(0, 10);
            const entry = map.get(key);
            if (entry) {
                entry.tokens += (s.input_tokens || 0) + (s.output_tokens || 0);
                entry.cache += s.cache_read_tokens || 0;
                entry.sessions += 1;
                const cost = s.actual_cost_usd ?? s.estimated_cost_usd ?? 0;
                entry.cost += cost;
            }
        }
        return [...map.values()];
    });
    const avgSessionsPerDay = computed(() => {
        const firstDate = sessions.value.length > 0
            ? new Date(sessions.value[sessions.value.length - 1].started_at * 1000)
            : new Date();
        const days = Math.max(1, Math.ceil((Date.now() - firstDate.getTime()) / (1000 * 60 * 60 * 24)));
        return totalSessions.value / days;
    });
    return {
        sessions,
        isLoading,
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
    };
});
