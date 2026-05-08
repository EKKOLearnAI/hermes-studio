<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NDrawer, NDrawerContent, NButton, NSelect, NInput, NSpin, NModal, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { request } from '@/api/client'
import { getTask } from '@/api/hermes/kanban'
import { useKanbanStore } from '@/stores/hermes/kanban'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import type { Session, Message } from '@/stores/hermes/chat'
import type { KanbanTaskDetail } from '@/api/hermes/kanban'

const props = defineProps<{
  taskId: string | null
}>()

const emit = defineEmits<{
  close: []
  updated: []
}>()

const { t } = useI18n()
const router = useRouter()
const message = useMessage()
const kanbanStore = useKanbanStore()

const detail = ref<KanbanTaskDetail | null>(null)
const loading = ref(false)
const assignProfile = ref<string | null>(null)
const blockReason = ref('')
const showBlockInput = ref(false)
const completeSummary = ref('')
const showCompleteInput = ref(false)
const showMessagesModal = ref(false)

const completionSummary = computed(() => {
  if (!detail.value) return ''
  return detail.value.task.result || detail.value.latest_summary || ''
})

const localizedTaskStatus = computed(() => {
  if (!detail.value) return ''
  return t(`kanban.columns.${detail.value.task.status}`, detail.value.task.status)
})

const sessionResults = ref<any[]>([])
const sessionLoading = ref(false)
const showSessions = ref(false)

const latestRunProfile = computed(() => {
  if (!detail.value) return null
  return [...detail.value.runs].reverse().find(run => run.profile)?.profile || null
})

async function searchTaskSessions() {
  if (!detail.value) return
  const profile = latestRunProfile.value
  if (!profile) return
  showSessions.value = !showSessions.value
  if (!showSessions.value) return
  sessionLoading.value = true
  try {
    const res = await request<{ results: any[] }>(
      `/api/hermes/kanban/search-sessions?task_id=${encodeURIComponent(detail.value.task.id)}&profile=${encodeURIComponent(profile)}`
    )
    sessionResults.value = res.results
  } catch {
    sessionResults.value = []
  } finally {
    sessionLoading.value = false
  }
}

function openResultDetail() {
  if (detail.value?.session) {
    showMessagesModal.value = true
  }
}

const historySession = computed<Session | null>(() => {
  const s = detail.value?.session
  if (!s) return null
  return {
    id: s.id,
    title: s.title || '',
    source: s.source,
    messages: s.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .map(m => ({
        id: String(m.id),
        role: m.role as Message['role'],
        content: m.content,
        timestamp: m.timestamp,
      })),
    createdAt: s.started_at,
    updatedAt: s.ended_at || s.started_at,
    model: s.model,
    messageCount: s.messages.length,
    endedAt: s.ended_at,
  }
})

const assigneeOptions = computed(() => {
  return kanbanStore.assignees.map(a => {
    const total = Object.values(a.counts || {}).reduce((s, c) => s + c, 0)
    return { label: `${a.name} (${total})`, value: a.name }
  })
})

watch(() => props.taskId, async (id) => {
  if (!id) {
    detail.value = null
    return
  }
  loading.value = true
  try {
    detail.value = await getTask(id)
  } catch (err: any) {
    message.error(t('kanban.message.loadFailed'))
  } finally {
    loading.value = false
  }
}, { immediate: true })

