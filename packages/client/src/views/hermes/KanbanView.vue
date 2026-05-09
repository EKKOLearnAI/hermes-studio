<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { NButton, NSelect, NSpin, NCollapse, NCollapseItem } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import KanbanTaskCard from '@/components/hermes/kanban/KanbanTaskCard.vue'
import KanbanTaskDrawer from '@/components/hermes/kanban/KanbanTaskDrawer.vue'
import KanbanCreateForm from '@/components/hermes/kanban/KanbanCreateForm.vue'
import { useKanbanStore } from '@/stores/hermes/kanban'
import type { KanbanTaskStatus } from '@/api/hermes/kanban'

const { t } = useI18n()
const kanbanStore = useKanbanStore()

const showCreateForm = ref(false)
const selectedTaskId = ref<string | null>(null)
const refreshTimer = ref<ReturnType<typeof setInterval> | null>(null)

const boardStatuses: KanbanTaskStatus[] = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived']

const tasksByStatus = computed(() => {
  const grouped: Record<string, typeof kanbanStore.tasks> = {}
  for (const status of boardStatuses) {
    grouped[status] = kanbanStore.tasks
      .filter(t => t.status === status)
      .sort((a, b) => b.created_at - a.created_at)
  }
  return grouped
})

const statusFilterOptions = computed(() => [
  { label: t('kanban.allStatuses'), value: '' },
  ...boardStatuses.map(s => ({ label: t(`kanban.columns.${s}`, s), value: s })),
])

const assigneeFilterOptions = computed(() => [
  { label: t('kanban.allAssignees'), value: '' },
  ...kanbanStore.assignees.map(a => {
    const total = Object.values(a.counts || {}).reduce((s, c) => s + c, 0)
    return { label: `${a.name} (${total})`, value: a.name }
  }),
])

const filterStatusValue = computed({
  get: () => kanbanStore.filterStatus || '',
  set: (v: string) => kanbanStore.setFilter('status', v || null),
})

const filterAssigneeValue = computed({
  get: () => kanbanStore.filterAssignee || '',
  set: (v: string) => kanbanStore.setFilter('assignee', v || null),
})

onMounted(async () => {
  await kanbanStore.refreshAll()
  refreshTimer.value = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void Promise.all([kanbanStore.fetchTasks(true), kanbanStore.fetchStats()])
    }
  }, 15000)
})

onUnmounted(() => {
  if (refreshTimer.value) clearInterval(refreshTimer.value)
})

function handleTaskClick(taskId: string) {
  selectedTaskId.value = taskId
}

function handleDrawerClose() {
  selectedTaskId.value = null
}

async function handleDrawerUpdated() {
  await Promise.all([kanbanStore.fetchTasks(), kanbanStore.fetchStats()])
}

async function handleApplyFilter() {
  await kanbanStore.fetchTasks()
}

async function handleTaskCreated() {
  await Promise.all([kanbanStore.fetchTasks(), kanbanStore.fetchStats()])
}
</script>

<template>
  <div class="kanban-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('kanban.title') }}</h2>
      <div class="header-actions">
        <NSelect
          v-model:value="filterStatusValue"
          :options="statusFilterOptions"
          size="small"
          style="width: 150px;"
          @update:value="handleApplyFilter"
        />
        <NSelect
          v-model:value="filterAssigneeValue"
          :options="assigneeFilterOptions"
          size="small"
          style="width: 170px;"
          @update:value="handleApplyFilter"
        />
        <NButton type="primary" size="small" @click="showCreateForm = true">
          <template #icon>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </template>
          {{ t('kanban.createTask') }}
        </NButton>
      </div>
    </header>

    <!-- Stats bar -->
    <div v-if="kanbanStore.stats" class="stats-bar">
      <div v-for="status in boardStatuses" :key="status" class="stat-chip" :class="status">
        <span class="stat-count">{{ kanbanStore.stats.by_status[status] || 0 }}</span>
        <span class="stat-label">{{ t(`kanban.columns.${status}`, status) }}</span>
      </div>
      <div class="stat-chip total">
        <span class="stat-count">{{ kanbanStore.stats.total }}</span>
        <span class="stat-label">{{ t('kanban.stats.total') }}</span>
      </div>
    </div>

    <!-- Board -->
    <NSpin :show="kanbanStore.loading && kanbanStore.tasks.length === 0">
      <div class="kanban-board">
        <NCollapse>
          <NCollapseItem
            v-for="status in boardStatuses"
            :key="status"
            :title="`${t(`kanban.columns.${status}`, status)} (${tasksByStatus[status].length})`"
            :name="status"
          >
            <div class="task-list">
              <KanbanTaskCard
                v-for="task in tasksByStatus[status]"
                :key="task.id"
                :task="task"
                @click="handleTaskClick(task.id)"
              />
              <div v-if="tasksByStatus[status].length === 0" class="column-empty">
                {{ t('kanban.noTasks') }}
              </div>
            </div>
          </NCollapseItem>
        </NCollapse>
      </div>
    </NSpin>

    <!-- Task detail drawer -->
    <KanbanTaskDrawer
      :task-id="selectedTaskId"
      @close="handleDrawerClose"
      @updated="handleDrawerUpdated"
    />

    <!-- Create form -->
    <KanbanCreateForm
      v-if="showCreateForm"
      @close="showCreateForm = false"
      @created="handleTaskCreated"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.kanban-view {
  height: calc(100 * var(--vh));
  display: flex;
  flex-direction: column;
}

.page-header {
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
}

.header-title {
  font-size: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.stats-bar {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  flex-shrink: 0;
  flex-wrap: wrap;
}

.stat-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  border: 1px solid $border-light;

  &.triage, &.todo, &.ready { border-left: 3px solid $text-muted; }
  &.running { border-left: 3px solid $accent-primary; }
  &.blocked { border-left: 3px solid $error; }
  &.done { border-left: 3px solid $success; }
  &.archived { border-left: 3px solid $border-color; }
  &.total { border-left: 3px solid $text-primary; }
}

.stat-count {
  font-weight: 600;
  color: $text-primary;
}

.stat-label {
  color: $text-muted;
}

.kanban-board {
  padding: 14px 20px 20px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.column-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  font-size: 12px;
  color: $text-muted;
}

@media (max-width: $breakpoint-mobile) {
  .page-header {
    padding: 16px 12px 16px 52px;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .header-actions {
    flex-wrap: wrap;
    width: 100%;
  }

  .kanban-board {
    padding: 0 12px 12px;
  }
}
</style>
