<script setup lang="ts">
/**
 * Live task board for one 群协作 run, rendered inline in the transcript where a
 * group chat would show the agent's reply.
 *
 * Parallelism is shown as one lane per digital human rather than as a
 * dependency graph: the story this surface has to tell is "five specialists are
 * working at the same time", and a lane per assignee says that at a glance
 * while a DAG buries it in edges.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import ProfileAvatar from '@/components/hermes/profiles/ProfileAvatar.vue'
import { useGroupChatStore } from '@/stores/hermes/group-chat'
import type { CollabTaskSnapshot } from '@/api/hermes/group-chat'

const props = defineProps<{
  sessionId: string
  coordinator?: string
  goal?: string
}>()

const { t } = useI18n()
const store = useGroupChatStore()

const session = computed(() => store.getCollabSessionById(props.sessionId))
const rootTask = computed(() => session.value?.tasks.find(task => task.isRoot) || null)
const childTasks = computed(() => (session.value?.tasks || []).filter(task => !task.isRoot))

/** One lane per assignee, ordered by first task creation so lanes stay stable. */
const lanes = computed(() => {
  const grouped = new Map<string, CollabTaskSnapshot[]>()
  for (const task of childTasks.value) {
    const key = task.assignee || ''
    const bucket = grouped.get(key)
    if (bucket) bucket.push(task)
    else grouped.set(key, [task])
  }
  return [...grouped.entries()]
    .map(([assignee, tasks]) => ({
      assignee,
      tasks,
      firstCreatedAt: Math.min(...tasks.map(task => task.createdAt)),
      running: tasks.some(task => task.status === 'running'),
    }))
    .sort((a, b) => a.firstCreatedAt - b.firstCreatedAt)
})

const runningCount = computed(() => childTasks.value.filter(task => task.status === 'running').length)

const progressPercent = computed(() => {
  const total = session.value?.totalChildren || 0
  if (total <= 0) return 0
  return Math.round(((session.value?.doneChildren || 0) / total) * 100)
})

const statusLabel = computed(() => {
  const status = session.value?.status || 'creating'
  return t(`groupCollab.status.${status}`)
})

function taskStatusLabel(status: string): string {
  const key = `groupCollab.taskStatus.${status}`
  const label = t(key)
  return label === key ? status : label
}

function displayName(assignee: string): string {
  return assignee || t('groupCollab.board.unassigned')
}

function elapsedText(task: CollabTaskSnapshot): string {
  const start = task.startedAt
  if (!start) return ''
  const end = task.completedAt || Math.floor(Date.now() / 1000)
  const seconds = Math.max(0, end - start)
  if (seconds < 60) return t('groupCollab.board.elapsed', { value: `${seconds}s` })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('groupCollab.board.elapsed', { value: `${minutes}m${seconds % 60}s` })
  return t('groupCollab.board.elapsed', { value: `${Math.floor(minutes / 60)}h${minutes % 60}m` })
}

// ─── Per-task execution log ──────────────────────────────────
//
// Logs are pulled on demand rather than streamed: a run can hold a dozen
// workers and pushing every one's stdout into the transcript would swamp both
// the socket and the reader. An expanded log refreshes while its task runs.

const expandedTaskIds = ref<Set<string>>(new Set())
const logs = ref<Map<string, { content: string; loading: boolean; error: string }>>(new Map())
let refreshTimer: ReturnType<typeof setInterval> | null = null

function isExpanded(taskId: string): boolean {
  return expandedTaskIds.value.has(taskId)
}

async function loadLog(taskId: string): Promise<void> {
  const previous = logs.value.get(taskId)
  logs.value.set(taskId, {
    content: previous?.content || '',
    loading: !previous?.content,
    error: '',
  })
  logs.value = new Map(logs.value)
  try {
    const log = await store.fetchCollabTaskLog(props.sessionId, taskId)
    logs.value.set(taskId, { content: log.content || '', loading: false, error: '' })
  } catch (err: any) {
    logs.value.set(taskId, {
      content: previous?.content || '',
      loading: false,
      error: err?.message || t('groupCollab.board.logFailed'),
    })
  }
  logs.value = new Map(logs.value)
}

function toggleLog(taskId: string): void {
  const next = new Set(expandedTaskIds.value)
  if (next.has(taskId)) {
    next.delete(taskId)
  } else {
    next.add(taskId)
    void loadLog(taskId)
  }
  expandedTaskIds.value = next
  syncRefreshTimer()
}

