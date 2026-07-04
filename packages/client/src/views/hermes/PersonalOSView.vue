<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { fetchPersonalStateOverview, type PersonalStateOverview } from '@/api/hermes/personal-state'
import {
  createPersonalAutopilotQuickLog,
  fetchPersonalAutopilotOverview,
  type PersonalAutopilotOverview,
} from '@/api/hermes/personal-autopilot'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const loading = ref(false)
const quickLogSaving = ref(false)
const quickLogText = ref('')
const overview = ref<PersonalStateOverview | null>(null)
const autopilot = ref<PersonalAutopilotOverview | null>(null)

const activeProfile = computed(() => profilesStore.activeProfileName || 'default')
const pendingProposals = computed(() => overview.value?.pendingProposals || [])
const tasks = computed(() => overview.value?.tasks || [])
const nextAction = computed(() => autopilot.value?.nextAction)
const signals = computed(() => autopilot.value?.signals || [])

onMounted(loadOverview)

async function ensureProfiles() {
  if (!profilesStore.activeProfileName || profilesStore.profiles.length === 0) {
    await profilesStore.fetchProfiles()
  }
}

async function loadOverview() {
  loading.value = true
  try {
    await ensureProfiles()
    const [stateOverview, autopilotOverview] = await Promise.all([
      fetchPersonalStateOverview({ profile: activeProfile.value }),
      fetchPersonalAutopilotOverview({ profile: activeProfile.value }),
    ])
    overview.value = stateOverview
    autopilot.value = autopilotOverview
  } catch (err: any) {
    message.error(`${t('personalOS.loadFailed')}: ${err.message}`)
  } finally {
    loading.value = false
  }
}

async function submitQuickLog() {
  const text = quickLogText.value.trim()
  if (!text || quickLogSaving.value) return

  quickLogSaving.value = true
  try {
    await createPersonalAutopilotQuickLog({ text }, activeProfile.value)
    quickLogText.value = ''
    message.success(t('personalOS.quickLogSaved'))
    await loadOverview()
  } catch (err: any) {
    message.error(`${t('personalOS.quickLogFailed')}: ${err.message}`)
  } finally {
    quickLogSaving.value = false
  }
}
</script>

