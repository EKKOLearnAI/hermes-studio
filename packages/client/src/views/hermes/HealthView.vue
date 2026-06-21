<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import { fetchHealthOverview, type HealthOverview } from '@/api/hermes/health-state'
import { useProfilesStore } from '@/stores/hermes/profiles'
import HealthBody3DViewer from './health/HealthBody3DViewer.vue'
import type { BodyRegionId, HealthBodyMap, HealthWorkoutLike } from './health/body-visualization'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const loading = ref(false)
const overview = ref<HealthOverview | null>(null)
const selectedRegion = ref<BodyRegionId>('chest')

const activeProfile = computed(() => profilesStore.activeProfileName || 'default')
const healthProfile = computed(() => overview.value?.healthProfile ?? null)
const weightSummary = computed(() => overview.value?.weightSummary ?? {})
const nutritionSummary = computed(() => overview.value?.nutritionSummary ?? null)
const latestPlan = computed(() => overview.value?.latestPlan ?? null)
const recentWorkouts = computed(() => overview.value?.recentWorkouts ?? [])
const digitalTwinSummary = computed(() => overview.value?.digitalTwinSummary ?? null)
const externalSummary = computed(() => overview.value?.externalSummary ?? null)
const internalMarkers = computed(() => overview.value?.internalMarkers ?? [])
const micronutrientItems = computed(() => overview.value?.micronutrientSummary?.items ?? [])
const topExternalRegions = computed(() => externalSummary.value?.topRegions ?? overview.value?.topBodyConcerns ?? [])

const bodyMap = computed<HealthBodyMap>(() => {
  const rows = overview.value?.bodyMap ?? []
  return rows.reduce<HealthBodyMap>((result, row) => {
    const region = typeof row.region === 'string' ? row.region : ''
    const payload = isRecord(row.payload) ? row.payload : {}
    if (region) result[region] = payload
    return result
  }, {})
})

const viewerWorkouts = computed<HealthWorkoutLike[]>(() =>
  recentWorkouts.value.map(workout => ({
    id: String(workout.id ?? ''),
    title: typeof workout.title === 'string' ? workout.title : undefined,
    durationMinutes: numberOrNull(workout.durationMinutes) ?? undefined,
    intensity: typeof workout.intensity === 'string' ? workout.intensity : null,
    startedAt: typeof workout.startedAt === 'string' ? workout.startedAt : undefined,
    notes: typeof workout.notes === 'string' ? workout.notes : null,
  })).filter(workout => workout.id),
)

const foodLogCount = computed(() => overview.value?.foodLogs.length ?? 0)
const workoutCount = computed(() => overview.value?.recentWorkouts.length ?? 0)
const weightCurrent = computed(() => numberOrNull(weightSummary.value.currentKg) ?? healthProfile.value?.weightKg ?? null)
const weightTarget = computed(() => numberOrNull(weightSummary.value.targetKg) ?? healthProfile.value?.weightTargetKg ?? null)

onMounted(loadOverview)

async function ensureProfiles() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    try {
      await profilesStore.fetchProfiles()
    } catch {
      // Keep the health cockpit usable even when profile discovery is temporarily unavailable.
    }
  }
}

