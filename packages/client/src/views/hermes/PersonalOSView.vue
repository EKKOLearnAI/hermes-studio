<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NButton, NSpin, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useProfilesStore } from '@/stores/hermes/profiles'
import {
  approvePersonalStateProposal,
  checkInPersonalStateTask,
  fetchPersonalStateOverview,
  rejectPersonalStateProposal,
  type PersonalProposal,
  type PersonalStateOverview,
  type PersonalTask,
} from '@/api/hermes/personal-state'

const { t } = useI18n()
const message = useMessage()
const profilesStore = useProfilesStore()

const loading = ref(false)
const actionId = ref<string | null>(null)
const overview = ref<PersonalStateOverview | null>(null)

const activeProfile = computed(() => profilesStore.activeProfileName || 'default')
const pendingProposals = computed(() => overview.value?.pendingProposals || [])
const tasks = computed(() => overview.value?.tasks || [])
const recentProposals = computed(() => overview.value?.proposals || [])
const memorySummary = computed(() => overview.value?.memoryContext.summary || t('personalOS.emptyMemory'))

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
    overview.value = await fetchPersonalStateOverview({ profile: activeProfile.value })
  } catch (err: any) {
    message.error(`${t('personalOS.loadFailed')}: ${err.message}`)
  } finally {
    loading.value = false
  }
}

async function reviewProposal(proposal: PersonalProposal, approved: boolean) {
  actionId.value = proposal.id
  try {
    if (approved) {
      await approvePersonalStateProposal(proposal.id, activeProfile.value)
      message.success(t('personalOS.approved'))
    } else {
      await rejectPersonalStateProposal(proposal.id, activeProfile.value)
      message.success(t('personalOS.rejected'))
    }
    await loadOverview()
  } catch (err: any) {
    message.error(`${t('personalOS.reviewFailed')}: ${err.message}`)
  } finally {
    actionId.value = null
  }
}

async function checkIn(task: PersonalTask) {
  actionId.value = task.id
  try {
    await checkInPersonalStateTask(task.id, activeProfile.value)
    message.success(t('personalOS.taskCheckedIn'))
    await loadOverview()
  } catch (err: any) {
    message.error(`${t('personalOS.taskCheckInFailed')}: ${err.message}`)
  } finally {
    actionId.value = null
  }
}