/** Keep a timer only while an expanded task is still producing output. */
function syncRefreshTimer(): void {
  const needsRefresh = [...expandedTaskIds.value].some(taskId => {
    const task = session.value?.tasks.find(candidate => candidate.id === taskId)
    return task && (task.status === 'running' || task.status === 'ready')
  })
  if (needsRefresh && !refreshTimer) {
    refreshTimer = setInterval(() => {
      for (const taskId of expandedTaskIds.value) void loadLog(taskId)
    }, 5000)
  } else if (!needsRefresh && refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

watch(() => session.value?.tasks.map(task => `${task.id}:${task.status}`).join(','), syncRefreshTimer)

onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
})
</script>

<template>
  <div v-if="session" class="collab-board" :class="`collab-board--${session.status}`">
    <div class="collab-header">
      <div class="collab-title-row">
        <span class="collab-title">{{ t('groupCollab.board.title') }}</span>
        <span class="collab-status" :class="`collab-status--${session.status}`">
          <span v-if="session.status === 'creating' || session.status === 'decomposing' || session.status === 'running'" class="collab-pulse" />
          {{ statusLabel }}
        </span>
        <span v-if="runningCount > 0" class="collab-parallel">
          {{ runningCount }} × {{ t('groupCollab.taskStatus.running') }}
        </span>
      </div>
      <p class="collab-goal">{{ session.goal || props.goal }}</p>
      <div class="collab-meta">
        <span class="collab-coordinator">
          <ProfileAvatar :name="session.coordinator || props.coordinator || ''" :size="18" />
          {{ t('groupCollab.board.coordinator') }} · {{ session.coordinator || props.coordinator }}
        </span>
        <span v-if="session.totalChildren > 0" class="collab-progress-text">
          {{ t('groupCollab.board.progress', { done: session.doneChildren, total: session.totalChildren }) }}
        </span>
      </div>
      <p v-if="session.workspace" class="collab-workspace" :title="session.workspace">
        {{ t('groupCollab.board.workspace') }}: <code>{{ session.workspace }}</code>
      </p>
      <div v-if="session.totalChildren > 0" class="collab-progress">
        <div class="collab-progress-fill" :style="{ width: `${progressPercent}%` }" />
      </div>
      <p v-if="session.error" class="collab-error">{{ session.error }}</p>
    </div>

    <!-- Root task: the coordinator's own decomposition + summary work. -->
    <div v-if="rootTask" class="collab-root">
      <span class="collab-root-badge">{{ t('groupCollab.board.rootTask') }}</span>
      <span class="collab-root-title">{{ rootTask.title }}</span>
      <span class="collab-task-status" :class="`collab-task-status--${rootTask.status}`">
        {{ taskStatusLabel(rootTask.status) }}
      </span>
    </div>

    <p v-if="childTasks.length === 0" class="collab-empty">{{ t('groupCollab.board.noTasks') }}</p>

    <template v-else>
      <div class="collab-lanes-header">
        <span class="collab-lanes-title">
          {{ t('groupCollab.board.children') }} · {{ childTasks.length }}
        </span>
        <span class="collab-lanes-hint">{{ t('groupCollab.board.parallelHint') }}</span>
      </div>

      <!-- One lane per digital human — the parallelism is the layout. -->
      <div class="collab-lanes">
        <div
          v-for="lane in lanes"
          :key="lane.assignee || 'unassigned'"
          class="collab-lane"
          :class="{ 'collab-lane--running': lane.running }"
        >
          <div class="collab-lane-head">
            <ProfileAvatar :name="lane.assignee" :size="24" />
            <span class="collab-lane-name">{{ displayName(lane.assignee) }}</span>
            <!-- A lane can hold several tasks; without a count two cards in
                 different states read as one person in two states at once. -->
            <span v-if="lane.tasks.length > 1" class="collab-lane-count">
              {{ t('groupCollab.board.laneTaskCount', { count: lane.tasks.length }) }}
            </span>
          </div>

          <div v-for="task in lane.tasks" :key="task.id" class="collab-task">
            <div class="collab-task-head">
              <span class="collab-task-status" :class="`collab-task-status--${task.status}`">
                <span v-if="task.status === 'running'" class="collab-pulse" />
                {{ taskStatusLabel(task.status) }}
              </span>
              <span v-if="elapsedText(task)" class="collab-task-elapsed">{{ elapsedText(task) }}</span>
            </div>
            <p class="collab-task-title">{{ task.title }}</p>
            <p v-if="task.blockedReason" class="collab-task-blocked">
              <strong>{{ t('groupCollab.board.blockedReason') }}</strong>{{ task.blockedReason }}
            </p>
            <p v-if="task.summary" class="collab-task-summary">{{ task.summary }}</p>

            <button class="collab-log-toggle" type="button" @click="toggleLog(task.id)">
              {{ isExpanded(task.id) ? t('groupCollab.board.hideLog') : t('groupCollab.board.viewLog') }}
            </button>

            <div v-if="isExpanded(task.id)" class="collab-log">
              <p v-if="logs.get(task.id)?.loading" class="collab-log-hint">{{ t('groupCollab.board.logLoading') }}</p>
              <p v-else-if="logs.get(task.id)?.error" class="collab-log-hint collab-log-hint--error">
                {{ logs.get(task.id)?.error }}
              </p>
              <pre v-else-if="logs.get(task.id)?.content" class="collab-log-body">{{ logs.get(task.id)?.content }}</pre>
              <p v-else class="collab-log-hint">{{ t('groupCollab.board.logEmpty') }}</p>
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
@use "@/styles/variables" as *;