async function loadOverview() {
  loading.value = true
  try {
    await ensureProfiles()
    overview.value = await fetchHealthOverview({ profile: activeProfile.value })
  } catch (err: any) {
    message.error(`${t('health.loadFailed')}: ${err.message}`)
  } finally {
    loading.value = false
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatKg(value: number | null): string {
  return value === null ? '-- kg' : `${value} kg`
}

function nutritionValue(key: string, kind: 'targets' | 'consumed' | 'remaining'): number {
  return numberOrNull(nutritionSummary.value?.[kind]?.[key]) ?? 0
}

function displayValue(value: unknown, fallback = '--'): string {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

function formatMarkerValue(marker: Record<string, unknown>): string {
  const value = displayValue(marker.value)
  const unit = displayValue(marker.unit, '')
  return unit ? `${value} ${unit}` : value
}

function statusText(status: unknown): string {
  const value = displayValue(status, 'unknown')
  if (value === 'low') return '偏低'
  if (value === 'high') return '偏高'
  if (value === 'ok') return '正常'
  return value
}

function planWorkoutTitle(workout: unknown): string {
  if (!isRecord(workout)) return String(workout)
  return String(workout.title || workout.name || workout.exercise || t('health.workout'))
}
</script>

<template>
  <div class="health-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('health.title') }}</h2>
        <p class="header-subtitle">{{ t('health.subtitle') }}</p>
      </div>
      <NButton size="small" quaternary :loading="loading" @click="loadOverview">
        {{ t('common.retry') }}
      </NButton>
    </header>

    <NSpin :show="loading && !overview">
      <section class="health-hero">
        <div>
          <span class="panel-kicker">{{ activeProfile }}</span>
          <h3>身体数字孪生</h3>
          <p>把外在体型、训练体态、饮食营养和内在指标合并成 Hermes 可读取的健康上下文。</p>
        </div>
        <div class="metric-row">
          <div data-test="health-summary-metric">
            <span class="metric-value">{{ formatKg(weightCurrent) }}</span>
            <span class="metric-label">{{ t('health.currentWeight') }}</span>
          </div>
          <div data-test="health-summary-metric">
            <span class="metric-value">{{ formatKg(weightTarget) }}</span>
            <span class="metric-label">{{ t('health.targetWeight') }}</span>
          </div>
          <div data-test="health-summary-metric">
            <span class="metric-value">{{ workoutCount }}</span>
            <span class="metric-label">{{ t('health.recentWorkouts') }}</span>
          </div>
          <div data-test="health-summary-metric">
            <span class="metric-value">{{ digitalTwinSummary?.internalMarkerCount ?? 0 }}</span>
            <span class="metric-label">内在指标</span>
          </div>
        </div>
      </section>

      <section v-if="overview" class="health-layout">
        <div class="twin-column">
          <HealthBody3DViewer
            v-model:selected-region="selectedRegion"
            :body-map="bodyMap"
            :workouts="viewerWorkouts"
          />

          <article class="panel">
            <div class="panel-title-row">
              <h3>外在健康</h3>
              <span>{{ externalSummary?.recentWorkoutCount ?? workoutCount }} {{ t('health.recentWorkouts') }}</span>
            </div>
            <ul class="compact-list region-list">
              <li v-for="region in topExternalRegions.slice(0, 4)" :key="String(region.id || region.region)">
                <strong>{{ displayValue(region.region) }}</strong>
                <span>{{ displayValue(region.priority, 'normal') }} · score {{ displayValue(region.score, '0') }}</span>
              </li>
            </ul>
            <p v-if="!topExternalRegions.length" class="muted">暂无体态或肌群关注点。</p>
          </article>
        </div>

        <div class="side-panels">
          <article class="panel">
            <div class="panel-title-row">
              <h3>内在健康</h3>
              <span>{{ internalMarkers.length }} 指标</span>
            </div>
            <ul class="compact-list">
              <li v-for="marker in internalMarkers.slice(0, 4)" :key="marker.id">
                <strong>{{ marker.label || marker.key }}</strong>
                <span>{{ formatMarkerValue(marker) }} · {{ statusText(marker.status) }}</span>
              </li>
            </ul>
            <p v-if="!internalMarkers.length" class="muted">暂无体检、血液、微量元素或生命体征记录。</p>
          </article>

          <article class="panel">
            <div class="panel-title-row">
              <h3>{{ t('health.smartDiet') }}</h3>
              <span>{{ foodLogCount }} {{ t('health.logs') }}</span>
            </div>
            <div class="nutrition-grid">
              <div v-for="key in ['calories', 'protein', 'carbs', 'fat']" :key="key">
                <span class="metric-label">{{ t(`health.nutrition.${key}`) }}</span>
                <strong>{{ nutritionValue(key, 'consumed') }}</strong>
                <small>/ {{ nutritionValue(key, 'targets') }}</small>
              </div>
            </div>
            <div v-if="micronutrientItems.length" class="micro-list">
              <div v-for="item in micronutrientItems.slice(0, 4)" :key="item.key" class="micro-row">
                <span>{{ item.key }}</span>
                <strong>{{ item.consumed }} / {{ item.target }}</strong>
                <small>{{ statusText(item.status) }}</small>
              </div>
            </div>
          </article>

          <article class="panel">
            <div class="panel-title-row">
              <h3>{{ t('health.smartFitness') }}</h3>
              <span>{{ workoutCount }} {{ t('health.items') }}</span>
            </div>
            <ul class="compact-list">
              <li v-for="workout in recentWorkouts.slice(0, 4)" :key="String(workout.id)">
                <strong>{{ workout.title || workout.kind || t('health.workout') }}</strong>
                <span>{{ workout.durationMinutes || '--' }} min · {{ workout.intensity || '--' }}</span>
              </li>
            </ul>
            <p v-if="!recentWorkouts.length" class="muted">{{ t('health.noWorkouts') }}</p>
          </article>

          <article class="panel">
            <div class="panel-title-row">
              <h3>{{ t('health.todayPlan') }}</h3>
              <span>{{ latestPlan?.planDate || '--' }}</span>
            </div>
            <ul v-if="Array.isArray(latestPlan?.workouts) && latestPlan.workouts.length" class="compact-list">
              <li v-for="(workout, index) in latestPlan.workouts" :key="index">
                <strong>{{ planWorkoutTitle(workout) }}</strong>
                <span>{{ latestPlan?.notes || t('health.planned') }}</span>
              </li>
            </ul>
            <p v-else class="muted">{{ t('health.noPlan') }}</p>
          </article>
        </div>
      </section>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.health-view {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  color: var(--text-color);
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
}

.header-title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.header-subtitle,
.health-hero p,
.muted {
  color: var(--text-color-2);
}

.health-hero,
.panel {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  padding: 16px;
}

.health-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(360px, 0.8fr);
  gap: 18px;
  margin-bottom: 16px;
}

.panel-kicker {
  color: var(--text-color-3);
  font-size: 12px;
  text-transform: uppercase;
}

.metric-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(84px, 1fr));
  gap: 10px;
}

