<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'

import { fetchHealthOverview, type HealthOverview } from '@/api/hermes/health-state'
import { useProfilesStore } from '@/stores/hermes/profiles'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const loading = ref(false)
const overview = ref<HealthOverview | null>(null)
const activeTab = ref('today')

const tabs = ['today', 'plan', 'logs', 'body', 'recovery']
const activeProfile = computed(() => profilesStore.activeProfileName || 'default')
const latestPlan = computed(() => overview.value?.latestPlan ?? null)
const recentWorkouts = computed(() => overview.value?.recentWorkouts ?? [])
const topRegions = computed(() => overview.value?.externalSummary?.topRegions ?? overview.value?.topBodyConcerns ?? [])
const checkins = computed(() => overview.value?.dailyCheckins ?? [])
const planWorkouts = computed(() => {
  const workouts = latestPlan.value?.workouts
  return Array.isArray(workouts) ? workouts : []
})
const latestCheckin = computed(() => checkins.value[0] ?? null)

onMounted(loadOverview)

async function ensureProfiles() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    try {
      await profilesStore.fetchProfiles()
    } catch {
      // Fitness remains usable with the default local profile when profile lookup is unavailable.
    }
  }
}

async function loadOverview() {
  loading.value = true
  try {
    await ensureProfiles()
    overview.value = await fetchHealthOverview({ profile: activeProfile.value })
  } catch (err: any) {
    message.error(`${t('fitness.loadFailed')}: ${err.message}`)
  } finally {
    loading.value = false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function displayValue(value: unknown, fallback = '--'): string {
  if (value === null || value === undefined || value === '') return fallback
  return String(value)
}

function workoutTitle(workout: unknown): string {
  if (!isRecord(workout)) return displayValue(workout, t('fitness.workout'))
  return displayValue(workout.title || workout.name || workout.exercise || workout.kind, t('fitness.workout'))
}

function regionTitle(region: unknown): string {
  if (!isRecord(region)) return displayValue(region)
  return displayValue(region.region || region.id)
}
</script>

<template>
  <div class="fitness-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('fitness.title') }}</h2>
        <p class="header-subtitle">{{ t('fitness.subtitle') }}</p>
      </div>
      <NButton size="small" quaternary :loading="loading" @click="loadOverview">
        {{ t('common.retry') }}
      </NButton>
    </header>

    <NSpin :show="loading && !overview">
      <section class="fitness-hero">
        <div>
          <span class="panel-kicker">{{ activeProfile }}</span>
          <h3>{{ t('fitness.todayFocus') }}</h3>
          <p>{{ latestPlan?.notes || t('fitness.todayFocusFallback') }}</p>
        </div>
        <div class="hero-metrics">
          <div>
            <strong>{{ planWorkouts.length }}</strong>
            <span>{{ t('fitness.plannedWorkouts') }}</span>
          </div>
          <div>
            <strong>{{ recentWorkouts.length }}</strong>
            <span>{{ t('fitness.recentLogs') }}</span>
          </div>
          <div>
            <strong>{{ topRegions.length }}</strong>
            <span>{{ t('fitness.bodyFocus') }}</span>
          </div>
        </div>
      </section>

      <nav class="fitness-tabs" data-test="fitness-tabs">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          :class="{ active: activeTab === tab }"
          @click="activeTab = tab"
        >
          {{ t(`fitness.tabs.${tab}`) }}
        </button>
      </nav>

      <section class="fitness-grid">
        <article class="panel">
          <div class="panel-title-row">
            <h3>{{ t('fitness.tabs.today') }}</h3>
            <span>{{ latestPlan?.planDate || '--' }}</span>
          </div>
          <ul v-if="planWorkouts.length" class="compact-list">
            <li v-for="(workout, index) in planWorkouts" :key="index">
              <strong>{{ workoutTitle(workout) }}</strong>
              <span>{{ latestPlan?.notes || t('fitness.planned') }}</span>
            </li>
          </ul>
          <p v-else class="muted">{{ t('fitness.noTodayWorkout') }}</p>
        </article>

        <article class="panel">
          <div class="panel-title-row">
            <h3>{{ t('fitness.tabs.logs') }}</h3>
            <span>{{ recentWorkouts.length }} {{ t('fitness.items') }}</span>
          </div>
          <ul v-if="recentWorkouts.length" class="compact-list">
            <li v-for="workout in recentWorkouts.slice(0, 5)" :key="String(workout.id)">
              <strong>{{ workoutTitle(workout) }}</strong>
              <span>{{ displayValue(workout.durationMinutes) }} min · {{ displayValue(workout.intensity) }}</span>
            </li>
          </ul>
          <p v-else class="muted">{{ t('fitness.noWorkoutLogs') }}</p>
        </article>

        <article class="panel">
          <div class="panel-title-row">
            <h3>{{ t('fitness.tabs.body') }}</h3>
            <span>{{ topRegions.length }} {{ t('fitness.items') }}</span>
          </div>
          <ul v-if="topRegions.length" class="compact-list">
            <li v-for="region in topRegions.slice(0, 5)" :key="String(region.id || region.region)">
              <strong>{{ regionTitle(region) }}</strong>
              <span>{{ displayValue(region.priority, 'normal') }} · score {{ displayValue(region.score, '0') }}</span>
            </li>
          </ul>
          <p v-else class="muted">{{ t('fitness.noBodyFocus') }}</p>
        </article>

        <article class="panel">
          <div class="panel-title-row">
            <h3>{{ t('fitness.tabs.recovery') }}</h3>
            <span>{{ checkins.length }} {{ t('fitness.checkins') }}</span>
          </div>
          <div class="recovery-grid">
            <div>
              <span>{{ t('fitness.energy') }}</span>
              <strong>{{ displayValue(latestCheckin?.energyScore) }}</strong>
            </div>
            <div>
              <span>{{ t('fitness.pain') }}</span>
              <strong>{{ displayValue(latestCheckin?.painScore) }}</strong>
            </div>
          </div>
          <p class="muted">{{ displayValue(latestCheckin?.notes, t('fitness.noRecoveryNote')) }}</p>
        </article>
      </section>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.fitness-view {
  height: 100%;
  min-height: 0;
  overflow: auto;
  padding: 24px;
  color: var(--text-color);
}

.page-header,
.panel-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.page-header {
  margin-bottom: 18px;
}

.header-title {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.header-subtitle,
.fitness-hero p,
.muted {
  color: var(--text-color-2);
}

.fitness-hero,
.panel {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  padding: 16px;
}

.fitness-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 0.8fr);
  gap: 16px;
}

.panel-kicker {
  color: var(--text-color-3);
  font-size: 12px;
  text-transform: uppercase;
}

.hero-metrics,
.fitness-grid,
.recovery-grid {
  display: grid;
  gap: 10px;
}

.hero-metrics {
  grid-template-columns: repeat(3, minmax(0, 1fr));

  div {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px;
  }

  strong,
  span {
    display: block;
  }

  strong {
    font-size: 22px;
  }

  span {
    color: var(--text-color-3);
    font-size: 12px;
  }
}

.fitness-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px 0;

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

.fitness-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.panel-title-row {
  align-items: center;

  h3 {
    margin: 0;
    font-size: 17px;
  }

  span {
    color: var(--text-color-3);
    font-size: 12px;
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

.recovery-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 14px;

  div {
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 10px;
  }

  span,
  strong {
    display: block;
  }

  span {
    color: var(--text-color-3);
    font-size: 12px;
  }

  strong {
    margin-top: 4px;
    font-size: 20px;
  }
}

@media (max-width: 900px) {
  .fitness-view {
    padding: 16px;
  }

  .fitness-hero,
  .fitness-grid,
  .hero-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