function formatTime(ts: number | null) {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

async function handleComplete() {
  if (!props.taskId) return
  if (!showCompleteInput.value) {
    showCompleteInput.value = true
    return
  }
  try {
    await kanbanStore.completeTasks([props.taskId], completeSummary.value.trim() || undefined)
    message.success(t('kanban.message.taskCompleted'))
    showCompleteInput.value = false
    completeSummary.value = ''
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleBlock() {
  if (!props.taskId || !blockReason.value.trim()) return
  try {
    await kanbanStore.blockTask(props.taskId, blockReason.value.trim())
    message.success(t('kanban.message.taskBlocked'))
    showBlockInput.value = false
    blockReason.value = ''
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleUnblock() {
  if (!props.taskId) return
  try {
    await kanbanStore.unblockTasks([props.taskId])
    message.success(t('kanban.message.taskUnblocked'))
    emit('updated')
    emit('close')
  } catch (err: any) {
    message.error(err.message)
  }
}

async function handleAssign() {
  if (!props.taskId || !assignProfile.value) return
  try {
    await kanbanStore.assignTask(props.taskId, assignProfile.value)
    message.success(t('kanban.message.taskAssigned'))
    assignProfile.value = null
    if (detail.value) {
      detail.value = await getTask(props.taskId)
    }
    emit('updated')
  } catch (err: any) {
    message.error(err.message)
  }
}
</script>

<template>
  <NDrawer :show="!!taskId" :width="420" placement="right" @update:show="(v: boolean) => { if (!v) emit('close') }">
    <NDrawerContent :title="detail?.task.title || ''" closable>
      <NSpin :show="loading">
        <template v-if="detail">
          <!-- Metadata -->
          <div class="detail-section">
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.status') }}</span>
              <span class="detail-value status-badge" :class="detail.task.status">{{ localizedTaskStatus }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.assignee') }}</span>
              <span class="detail-value">{{ detail.task.assignee || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.priority') }}</span>
              <span class="detail-value">{{ detail.task.priority }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.tenant') }}</span>
              <span class="detail-value">{{ detail.task.tenant || '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.createdAt') }}</span>
              <span class="detail-value">{{ formatTime(detail.task.created_at) }}</span>
            </div>
            <div v-if="detail.task.started_at" class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.startedAt') }}</span>
              <span class="detail-value">{{ formatTime(detail.task.started_at) }}</span>
            </div>
            <div v-if="detail.task.completed_at" class="detail-row">
              <span class="detail-label">{{ t('kanban.detail.completedAt') }}</span>
              <span class="detail-value">{{ formatTime(detail.task.completed_at) }}</span>
            </div>
          </div>

          <!-- Body -->
          <div v-if="detail.task.body" class="detail-section">
            <div class="section-title">{{ t('kanban.form.body') }}</div>
            <div class="detail-body">{{ detail.task.body }}</div>
          </div>

          <!-- Result / Summary -->
          <div v-if="completionSummary" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.result') }}</div>
            <div class="result-summary" @click="openResultDetail">{{ completionSummary }}</div>
          </div>

          <!-- Actions (only for non-completed tasks) -->
          <div v-if="detail.task.status !== 'done'" class="detail-section">
            <div class="section-title">{{ t('kanban.action.title') }}</div>
            <div class="action-group">
              <template v-if="!showCompleteInput">
                <NButton size="small" @click="showCompleteInput = true">
                  {{ t('kanban.action.complete') }}
                </NButton>
              </template>
              <div v-else class="complete-input">
                <NInput v-model:value="completeSummary" size="small" :placeholder="t('kanban.action.completeSummary')" />
                <NButton size="small" type="primary" @click="handleComplete">{{ t('common.ok') }}</NButton>
                <NButton size="small" @click="showCompleteInput = false; completeSummary = ''">{{ t('common.cancel') }}</NButton>
              </div>
              <template v-if="detail.task.status === 'blocked'">
                <NButton size="small" @click="handleUnblock">{{ t('kanban.action.unblock') }}</NButton>
              </template>
              <template v-else>
                <NButton v-if="!showBlockInput" size="small" @click="showBlockInput = true">{{ t('kanban.action.block') }}</NButton>
                <div v-else class="block-input">
                  <NInput v-model:value="blockReason" size="small" :placeholder="t('kanban.action.blockReason')" />
                  <NButton size="small" type="primary" @click="handleBlock">{{ t('common.ok') }}</NButton>
                </div>
              </template>
            </div>
            <div v-if="detail.task.status !== 'running'" class="assign-group">
              <NSelect v-model:value="assignProfile" :options="assigneeOptions" size="small" :placeholder="t('kanban.action.assignTo')" style="flex: 1;" />
              <NButton size="small" :disabled="!assignProfile" @click="handleAssign">{{ t('kanban.action.assign') }}</NButton>
            </div>
          </div>

          <!-- Related Sessions -->
          <div v-if="detail.runs.length > 0" class="detail-section">
            <div class="section-title" style="cursor: pointer;" @click="searchTaskSessions">
              {{ t('kanban.detail.sessions') }}
              <NSpin v-if="sessionLoading" :size="12" style="margin-left: 6px;" />
            </div>
            <div v-if="showSessions && sessionResults.length > 0" class="session-list">
              <div v-for="session in sessionResults" :key="session.id" class="session-item" @click="router.push({ name: 'hermes.chat', query: { session: session.id } })">
                <div class="session-title">{{ session.title || session.id }}</div>
                <div class="session-meta">
                  <span>{{ session.source }}</span>
                  <span>{{ session.model }}</span>
                  <span>{{ formatTime(session.started_at) }}</span>
                </div>
              </div>
            </div>
            <div v-if="showSessions && !sessionLoading && sessionResults.length === 0" class="column-empty">{{ t('kanban.detail.noSessions') }}</div>
          </div>

          <!-- Runs -->
          <div v-if="detail.runs.length > 0" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.runs') }}</div>
            <div v-for="run in detail.runs" :key="run.id" class="run-item">
              <div class="run-header">
                <span class="run-status" :class="run.status">{{ run.status }}</span>
                <span class="run-profile">{{ run.profile || '—' }}</span>
                <span class="run-time">{{ formatTime(run.started_at) }}</span>
              </div>
              <div v-if="run.summary" class="run-summary">{{ run.summary }}</div>
              <div v-if="run.error" class="run-error">{{ run.error }}</div>
            </div>
          </div>

          <!-- Comments -->
          <div v-if="detail.comments.length > 0" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.comments') }}</div>
            <div v-for="comment in detail.comments" :key="comment.id" class="comment-item">
              <div class="comment-header">
                <span class="comment-author">{{ comment.author }}</span>
                <span class="comment-time">{{ formatTime(comment.created_at) }}</span>
              </div>
              <div class="comment-body">{{ comment.body }}</div>
            </div>
          </div>

          <!-- Events -->
          <div v-if="detail.events.length > 0" class="detail-section">
            <div class="section-title">{{ t('kanban.detail.events') }}</div>
            <div v-for="event in detail.events.slice(-10)" :key="event.id" class="event-item">
              <span class="event-kind">{{ event.kind }}</span>
              <span class="event-time">{{ formatTime(event.created_at) }}</span>
            </div>
          </div>
        </template>
      </NSpin>
    </NDrawerContent>
  </NDrawer>

  <!-- Session messages modal (click result summary) -->
  <NModal v-if="historySession" :show="showMessagesModal" preset="card" :title="detail?.task.title || ''" :style="{ width: '900px', maxWidth: 'calc(100vw - 48px)' }" @close="showMessagesModal = false">
    <div class="messages-modal-body">
      <HistoryMessageList :session="historySession" />
    </div>
  </NModal>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.detail-section {
  margin-bottom: 20px;
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 10px;
}

.result-summary {
  cursor: pointer;
  border-radius: $radius-sm;
  padding: 8px 10px;
  background: rgba(var(--accent-primary-rgb), 0.04);
  border: 1px solid $border-light;
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.5;
  transition: border-color $transition-fast;

  &:hover { border-color: rgba(var(--accent-primary-rgb), 0.3); }
}

.result-detail {
  margin-top: 10px;
  padding: 10px;
  background: rgba(var(--accent-primary-rgb), 0.02);
  border: 1px solid $border-light;
  border-radius: $radius-sm;
}

.meta-label {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin: 8px 0 4px;

  &:first-child { margin-top: 0; }
}

.meta-list {
  list-style: none;
  padding: 0;
  margin: 0;

  li {
    font-size: 12px;
    color: $text-secondary;
    padding: 2px 0;

    code {
      font-family: $font-code;
      font-size: 11px;
      background: rgba(var(--accent-primary-rgb), 0.06);
      padding: 1px 4px;
      border-radius: 3px;
      word-break: break-all;
    }
  }
}

.meta-kv {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.meta-kv-row {
  display: flex;
  gap: 8px;
  font-size: 12px;
}

.meta-kv-key {
  color: $text-muted;
  font-family: $font-code;
  font-size: 11px;
  min-width: 100px;
  flex-shrink: 0;
}

.meta-kv-val {
  color: $text-secondary;
}

.artifact-link {
  cursor: pointer;
  transition: color $transition-fast;

  &:hover { color: $accent-primary; }
}

.artifact-modal-body,
.messages-modal-body {
  max-height: 65vh;
  overflow: hidden;
  padding: 4px 0;

  :deep(.message-list) {
    max-height: 65vh;
    background: transparent;
    padding: 0;
  }
}

.detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  border-bottom: 1px solid $border-light;
}

.detail-label {
  font-size: 12px;
  color: $text-muted;
}

.detail-value {
  font-size: 12px;
  color: $text-primary;
}

.status-badge {
  padding: 1px 8px;
  border-radius: 4px;
  font-weight: 500;

  &.running {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.done {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.blocked {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }

  &.ready {
    background: rgba(var(--warning-rgb), 0.12);
    color: $warning;
  }

  &.triage, &.archived {
    background: rgba(128, 128, 128, 0.12);
    color: $text-muted;
  }
}

.detail-body {
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.action-group {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.block-input,
.complete-input {
  display: flex;
  gap: 6px;
  flex: 1;
}

.assign-group {
  display: flex;
  gap: 8px;
}

.run-item,
.comment-item {
  padding: 8px 0;
  border-bottom: 1px solid $border-light;

  &:last-child {
    border-bottom: none;
  }
}

.run-header,
.comment-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.run-status {
  font-size: 11px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;

  &.running {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $accent-primary;
  }

  &.done, &.completed {
    background: rgba(var(--success-rgb), 0.12);
    color: $success;
  }

  &.crashed, &.failed {
    background: rgba(var(--error-rgb), 0.12);
    color: $error;
  }
}

.run-profile,
.comment-author {
  font-size: 12px;
  font-weight: 500;
  color: $text-primary;
}

.run-time,
.comment-time {
  font-size: 11px;
  color: $text-muted;
  margin-left: auto;
}

.run-summary,
.run-error,
.comment-body {
  font-size: 12px;
  color: $text-secondary;
  line-height: 1.4;
}

.run-error {
  color: $error;
}

.event-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.event-kind {
  font-size: 11px;
  font-family: $font-code;
  color: $accent-primary;
}

.event-time {
  font-size: 11px;
  color: $text-muted;
  margin-left: auto;
}

.session-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-item {
  padding: 8px 10px;
  border-radius: $radius-sm;
  border: 1px solid $border-light;
  cursor: pointer;
  transition: border-color $transition-fast;

  &:hover { border-color: rgba(var(--accent-primary-rgb), 0.3); }
}

.session-title {
  font-size: 13px;
  font-weight: 500;
  color: $text-primary;
  margin-bottom: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-meta {
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: $text-muted;
}

.session-messages {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.session-msg {
  padding: 10px 12px;
  border-radius: $radius-sm;
  border: 1px solid $border-light;

  &.user {
    background: rgba(var(--accent-primary-rgb), 0.04);
  }

  &.assistant {
    background: transparent;
  }
}

.session-msg-role {
  font-size: 11px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  margin-bottom: 6px;
}

.session-msg-content {
  font-size: 13px;
  color: $text-secondary;
  line-height: 1.5;

  :deep(p) {
    margin: 0 0 8px;

    &:last-child { margin-bottom: 0; }
  }
}
</style>