.metric-row > div {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  padding: 10px;
}

.metric-value {
  display: block;
  font-size: 22px;
  font-weight: 700;
}

.metric-label {
  color: var(--text-color-3);
  font-size: 12px;
}

.health-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(300px, 0.8fr);
  gap: 16px;
}

.twin-column {
  display: grid;
  align-content: start;
  gap: 16px;
}

.side-panels {
  display: grid;
  align-content: start;
  gap: 16px;
}

.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  h3 {
    margin: 0;
    font-size: 17px;
  }

  span {
    color: var(--text-color-3);
    font-size: 12px;
  }
}

.nutrition-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;

  div {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px;
  }

  strong {
    display: block;
    margin-top: 4px;
    font-size: 20px;
  }

  small {
    color: var(--text-color-3);
  }
}

.compact-list {
  display: grid;
  gap: 10px;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;

  li {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px;
  }

  strong,
  span {
    display: block;
  }

  span {
    margin-top: 4px;
    color: var(--text-color-3);
    font-size: 12px;
  }
}

.region-list strong {
  text-transform: none;
}

.micro-list {
  display: grid;
  gap: 8px;
  margin-top: 14px;
}

.micro-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 10px;

  span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong {
    font-size: 13px;
  }

  small {
    color: var(--text-color-3);
  }
}

@media (max-width: 1180px) {
  .health-layout {
    grid-template-columns: 1fr;
  }

  .metric-row {
    grid-template-columns: repeat(2, minmax(84px, 1fr));
  }
}

@media (max-width: 760px) {
  .health-view {
    padding: 16px;
  }

  .health-hero,
  .metric-row {
    grid-template-columns: 1fr;
  }

  .micro-row {
    grid-template-columns: 1fr;
  }
}
</style>