<template>
  <div class="personal-os-view">
    <header class="page-header">
      <div>
        <h2 class="header-title">{{ t('personalOS.title') }}</h2>
        <p class="header-subtitle">{{ t('personalOS.subtitle') }}</p>
      </div>
      <NButton size="small" quaternary :loading="loading" @click="loadOverview">
        <template #icon>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </template>
        {{ t('common.retry') }}
      </NButton>
    </header>

    <NSpin :show="loading && !overview">
      <section class="command-center" data-test="autopilot-command-center">
        <div class="command-main">
          <div>
            <span class="panel-kicker">{{ activeProfile }}</span>
            <h3>{{ t('personalOS.commandCenter') }}</h3>
            <p>{{ t('personalOS.commandCenterSummary') }}</p>
          </div>
          <span class="mode-pill">{{ autopilot?.mode || 'silent' }}</span>
        </div>

        <article class="next-action-card">
          <span class="panel-kicker">{{ t('personalOS.nextAction') }}</span>
          <h3>{{ nextAction?.title || t('personalOS.noNextAction') }}</h3>
          <p>{{ nextAction?.reason || t('personalOS.noNextActionReason') }}</p>
          <div class="fallback-row">
            <span>{{ t('personalOS.fallbackAction') }}</span>
            <strong>{{ nextAction?.fallbackTitle || t('personalOS.recordCurrentState') }}</strong>
          </div>
        </article>

        <form class="quick-log-form" @submit.prevent="submitQuickLog">
          <label class="quick-log-input" data-test="autopilot-quick-log-input">
            <span>{{ t('personalOS.quickLog') }}</span>
            <input
              v-model="quickLogText"
              type="text"
              :placeholder="t('personalOS.quickLogPlaceholder')"
              :disabled="quickLogSaving"
            >
          </label>
          <NButton
            type="primary"
            :loading="quickLogSaving"
            :disabled="!quickLogText.trim()"
            data-test="autopilot-quick-log-submit"
            @click="submitQuickLog"
          >
            {{ t('personalOS.quickLogSubmit') }}
          </NButton>
        </form>

        <div class="signal-strip">
          <div v-for="signal in signals" :key="signal.key" class="signal-item">
            <span class="metric-label">{{ signal.label }}</span>
            <strong>{{ signal.value }}</strong>
            <small>{{ signal.status }}</small>
          </div>
          <div class="signal-item">
            <span class="metric-label">{{ t('personalOS.pending') }}</span>
            <strong>{{ pendingProposals.length }}</strong>
            <small>{{ t('personalOS.reviewQueue') }}</small>
          </div>
          <div class="signal-item">
            <span class="metric-label">{{ t('personalOS.tasks') }}</span>
            <strong>{{ tasks.length }}</strong>
            <small>{{ t('personalOS.execution') }}</small>
          </div>
        </div>

        <div class="secondary-actions">
          <a href="#/hermes/personal-os/planning" class="secondary-link">{{ t('personalOS.openFullPlan') }}</a>
          <a href="#/hermes/personal-os/health" class="secondary-link">{{ t('personalOS.openHealth') }}</a>
        </div>
      </section>

      <div class="support-grid">
        <section class="panel">
          <span class="panel-kicker">{{ t('personalOS.reviewQueue') }}</span>
          <h3>{{ t('personalOS.pendingProposals') }}</h3>
          <p>{{ pendingProposals.length }} {{ t('personalOS.pending') }}</p>
        </section>
        <section class="panel">
          <span class="panel-kicker">{{ t('personalOS.execution') }}</span>
          <h3>{{ t('personalOS.tasks') }}</h3>
          <p>{{ tasks.length }} {{ t('personalOS.tasks') }}</p>
        </section>
      </div>
    </NSpin>
  </div>
</template>

<style scoped lang="scss">
.personal-os-view {
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

.header-subtitle {
  margin: 6px 0 0;
  color: var(--text-color-2);
}

.command-center {
  display: grid;
  gap: 16px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  padding: 18px;
}

.command-main,
.fallback-row,
.secondary-actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.command-main p,
.next-action-card p {
  margin: 6px 0 0;
  color: var(--text-color-2);
  line-height: 1.55;
}

.mode-pill,
.secondary-link {
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 4px 10px;
  color: var(--text-color-2);
  text-decoration: none;
}

.next-action-card {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 16px;

  h3 {
    margin: 4px 0 0;
    font-size: 24px;
  }
}

.fallback-row {
  margin-top: 14px;
  color: var(--text-color-3);

  strong {
    color: var(--text-color);
  }
}

.quick-log-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.quick-log-input {
  display: grid;
  gap: 6px;
  min-width: 0;

  span {
    color: var(--text-color-3);
    font-size: 12px;
  }

  input {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid var(--border-color);
    border-radius: 8px;
    background: var(--input-color, var(--card-color));
    color: var(--text-color);
    font: inherit;
    min-height: 34px;
    padding: 6px 10px;
    outline: none;
  }

  input:focus {
    border-color: var(--primary-color);
  }
}

.signal-strip,
.support-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.signal-item {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;

  strong {
    display: block;
    margin-top: 4px;
  }

  small {
    color: var(--text-color-3);
  }
}

.support-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 16px;
}

.panel {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  padding: 16px;
}

.panel-kicker {
  color: var(--text-color-3);
  font-size: 12px;
  text-transform: uppercase;
}

.metric-label {
  color: var(--text-color-3);
  font-size: 12px;
}


@media (max-width: 900px) {
  .personal-os-view {
    padding: 16px;
  }

  .command-main,
  .fallback-row,
  .secondary-actions {
    flex-direction: column;
  }

  .quick-log-form {
    grid-template-columns: 1fr;
  }

  .signal-strip,
  .support-grid {
    grid-template-columns: 1fr;
  }
}
</style>
