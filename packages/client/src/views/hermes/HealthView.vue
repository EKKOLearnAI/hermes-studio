<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import {
  fetchHealthOverview,
  fetchScaleSyncSettings,
  runScaleSync,
  type HealthOverview,
  type ScaleSyncResult,
  type ScaleSyncSettings,
} from '@/api/hermes/health-state'
import { useProfilesStore } from '@/stores/hermes/profiles'
import HealthBody3DViewer from './health/HealthBody3DViewer.vue'
import type { BodyRegionId, HealthBodyMap, HealthWorkoutLike } from './health/body-visualization'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const loading = ref(false)
const scaleSyncLoading = ref(false)
const overview = ref<HealthOverview | null>(null)
const scaleSyncSettings = ref<ScaleSyncSettings | null>(null)
const lastScaleSyncResult = ref<ScaleSyncResult | null>(null)
const selectedRegion = ref<BodyRegionId>('chest')
const activeTab = ref('overview')

const healthTabs = ['overview', 'body3d', 'diet', 'fitness', 'skin', 'internal']
const activeProfile = computed(() => profilesStore.activeProfileName || 'default')
const healthProfile = computed(() => overview.value?.healthProfile ?? null)
const weightSummary = computed(() => overview.value?.weightSummary ?? {})
const nutritionSummary = computed(() => overview.value?.nutritionSummary ?? null)
const latestPlan = computed(() => overview.value?.latestPlan ?? null)
const latestScaleReading = computed(() => overview.value?.latestScaleReading ?? null)
const recentWorkouts = computed(() => overview.value?.recentWorkouts ?? [])
const digitalTwinSummary = computed(() => overview.value?.digitalTwinSummary ?? null)
const externalSummary = computed(() => overview.value?.externalSummary ?? null)
const internalMarkers = computed(() => overview.value?.internalMarkers ?? [])
const micronutrientItems = computed(() => overview.value?.micronutrientSummary?.items ?? [])
const bodyProfile = computed(() => overview.value?.bodyProfile ?? null)
const bodyMeasurements = computed(() => bodyProfile.value?.latestMeasurements ?? null)
const postureProfile = computed(() => bodyProfile.value?.posture ?? null)
const skinProfile = computed(() => bodyProfile.value?.skin ?? null)
const topExternalRegions = computed(() => externalSummary.value?.topRegions ?? overview.value?.topBodyConcerns ?? [])
const bodyRegionData = computed<Partial<Record<BodyRegionId, { title: string; metrics: Array<{ label: string; value: string }>; notes?: string[] }>>>(() => {
  const measurements = bodyMeasurements.value?.measurements ?? {}
  const postureIssues = postureProfile.value?.issues ?? []
  const postureNotes = postureProfile.value?.notes ? [postureProfile.value.notes] : []
  const compositionNotes = latestScaleReading.value?.sourceDevice ? [`体成分来自 ${latestScaleReading.value.sourceDevice}`] : []
  return {
    chest: {
      title: '胸部数据',
      metrics: compactMetrics([
        ['胸围', formatCm(numberOrNull(measurements.chest_cm))],
        ['体脂率', percentText(latestScaleReading.value?.bodyFatPercent)],
        ['基础代谢', latestScaleReading.value?.basalMetabolismKcal == null ? '--' : `${latestScaleReading.value.basalMetabolismKcal} kcal`],
      ]),
      notes: [...compositionNotes, ...postureIssueNotes(postureIssues, ['thoracic_kyphosis', 'thorax_right_posterior_rotation'])],
    },
    shoulders: {
      title: '肩颈数据',
      metrics: compactMetrics([
        ['体态限制', postureIssueText(postureIssues, ['right_scapula_downward_rotation', 'right_trapezius_tension', 'right_infraspinatus_weakness'])],
        ['疼痛触发', '卧推/飞鸟'],
      ]),
      notes: postureNotes,
    },
    abs: {
      title: '核心/骨盆数据',
      metrics: compactMetrics([
        ['腰围', formatCm(numberOrNull(measurements.waist_cm))],
        ['BMI', displayValue(latestScaleReading.value?.bmi)],
        ['内脏脂肪', displayValue(latestScaleReading.value?.visceralFatLevel)],
        ['体态限制', postureIssueText(postureIssues, ['anterior_pelvic_tilt', 'pelvic_rotation_right', 'lumbosacral_extension_compensation'])],
      ]),
      notes: postureNotes,
    },
    glutes: {
      title: '骨盆/臀部数据',
      metrics: compactMetrics([
        ['臀围', formatCm(numberOrNull(measurements.hip_cm))],
        ['体态限制', postureIssueText(postureIssues, ['right_pelvis_high', 'pelvic_rotation_right', 'anterior_pelvic_tilt'])],
      ]),
      notes: postureNotes,
    },
    biceps: {
      title: '上臂数据',
      metrics: compactMetrics([
        ['左上臂', formatCm(numberOrNull(measurements.left_upper_arm_relaxed_cm))],
        ['右上臂', formatCm(numberOrNull(measurements.right_upper_arm_relaxed_cm))],
      ]),
      notes: bodyMeasurements.value?.notes ? [bodyMeasurements.value.notes] : [],
    },
    forearms: {
      title: '前臂数据',
      metrics: compactMetrics([
        ['前臂围', formatCm(numberOrNull(measurements.forearm_cm))],
      ]),
    },
    lats: {
      title: '背部数据',
      metrics: compactMetrics([
        ['肌肉量', formatKg(numberOrNull(latestScaleReading.value?.muscleMassKg))],
        ['体态限制', postureIssueText(postureIssues, ['thorax_right_posterior_rotation', 'lumbar_left_convex_scoliosis'])],
      ]),
      notes: postureNotes,
    },
    quads: {
      title: '大腿前侧数据',
      metrics: compactMetrics([
        ['左大腿', formatCm(numberOrNull(measurements.left_thigh_cm))],
        ['右大腿', formatCm(numberOrNull(measurements.right_thigh_cm))],
      ]),
    },
    hamstrings: {
      title: '大腿后侧数据',
      metrics: compactMetrics([
        ['左大腿', formatCm(numberOrNull(measurements.left_thigh_cm))],
        ['右大腿', formatCm(numberOrNull(measurements.right_thigh_cm))],
        ['骨盆限制', postureIssueText(postureIssues, ['anterior_pelvic_tilt', 'right_pelvis_high'])],
      ]),
      notes: postureNotes,
    },
    calves: {
      title: '小腿数据',
      metrics: compactMetrics([
        ['左小腿', formatCm(numberOrNull(measurements.left_calf_cm))],
        ['右小腿', formatCm(numberOrNull(measurements.right_calf_cm))],
      ]),
    },
  }
})
const skinAppearanceLayer = computed(() => {
  if (!skinProfile.value) return null
  return {
    title: '全身皮肤外观层',
    concerns: skinProfile.value.concerns.map(bodyTermLabel),
    notes: [
      skinProfile.value.notes || '',
      '不只管理脸部，后续扩展到躯干、背部、手臂、腿部等全身皮肤区域。',
    ].filter(Boolean),
  }
})
const bodyDataNeeds = computed(() => bodyProfile.value?.nextDataNeeded ?? [])

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