.collab-board {
  border: 1px solid $border-color;
  border-radius: $radius-md;
  background: $bg-card;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 100%;
}

.collab-header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.collab-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.collab-title {
  font-weight: 600;
  font-size: 13px;
  color: $text-primary;
}

.collab-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.1);
  color: $accent-primary;

  &--done {
    background: rgba(34, 197, 94, 0.12);
    color: #16a34a;
  }

  &--failed {
    background: rgba(239, 68, 68, 0.12);
    color: #dc2626;
  }
}

.collab-parallel {
  font-size: 11px;
  color: $text-secondary;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px dashed $border-color;
}

.collab-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  animation: collab-pulse 1.4s ease-in-out infinite;
}

@keyframes collab-pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}

.collab-goal {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: $text-primary;
  word-break: break-word;
}

.collab-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: $text-secondary;
}

.collab-coordinator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.collab-workspace {
  margin: 0;
  font-size: 11px;
  color: $text-secondary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  code {
    font-family: $font-code;
    font-size: 10.5px;
  }
}

.collab-progress {
  height: 4px;
  border-radius: 999px;
  background: rgba(var(--accent-primary-rgb), 0.12);
  overflow: hidden;
}

.collab-progress-fill {
  height: 100%;
  border-radius: 999px;
  background: $accent-primary;
  transition: width $transition-fast;
}

.collab-error {
  margin: 0;
  font-size: 11.5px;
  color: #dc2626;
}

.collab-root {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 7px 10px;
  border-radius: $radius-sm;
  background: rgba(var(--accent-primary-rgb), 0.06);
  border: 1px solid rgba(var(--accent-primary-rgb), 0.14);
}

.collab-root-badge {
  font-size: 10.5px;
  font-weight: 600;
  color: $accent-primary;
  white-space: nowrap;
}

.collab-root-title {
  font-size: 12px;
  color: $text-primary;
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}

.collab-empty {
  margin: 0;
  font-size: 12px;
  color: $text-secondary;
}

.collab-lanes-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.collab-lanes-title {
  font-size: 11.5px;
  font-weight: 600;
  color: $text-primary;
}

.collab-lanes-hint {
  font-size: 10.5px;
  color: $text-secondary;
}

.collab-lanes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 8px;
}

.collab-lane {
  border: 1px solid $border-color;
  border-radius: $radius-sm;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  background: $bg-secondary;

  &--running {
    border-color: rgba(var(--accent-primary-rgb), 0.45);
  }
}

.collab-lane-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.collab-lane-name {
  font-size: 12px;
  font-weight: 600;
  color: $text-primary;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collab-lane-count {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10.5px;
  color: $text-muted;
  border: 1px solid $border-color;
  border-radius: 999px;
  padding: 0 6px;
  line-height: 16px;
}

.collab-task {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding-top: 6px;
  border-top: 1px dashed $border-color;
}

.collab-task-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.collab-task-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  background: $bg-card-hover;
  color: $text-secondary;

  &--running {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &--done {
    background: rgba(34, 197, 94, 0.12);
    color: #16a34a;
  }

  &--blocked {
    background: rgba(239, 68, 68, 0.12);
    color: #dc2626;
  }
}

.collab-task-elapsed {
  font-size: 10.5px;
  color: $text-secondary;
}

.collab-task-title {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: $text-primary;
  word-break: break-word;
}

.collab-task-blocked {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: $warning;
  word-break: break-word;

  strong {
    font-weight: 600;
    margin-right: 4px;
  }
}

.collab-task-summary {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: $text-secondary;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.collab-log-toggle {
  align-self: flex-start;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 10.5px;
  color: $accent-primary;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
}

.collab-log {
  border-radius: $radius-sm;
  background: $bg-input;
  border: 1px solid $border-color;
  padding: 6px 8px;
  max-height: 220px;
  overflow: auto;
}

.collab-log-hint {
  margin: 0;
  font-size: 10.5px;
  color: $text-secondary;

  &--error {
    color: #dc2626;
  }
}

.collab-log-body {
  margin: 0;
  font-family: $font-code;
  font-size: 10.5px;
  line-height: 1.5;
  color: $text-primary;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