function statusClass(status: string) {
  return `status-${status.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

function confidenceLabel(proposal: PersonalProposal) {
  return `${Math.round(proposal.provenance.confidence * 100)}%`
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
      <div class="personal-grid">
        <section class="panel memory-panel">
          <div class="panel-header">
            <span class="panel-kicker">{{ activeProfile }}</span>
            <h3>{{ t('personalOS.memoryContext') }}</h3>
          </div>
          <p class="memory-summary">{{ memorySummary }}</p>
          <div class="metric-row">
            <div>
              <span class="metric-value">{{ pendingProposals.length }}</span>
              <span class="metric-label">{{ t('personalOS.pending') }}</span>
            </div>
            <div>
              <span class="metric-value">{{ tasks.length }}</span>
              <span class="metric-label">{{ t('personalOS.tasks') }}</span>
            </div>
            <div>
              <span class="metric-value">{{ recentProposals.length }}</span>
              <span class="metric-label">{{ t('personalOS.proposals') }}</span>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <span class="panel-kicker">{{ t('personalOS.reviewQueue') }}</span>
            <h3>{{ t('personalOS.pendingProposals') }}</h3>
          </div>
          <div v-if="pendingProposals.length === 0" class="empty-state">{{ t('personalOS.noPending') }}</div>
          <article v-for="proposal in pendingProposals" :key="proposal.id" class="proposal-row">
            <div class="row-main">
              <div class="row-title">{{ proposal.title }}</div>
              <div class="row-summary">{{ proposal.summary }}</div>
              <div class="row-meta">
                <span :class="['pill', statusClass(proposal.riskLevel)]">{{ proposal.riskLevel }}</span>
                <span>{{ proposal.provenance.source }}</span>
                <span>{{ confidenceLabel(proposal) }}</span>
              </div>
            </div>
            <div class="row-actions">
              <NButton
                size="small"
                type="primary"
                :loading="actionId === proposal.id"
                data-test="approve-proposal"
                @click="reviewProposal(proposal, true)"
              >
                {{ t('personalOS.approve') }}
              </NButton>
              <NButton size="small" quaternary :disabled="actionId === proposal.id" @click="reviewProposal(proposal, false)">
                {{ t('personalOS.reject') }}
              </NButton>
            </div>
          </article>
        </section>

        <section class="panel">
          <div class="panel-header">
            <span class="panel-kicker">{{ t('personalOS.execution') }}</span>
            <h3>{{ t('personalOS.tasks') }}</h3>
          </div>
          <div v-if="tasks.length === 0" class="empty-state">{{ t('personalOS.noTasks') }}</div>
          <article v-for="task in tasks" :key="task.id" class="task-row">
            <div>
              <div class="row-title">{{ task.title }}</div>
              <div class="row-summary">{{ task.notes }}</div>
              <div class="row-meta">
                <span :class="['pill', statusClass(task.status)]">{{ task.status }}</span>
                <span>{{ task.provenance.source }}</span>
              </div>
            </div>
            <NButton v-if="task.status !== 'done'" size="small" quaternary :loading="actionId === task.id" @click="checkIn(task)">
              {{ t('personalOS.checkIn') }}
            </NButton>
          </article>
        </section>

        <section class="panel">
          <div class="panel-header">
            <span class="panel-kicker">{{ t('personalOS.history') }}</span>
            <h3>{{ t('personalOS.proposals') }}</h3>
          </div>
          <div v-if="recentProposals.length === 0" class="empty-state">{{ t('personalOS.noProposals') }}</div>
          <article v-for="proposal in recentProposals" :key="proposal.id" class="history-row">
            <div class="row-title">{{ proposal.title }}</div>
            <div class="row-meta">
              <span :class="['pill', statusClass(proposal.status)]">{{ proposal.status }}</span>
              <span>{{ proposal.proposedAction.type }}</span>
            </div>
          </article>
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

.personal-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
  gap: 16px;
}

.panel {
  min-width: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--card-color);
  padding: 16px;
}

.memory-panel {
  grid-column: 1 / -1;
}

.panel-header {
  margin-bottom: 14px;

  h3 {
    margin: 2px 0 0;
    font-size: 16px;
  }
}

.panel-kicker {
  color: var(--text-color-3);
  font-size: 12px;
  text-transform: uppercase;
}

.memory-summary {
  margin: 0;
  color: var(--text-color-2);
  line-height: 1.6;
}

.metric-row {
  display: flex;
  gap: 24px;
  margin-top: 16px;

  > div {
    min-width: 72px;
  }
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

.proposal-row,
.task-row,
.history-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--border-color);
  padding: 14px 0;

  &:first-of-type {
    border-top: 0;
    padding-top: 0;
  }
}

.row-main {
  min-width: 0;
}

.row-title {
  font-weight: 650;
}

.row-summary {
  margin-top: 4px;
  color: var(--text-color-2);
  line-height: 1.45;
}

.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  color: var(--text-color-3);
  font-size: 12px;
}

.row-actions {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

.pill {
  border: 1px solid var(--border-color);
  border-radius: 999px;
  padding: 1px 8px;
  color: var(--text-color-2);
}

.status-approved,
.status-done,
.status-low {
  border-color: rgba(39, 174, 96, 0.45);
  color: #1e8e4d;
}

.status-pending,
.status-open,
.status-medium {
  border-color: rgba(242, 153, 74, 0.45);
  color: #b76b18;
}

.status-rejected,
.status-high {
  border-color: rgba(235, 87, 87, 0.45);
  color: #b33a3a;
}

.empty-state {
  color: var(--text-color-3);
  padding: 18px 0;
}

@media (max-width: 900px) {
  .personal-os-view {
    padding: 16px;
  }

  .personal-grid {
    grid-template-columns: 1fr;
  }

  .proposal-row,
  .task-row {
    flex-direction: column;
  }
}
</style>