onMounted(async () => {
  await loadOverview()
  await loadScaleSyncSettings()
})

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
    overview.value = await fetchHealthOverview({ profile: activeProfile.value, includeRecords: false })
  } catch (err: any) {
    message.error(`${t('health.loadFailed')}: ${err.message}`)
  } finally {
    loading.value = false
  }
}

async function loadScaleSyncSettings() {
  scaleSyncLoading.value = true
  try {
    await ensureProfiles()
    applyScaleSyncSettings(await fetchScaleSyncSettings(activeProfile.value))
  } catch (err: any) {
    message.error(`${t('health.scaleSync.loadFailed')}: ${err.message}`)
  } finally {
    scaleSyncLoading.value = false
  }
}

async function runScaleSyncNow() {
  scaleSyncLoading.value = true
  try {
    lastScaleSyncResult.value = await runScaleSync(activeProfile.value)
    if (lastScaleSyncResult.value.importedCount > 0) await loadOverview()
  } catch (err: any) {
    message.error(`${t('health.scaleSync.runFailed')}: ${err.message}`)
  } finally {
    scaleSyncLoading.value = false
  }
}

function applyScaleSyncSettings(settings: ScaleSyncSettings) {
  scaleSyncSettings.value = settings
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

function scaleSyncStatusText(result: ScaleSyncResult | null): string {
  if (!result) return scaleSyncSettings.value?.configured ? t('health.scaleSync.ready') : t('health.scaleSync.notReady')
  if (result.status === 'synced') return `${t('health.scaleSync.synced')} ${result.importedCount}`
  if (result.reason) return t(`health.scaleSync.reason.${result.reason}`)
  return result.status
}

function compactMetrics(items: Array<[string, string]>): Array<{ label: string; value: string }> {
  return items
    .filter(([, value]) => value !== '--' && value !== '-- cm' && value !== '-- kg')
    .map(([label, value]) => ({ label, value }))
}

function postureIssueText(issues: string[], keys: string[]): string {
  const labels = postureIssueNotes(issues, keys)
  return labels.length ? labels.join(' / ') : '--'
}

function postureIssueNotes(issues: string[], keys: string[]): string[] {
  return issues.filter(issue => keys.includes(issue)).map(bodyTermLabel)
}

function bodyTermLabel(value: string): string {
  const labels: Record<string, string> = {
    pelvic_rotation_right: '右侧骨盆旋前',
    right_scapula_downward_rotation: '右侧肩胛下回旋',
    thorax_right_posterior_rotation: '胸廓右后旋',
    lumbar_left_convex_scoliosis: '腰段左凸',
    forward_head: '头部前倾',
    thoracic_kyphosis: '胸椎后凸',
    lumbosacral_extension_compensation: '腰骶伸展代偿',
    anterior_pelvic_tilt: '骨盆前倾',
    right_pelvis_high: '右侧骨盆偏高',
    right_trapezius_tension: '右侧斜方肌紧绷',
    right_infraspinatus_weakness: '右侧冈下肌较弱',
    acne_marks: '痘印',
    acne: '痘痘',
    blackheads: '黑头',
    hydration: '补水',
    body_measurements_recheck: '复测围度',
    posture_recheck: '复查体态',
    skin_status_recheck: '更新皮肤状态',
  }
  return labels[value] || value
}

function formatCm(value: number | null): string {
  return value === null ? '-- cm' : `${value} cm`
}

function percentText(value: unknown): string {
  const numeric = numberOrNull(value)
  return numeric === null ? '--' : `${numeric}%`
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
      <section class="health-hero body-digital-twin-panel" data-test="body-digital-twin-panel">
        <div class="twin-identity">
          <span class="panel-kicker">{{ activeProfile }}</span>
          <h3>身体数字孪生</h3>
          <p>把外在体型、训练体态、饮食营养和内在指标合并成 Hermes 可读取的健康上下文。</p>

          <span class="panel-kicker">数据源</span>
          <div class="twin-source-row">
            <span>{{ latestScaleReading?.sourceDevice || 'S400 未同步' }}</span>
            <span>{{ bodyMeasurements?.source || '围度待记录' }}</span>
            <span>{{ postureProfile?.source || '体态待记录' }}</span>
            <span>{{ skinProfile?.source || '皮肤待记录' }}</span>
          </div>

          <div class="scale-sync-actions twin-sync">
            <span>S400 / 米家自动同步 · {{ scaleSyncStatusText(lastScaleSyncResult) }}</span>
            <NButton size="small" secondary :loading="scaleSyncLoading" @click="runScaleSyncNow">
              {{ t('health.scaleSync.runNow') }}
            </NButton>
          </div>
        </div>

        <div class="twin-layers">
          <article class="twin-layer">
            <div class="body-profile-card-head">
              <strong>体成分层</strong>
              <span>{{ latestScaleReading?.measuredAt || '待同步' }}</span>
            </div>
            <div class="metric-row compact">
              <div data-test="health-summary-metric">
                <span class="metric-value">{{ formatKg(weightCurrent) }}</span>
                <span class="metric-label">{{ t('health.currentWeight') }}</span>
              </div>
              <div data-test="health-summary-metric">
                <span class="metric-value">{{ formatKg(weightTarget) }}</span>
                <span class="metric-label">{{ t('health.targetWeight') }}</span>
              </div>
              <div data-test="health-summary-metric">
                <span class="metric-value">{{ displayValue(latestScaleReading?.bodyFatPercent) }}%</span>
                <span class="metric-label">{{ t('health.scale.bodyFat') }}</span>
              </div>
              <div data-test="health-summary-metric">
                <span class="metric-value">{{ displayValue(latestScaleReading?.basalMetabolismKcal) }} kcal</span>
                <span class="metric-label">{{ t('health.scale.basalMetabolism') }}</span>
              </div>
            </div>
            <div class="twin-inline-metrics">
              <span>肌肉 {{ formatKg(numberOrNull(latestScaleReading?.muscleMassKg)) }}</span>
              <span>内脏脂肪 {{ displayValue(latestScaleReading?.visceralFatLevel) }}</span>
              <span>身体评分 {{ displayValue(latestScaleReading?.bodyScore) }}</span>
            </div>
          </article>

          <article class="twin-layer">
            <div class="body-profile-card-head">
              <strong>整体校准</strong>
              <span>{{ workoutCount }} {{ t('health.recentWorkouts') }} / {{ digitalTwinSummary?.internalMarkerCount ?? 0 }} 内在指标</span>
            </div>
            <div class="tag-cloud">
              <span v-for="need in bodyDataNeeds" :key="need">{{ bodyTermLabel(need) }}</span>
              <span v-if="!bodyDataNeeds.length">数据完整</span>
            </div>
          </article>
        </div>
      </section>

      <nav class="health-system-tabs" data-test="health-system-tabs">
        <button
          v-for="tab in healthTabs"
          :key="tab"
          type="button"
          :class="{ active: activeTab === tab }"
          @click="activeTab = tab"
        >
          {{ t(`health.tabs.${tab}`) }}
        </button>
      </nav>

      <section v-if="overview" class="health-layout">
        <div class="twin-column">
          <HealthBody3DViewer
            v-model:selected-region="selectedRegion"
            :body-map="bodyMap"
            :workouts="viewerWorkouts"
            :region-data="bodyRegionData"
            :skin-layer="skinAppearanceLayer"
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
  grid-template-columns: minmax(260px, 0.44fr) minmax(0, 1fr);
  gap: 18px;
  margin-bottom: 16px;
}

.body-digital-twin-panel {
  align-items: stretch;
}

.twin-identity {
  display: grid;
  align-content: start;
  gap: 14px;
}

.twin-source-row,
.twin-inline-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  span {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-color-2);
    font-size: 12px;
    padding: 6px 8px;
  }
}

