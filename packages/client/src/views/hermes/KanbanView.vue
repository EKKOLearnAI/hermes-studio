<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { NButton, NSelect, NSpin, NCollapse, NCollapseItem, NModal, NInput, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import KanbanTaskCard from '@/components/hermes/kanban/KanbanTaskCard.vue'
import KanbanTaskDrawer from '@/components/hermes/kanban/KanbanTaskDrawer.vue'
import KanbanCreateForm from '@/components/hermes/kanban/KanbanCreateForm.vue'
import { DEFAULT_KANBAN_BOARD, useKanbanStore } from '@/stores/hermes/kanban'
import type { KanbanTaskStatus } from '@/api/hermes/kanban'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const message = useMessage()
const kanbanStore = useKanbanStore()

const showCreateForm = ref(false)
const showCreateBoardForm = ref(false)
const selectedTaskId = ref<string | null>(null)
const newBoardSlug = ref('')
const newBoardName = ref('')
const boardActionLoading = ref(false)
const refreshTimer = ref<ReturnType<typeof setInterval> | null>(null)
const routeReady = ref(false)

const boardStatuses: KanbanTaskStatus[] = ['triage', 'todo', 'ready', 'running', 'blocked', 'done', 'archived']

function firstQueryString(value: unknown): string | null {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : null
  return typeof value === 'string' ? value : null
}

function routeBoard(): string | null {
  return firstQueryString(route.query.board)
}

async function replaceRouteBoard(board: string) {
  if (routeBoard() === board) return
  await router.replace({ query: { ...route.query, board } })
}

async function applyBoardSelection(candidate: string | null, notify = true, forceRefresh = false) {
  const previousBoard = kanbanStore.selectedBoard
  const { board, recovered } = kanbanStore.recoverSelectedBoard(candidate || kanbanStore.selectedBoard || DEFAULT_KANBAN_BOARD)
  selectedTaskId.value = null
  showCreateForm.value = false
  showCreateBoardForm.value = false
  if (notify && recovered && kanbanStore.boardWarning) message.warning(kanbanStore.boardWarning)
  await replaceRouteBoard(board)
  if (forceRefresh || board !== previousBoard) {
    await kanbanStore.refreshAll()
  }
}

function taskCountLabel(count: number): string {
  return `${t('kanban.stats.tasks')}: ${count}`
}

const boardOptions = computed(() => kanbanStore.activeBoards.map(board => {
  const count = typeof board.total === 'number' ? board.total : 0
  return {
    label: `${t('kanban.title')}: ${board.icon ? `${board.icon} ` : ''}${board.name || board.slug} · ${taskCountLabel(count)}`,
    value: board.slug,
  }
}))

const selectedBoardValue = computed({
  get: () => kanbanStore.selectedBoard,
  set: (value: string) => {
    void applyBoardSelection(value || DEFAULT_KANBAN_BOARD)
  },
})

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
    return { label: `${t('kanban.detail.assignee')}: ${a.name} · ${taskCountLabel(total)}`, value: a.name }
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

watch(() => route.query.board, async () => {
  if (!routeReady.value) return
  await applyBoardSelection(routeBoard(), false)
})

onMounted(async () => {
  await Promise.all([kanbanStore.fetchBoards(), kanbanStore.fetchCapabilities()])
  await applyBoardSelection(routeBoard(), true, true)
  routeReady.value = true
  refreshTimer.value = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void Promise.all([kanbanStore.fetchBoards(), kanbanStore.fetchTasks(true), kanbanStore.fetchStats()])
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
  await Promise.all([kanbanStore.fetchTasks(), kanbanStore.fetchStats(), kanbanStore.fetchBoards()])
}

async function handleCreateBoard() {
  const slug = newBoardSlug.value.trim()
  if (!slug) {
    message.warning(t('kanban.board.slugRequired'))
    return
  }
  boardActionLoading.value = true
  try {
    const board = await kanbanStore.createBoard({
      slug,
      name: newBoardName.value.trim() || undefined,
    })
    newBoardSlug.value = ''
    newBoardName.value = ''
    showCreateBoardForm.value = false
    await replaceRouteBoard(board.slug)
    message.success(t('kanban.board.created'))
  } catch (err: any) {
    message.error(err.message)
  } finally {
    boardActionLoading.value = false
  }
}

async function handleArchiveSelectedBoard() {
  if (kanbanStore.selectedBoard === DEFAULT_KANBAN_BOARD) return
  if (!window.confirm(t('kanban.board.archiveConfirm'))) return
  boardActionLoading.value = true
  try {
    await kanbanStore.archiveSelectedBoard()
    await replaceRouteBoard(DEFAULT_KANBAN_BOARD)
    message.success(t('kanban.board.archived'))
  } catch (err: any) {
    message.error(err.message)
  } finally {
    boardActionLoading.value = false
  }
}
</script>

<template>
  <div class="kanban-view">
    <header class="page-header">
      <h2 class="header-title">{{ t('kanban.title') }}</h2>
      <div class="header-actions">
        <NSelect
          v-model:value="selectedBoardValue"
          :options="boardOptions"
          :loading="kanbanStore.boardsLoading"
          size="small"
          style="width: 260px;"
        />
        <NButton size="small" :loading="boardActionLoading" @click="showCreateBoardForm = true">
          {{ t('common.add') }}
        </NButton>
        <NButton
          size="small"
          secondary
          :disabled="kanbanStore.selectedBoard === DEFAULT_KANBAN_BOARD"
          :loading="boardActionLoading"
          @click="handleArchiveSelectedBoard"
        >
          {{ t('kanban.board.archive') }}
        </NButton>
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

    <!-- Board management -->
    <NModal v-model:show="showCreateBoardForm" preset="dialog" :title="t('kanban.board.create')" style="width: 420px;">
      <div class="board-form">
        <NInput v-model:value="newBoardSlug" :placeholder="t('kanban.board.slugPlaceholder')" />
        <NInput v-model:value="newBoardName" :placeholder="t('kanban.board.namePlaceholder')" />
      </div>
      <template #action>
        <NButton @click="showCreateBoardForm = false">{{ t('common.cancel') }}</NButton>
        <NButton type="primary" :loading="boardActionLoading" @click="handleCreateBoard">{{ t('common.create') }}</NButton>
      </template>
    </NModal>

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

.board-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
}
</style>