.twin-sync {
  align-items: center;
  justify-content: space-between;
  border-top: 1px solid var(--border-color);
  padding-top: 12px;

  > span {
    color: var(--text-color-2);
    font-size: 13px;
  }
}

.twin-layers {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.twin-layer {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
}

.twin-layer:first-child {
  grid-column: 1 / -1;
}

.twin-next {
  grid-column: 1 / -1;
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

.metric-row.compact {
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

.health-system-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 16px;

  button {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: transparent;
    color: var(--text-color-2);
    cursor: pointer;
    font: inherit;
    padding: 7px 10px;
  }

  button.active {
    border-color: var(--primary-color);
    color: var(--primary-color);
  }
}

.scale-panel,
.scale-sync-panel,
.body-profile-panel {
  display: grid;
  gap: 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  margin-bottom: 16px;
  padding: 16px;
}

.scale-metrics {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;

  div {
    min-width: 0;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px;
  }

  strong {
    display: block;
    margin-top: 4px;
    font-size: 18px;
  }
}

.scale-sync-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.scale-sync-summary {
  margin: 0;
  color: var(--text-color-2);
}

.body-profile-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.body-profile-card {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
}

.body-profile-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;

  strong {
    font-size: 14px;
  }

  span {
    color: var(--text-color-3);
    font-size: 12px;
    text-align: right;
  }
}

.measurement-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;

  div {
    min-width: 0;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 8px;
  }

  span {
    color: var(--text-color-2);
    font-size: 13px;
  }
}

.tag-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;

  span {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    color: var(--text-color-2);
    font-size: 13px;
    padding: 6px 8px;
  }
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
  .health-layout,
  .health-hero {
    grid-template-columns: 1fr;
  }

  .metric-row,
  .scale-metrics {
    grid-template-columns: repeat(2, minmax(84px, 1fr));
  }

  .metric-row.compact,
  .twin-layers {
    grid-template-columns: 1fr;
  }

  .twin-layer:first-child,
  .twin-next {
    grid-column: auto;
  }

  .body-profile-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 760px) {
  .health-view {
    padding: 16px;
  }

  .health-hero,
  .metric-row,
  .scale-metrics {
    grid-template-columns: 1fr;
  }

  .micro-row {
    grid-template-columns: 1fr;
  }
}
</style>
