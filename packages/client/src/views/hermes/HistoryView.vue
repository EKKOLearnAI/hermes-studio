<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { NButton, NDropdown, NInput, NModal, NTooltip, useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getSourceLabel } from '@/shared/session-display'
import { copyToClipboard } from '@/utils/clipboard'
import FolderPicker from '@/components/hermes/chat/FolderPicker.vue'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'
import { renameSession, setSessionWorkspace, fetchHermesSessions, fetchHermesSession, exportSession, type SessionSummary } from '@/api/hermes/sessions'

const chatStore = useChatStore()
const appStore = useAppStore()
const profilesStore = useProfilesStore()
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore()
const message = useMessage()
const { t } = useI18n()

// Hermes history sessions (exclude api_server)
const hermesSessions = ref<SessionSummary[]>([])
const hermesSessionsLoading = ref(false)
const hermesSessionsLoaded = ref(false)
// History page's own selected session (independent from chatStore)
const historySessionId = ref<string | null>(null)
const historySession = ref<Session | null>(null)

async function loadHermesSessions() {
  if (hermesSessionsLoading.value) return
  hermesSessionsLoading.value = true
  try {
    hermesSessions.value = await fetchHermesSessions()
    hermesSessionsLoaded.value = true
  } catch (err) {
    console.error('Failed to load Hermes sessions:', err)
  } finally {
    hermesSessionsLoading.value = false
  }
}

// Initialize synchronously from the media query so first paint is correct.
const showSessions = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
let mobileQuery: MediaQueryList | null = null
const isMobile = ref(false)

async function handleSessionClick(sessionId: string) {
  // First, fetch the Hermes session detail
  const sessionDetail = await fetchHermesSession(sessionId)
  if (!sessionDetail) {
    message.error(t('chat.sessionNotFound'))
    return
  }

  // Convert SessionDetail to Session format and add to chatStore
  const sessionData: Session = {
    id: sessionDetail.id,
    title: sessionDetail.title || '',
    source: sessionDetail.source,
    createdAt: sessionDetail.started_at * 1000,
    updatedAt: (sessionDetail.last_active || sessionDetail.started_at) * 1000,
    model: sessionDetail.model,
    messageCount: sessionDetail.message_count,
    inputTokens: sessionDetail.input_tokens,
    outputTokens: sessionDetail.output_tokens,
    endedAt: sessionDetail.ended_at ? sessionDetail.ended_at * 1000 : undefined,
    lastActiveAt: sessionDetail.last_active ? sessionDetail.last_active * 1000 : undefined,
    workspace: sessionDetail.workspace || undefined,
    messages: sessionDetail.messages.map(m => {
      const msg: any = {
        id: String(m.id),
        sessionId: m.session_id,
        role: m.role,
        content: m.content || '',
        timestamp: m.timestamp * 1000,
      }

      // Preserve tool-related fields
      if (m.role === 'tool') {
        msg.toolName = m.tool_name
        msg.toolArgs = m.tool_calls?.[0]?.function?.arguments
          ? JSON.stringify(m.tool_calls[0].function.arguments)
          : undefined
        msg.toolStatus = 'done'
      }

      // Preserve reasoning field
      if (m.reasoning) {
        msg.reasoning = m.reasoning
      }

      return msg
    }),
  }

  // Set history page's own session state (independent from chatStore)
  historySessionId.value = sessionData.id
  historySession.value = sessionData

  if (mobileQuery?.matches) showSessions.value = false
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches
  if (e.matches && showSessions.value) {
    showSessions.value = false
  }
}

onMounted(async () => {
  appStore.loadModels()
  await profilesStore.fetchProfiles()
  await loadHermesSessions()

  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
})

const showRenameModal = ref(false)
const renameValue = ref('')
const renameSessionId = ref<string | null>(null)
const renameInputRef = ref<InstanceType<typeof NInput> | null>(null)
const collapsedGroups = ref<Set<string>>(new Set(JSON.parse(localStorage.getItem('hermes_collapsed_groups') || '[]')))

// Convert SessionSummary to Session format
function sessionSummaryToSession(summary: SessionSummary): Session {
  return {
    id: summary.id,
    title: summary.title || '',
    source: summary.source,
    createdAt: summary.started_at * 1000,
    updatedAt: (summary.last_active || summary.started_at) * 1000,
    model: summary.model,
    messageCount: summary.message_count,
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    endedAt: summary.ended_at ? summary.ended_at * 1000 : undefined,
    lastActiveAt: summary.last_active ? summary.last_active * 1000 : undefined,
    workspace: summary.workspace || undefined,
    messages: [],
  }
}

// Computed sessions from Hermes API
const historySessions = computed<Session[]>(() =>
  hermesSessions.value.map(sessionSummaryToSession)
)

// Source sort order: api_server first, cron last, others alphabetical
function sourceSortKey(source: string): number {
  if (source === 'api_server') return -1
  if (source === 'cron') return 999
  return 0
}

function sortSessionsWithActiveFirst(items: Session[]): Session[] {
  return [...items].sort((a, b) => {
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
}

// Group sessions by source, with sort order
interface SessionGroup {
  source: string
  label: string
  sessions: Session[]
}

const pinnedSessions = computed(() =>
  sortSessionsWithActiveFirst(historySessions.value.filter(session => sessionBrowserPrefsStore.isPinned(session.id))),
)

const groupedSessions = computed<SessionGroup[]>(() => {
  const map = new Map<string, Session[]>()
  for (const s of historySessions.value) {
    if (sessionBrowserPrefsStore.isPinned(s.id)) continue
    const key = s.source || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(s)
  }

  const keys = [...map.keys()].sort((a, b) => {
    const ka = sourceSortKey(a)
    const kb = sourceSortKey(b)
    if (ka !== kb) return ka - kb
    return a.localeCompare(b)
  })

  return keys.map(key => ({
    source: key,
    label: key ? getSourceLabel(key) : t('chat.other'),
    sessions: sortSessionsWithActiveFirst(map.get(key)!),
  }))
})

function toggleGroup(source: string) {
  const isExpanded = !collapsedGroups.value.has(source)
  if (isExpanded) {
    collapsedGroups.value = new Set([...collapsedGroups.value, source])
  } else {
    collapsedGroups.value = new Set(
      groupedSessions.value.map(g => g.source).filter(s => s !== source),
    )
    const group = groupedSessions.value.find(g => g.source === source)
    if (group?.sessions.length) {
      // Auto-select and load first session when expanding group
      handleSessionClick(group.sessions[0].id)
    }
  }
  localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]))
}

watch(groupedSessions, groups => {
  if (localStorage.getItem('hermes_collapsed_groups') !== null) {
    const activeSource = chatStore.activeSession?.source
    if (activeSource && collapsedGroups.value.has(activeSource)) {
      collapsedGroups.value = new Set([...collapsedGroups.value].filter(source => source !== activeSource))
      localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]))
    }
    return
  }
  // Default: collapse all groups except the first one
  if (groups.length > 0) {
    collapsedGroups.value = new Set(groups.slice(1).map(group => group.source))
    localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]))
  }
}, { once: true })

// Auto-load first CLI session when Hermes sessions are loaded
watch(hermesSessionsLoaded, (loaded) => {
  if (loaded && hermesSessions.value.length > 0) {
    // Only auto-load if no session is currently active
    if (!historySessionId.value || !hermesSessions.value.find(s => s.id === historySessionId.value)) {
      // Find first CLI session
      const firstCliSession = hermesSessions.value.find(s => s.source === 'cli')
      if (firstCliSession) {
        // Ensure the CLI group is expanded
        if (collapsedGroups.value.has('cli')) {
          collapsedGroups.value = new Set([...collapsedGroups.value].filter(s => s !== 'cli'))
        }
        // Load session details
        handleSessionClick(firstCliSession.id)
      }
      // If no CLI session exists, don't auto-load any session
    }
  }
}, { once: true })

const activeSessionTitle = computed(() =>
  historySession.value?.title || t('chat.newChat'),
)

const activeSessionSource = computed(() =>
  historySession.value?.source || '',
)

async function copySessionId(id?: string) {
  const sessionId = id || historySessionId.value
  if (sessionId) {
    const ok = await copyToClipboard(sessionId)
    if (ok) message.success(t('common.copied'))
    else message.error(t('common.copied') + ' ✗')
  }
}

const contextSessionId = ref<string | null>(null)
const contextSessionPinned = computed(() =>
  contextSessionId.value ? sessionBrowserPrefsStore.isPinned(contextSessionId.value) : false,
)

const contextMenuOptions = computed(() => [
  { label: t(contextSessionPinned.value ? 'chat.unpin' : 'chat.pin'), key: 'pin' },
  { label: t('chat.rename'), key: 'rename' },
  { label: t('chat.setWorkspace'), key: 'workspace' },
  {
    label: t('chat.export'),
    key: 'export',
    children: [
      {
        label: t('chat.exportFull'),
        key: 'export-full',
        children: [
          { label: 'JSON', key: 'export-full-json' },
          { label: 'TXT', key: 'export-full-txt' },
        ],
      },
      {
        label: t('chat.exportCompressed'),
        key: 'export-compressed',
        children: [
          { label: 'JSON', key: 'export-compressed-json' },
          { label: 'TXT', key: 'export-compressed-txt' },
        ],
      },
    ],
  },
  { label: t('chat.copySessionId'), key: 'copy-id' },
])

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault()
  contextSessionId.value = sessionId
  showContextMenu.value = true
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
}

const showContextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)

function parseExportKey(key: string): { mode: 'full' | 'compressed'; ext: 'json' | 'txt' } | null {
  if (key === 'export-full-json') return { mode: 'full', ext: 'json' }
  if (key === 'export-full-txt') return { mode: 'full', ext: 'txt' }
  if (key === 'export-compressed-json') return { mode: 'compressed', ext: 'json' }
  if (key === 'export-compressed-txt') return { mode: 'compressed', ext: 'txt' }
  return null
}

async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false
  if (!contextSessionId.value) return
  if (key === 'pin') {
    sessionBrowserPrefsStore.togglePinned(contextSessionId.value)
    return
  }
  if (key === 'copy-id') {
    copySessionId(contextSessionId.value)
  } else if (parseExportKey(key)) {
    const { mode, ext } = parseExportKey(key)!
    const loadingMsg = mode === 'compressed' ? message.loading(t('chat.exportCompressing'), { duration: 0 }) : null
    try {
      await exportSession(contextSessionId.value, mode, ext)
      loadingMsg?.destroy()
      message.success(t('chat.exportSuccess'))
    } catch {
      loadingMsg?.destroy()
      message.error(t('chat.exportFailed'))
    }
  } else if (key === 'workspace') {
    const session = historySessions.value.find(s => s.id === contextSessionId.value)
    workspaceSessionId.value = contextSessionId.value
    workspaceValue.value = session?.workspace || ''
    showWorkspaceModal.value = true
  } else if (key === 'rename') {
    const session = historySessions.value.find(s => s.id === contextSessionId.value)
    renameSessionId.value = contextSessionId.value
    renameValue.value = session?.title || ''
    showRenameModal.value = true
    nextTick(() => {
      renameInputRef.value?.focus()
    })
  }
}

function handleClickOutside() {
  showContextMenu.value = false
}

async function handleRenameConfirm() {
  if (!renameSessionId.value || !renameValue.value.trim()) return
  const ok = await renameSession(renameSessionId.value, renameValue.value.trim())
  if (ok) {
    // Reload Hermes sessions to get updated title
    await loadHermesSessions()
    message.success(t('chat.renamed'))
  } else {
    message.error(t('chat.renameFailed'))
  }
  showRenameModal.value = false
}

const showWorkspaceModal = ref(false)
const workspaceValue = ref('')
const workspaceSessionId = ref<string | null>(null)

async function handleWorkspaceConfirm() {
  if (!workspaceSessionId.value) return
  const ok = await setSessionWorkspace(workspaceSessionId.value, workspaceValue.value || null)
  if (ok) {
    // Reload Hermes sessions to get updated workspace
    await loadHermesSessions()
    message.success(t('chat.workspaceSet'))
  } else {
    message.error(t('chat.workspaceSetFailed'))
  }
  showWorkspaceModal.value = false
}
</script>

<template>
  <div class="history-panel">
    <div class="session-backdrop" :class="{ active: showSessions }" @click="showSessions = false" />
    <aside class="session-list" :class="{ collapsed: !showSessions }">
      <div class="session-list-header">
        <span v-if="showSessions" class="session-list-title">{{ t('chat.hermesHistory') }}</span>
        <div class="session-list-actions">
          <button class="session-close-btn" @click="showSessions = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>
      <div v-if="showSessions" class="session-scope-note">
        {{ t('chat.historyScopeHint') }}
      </div>
      <div v-if="showSessions" class="session-items">
        <div v-if="hermesSessionsLoading && hermesSessions.length === 0" class="session-loading">{{ t('common.loading') }}</div>
        <div v-else-if="hermesSessions.length === 0" class="session-empty">{{ t('chat.noSessions') }}</div>

        <template v-if="pinnedSessions.length > 0">
          <div class="session-group-header session-group-header--static">
            <span class="session-group-label">{{ t('chat.pinned') }}</span>
            <span class="session-group-count">{{ pinnedSessions.length }}</span>
          </div>
          <SessionListItem
            v-for="s in pinnedSessions"
            :key="`pinned-${s.id}`"
            :session="s"
            :active="s.id === historySessionId"
            :pinned="true"
            :can-delete="false"
            :streaming="false"
            @select="handleSessionClick(s.id)"
            @contextmenu="handleContextMenu($event, s.id)"
          />
        </template>

        <template v-for="group in groupedSessions" :key="group.source">
          <div class="session-group-header" @click="toggleGroup(group.source)">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="group-chevron" :class="{ collapsed: collapsedGroups.has(group.source) }"><polyline points="9 18 15 12 9 6"/></svg>
            <span class="session-group-label">{{ group.label }}</span>
            <span class="session-group-count">{{ group.sessions.length }}</span>
          </div>
          <template v-if="!collapsedGroups.has(group.source)">
            <SessionListItem
              v-for="s in group.sessions"
              :key="s.id"
              :session="s"
              :active="s.id === historySessionId"
              :pinned="false"
              :can-delete="false"
              :streaming="false"
              @select="handleSessionClick(s.id)"
              @contextmenu="handleContextMenu($event, s.id)"
            />
          </template>
        </template>
      </div>
    </aside>

    <NDropdown
      placement="bottom-start"
      trigger="manual"
      :x="contextMenuX"
      :y="contextMenuY"
      :options="contextMenuOptions"
      :show="showContextMenu"
      @select="handleContextMenuSelect"
      @clickoutside="handleClickOutside"
    />

    <NModal
      v-model:show="showRenameModal"
      preset="dialog"
      :title="t('chat.renameSession')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      @positive-click="handleRenameConfirm"
    >
      <NInput
        ref="renameInputRef"
        v-model:value="renameValue"
        :placeholder="t('chat.enterNewTitle')"
        @keydown.enter="handleRenameConfirm"
      />
    </NModal>

    <NModal
      v-model:show="showWorkspaceModal"
      preset="dialog"
      :title="t('chat.setWorkspaceTitle')"
      :positive-text="t('common.ok')"
      :negative-text="t('common.cancel')"
      style="width: 520px"
      @positive-click="handleWorkspaceConfirm"
    >
      <FolderPicker v-model="workspaceValue" />
    </NModal>

    <div class="chat-main">
      <header class="chat-header">
        <div class="header-left">
          <NButton quaternary size="small" @click="showSessions = !showSessions" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </template>
          </NButton>
          <span class="header-session-title">{{ activeSessionTitle }}</span>
          <span v-if="activeSessionSource" class="source-badge">{{ getSourceLabel(activeSessionSource) }}</span>
          <span v-if="historySession?.workspace" class="workspace-badge" :title="historySession.workspace">📁 {{ historySession.workspace.split('/').pop() || historySession.workspace }}</span>
        </div>
        <div class="header-actions">
          <NTooltip trigger="hover">
            <template #trigger>
              <NButton quaternary size="small" @click="copySessionId()" circle>
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.copySessionId') }}
          </NTooltip>
        </div>
      </header>

      <HistoryMessageList :session="historySession" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.history-panel {
  display: flex;
  height: 100%;
  position: relative;
}

.session-list {
  width: 220px;
  border-right: 1px solid $border-color;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  transition: width $transition-normal, opacity $transition-normal;
  overflow: hidden;

  &.collapsed {
    width: 0;
    border-right: none;
    opacity: 0;
    pointer-events: none;
  }

  @media (max-width: $breakpoint-mobile) {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    z-index: 10;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: 280px;

    &.collapsed {
      transform: translateX(-100%);
      opacity: 0;
    }
  }
}

@media (max-width: $breakpoint-mobile) {
  .session-close-btn {
    display: flex;
  }

  .session-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    z-index: 9;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.session-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  flex-shrink: 0;
}

.session-list-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.session-close-btn {
  display: none;
  border: none;
  background: none;
  cursor: pointer;
  color: $text-secondary;
  padding: 4px;
  border-radius: $radius-sm;

  &:hover {
    background: rgba($accent-primary, 0.06);
  }
}

.session-list-title {
  font-size: 12px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-scope-note {
  margin: 0 12px 10px;
  padding: 8px 10px;
  border: 1px solid rgba($accent-primary, 0.16);
  border-radius: $radius-sm;
  background: rgba($accent-primary, 0.06);
  color: $text-secondary;
  font-size: 11px;
  line-height: 1.45;
}

.session-group-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 4px;
  cursor: pointer;
  user-select: none;
}

.session-group-header--static {
  cursor: default;
}

.group-chevron {
  flex-shrink: 0;
  transition: transform 0.15s ease;
  transform: rotate(90deg);

  &.collapsed {
    transform: rotate(0deg);
  }
}

.session-group-label {
  font-size: 10px;
  font-weight: 600;
  color: $text-muted;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.session-group-count {
  font-size: 10px;
  color: $text-muted;
  font-weight: 400;
}

.session-items {
  flex: 1;
  overflow-y: auto;
  padding: 0 6px 12px;
}

.session-loading,
.session-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: $text-muted;
  text-align: center;
}

:deep(.session-item) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  border: none;
  background: none;
  border-radius: $radius-sm;
  cursor: pointer;
  text-align: left;
  color: $text-secondary;
  transition: all $transition-fast;
  margin-bottom: 2px;

  &:hover {
    background: rgba($accent-primary, 0.06);
    color: $text-primary;

    .session-item-delete {
      opacity: 1;
    }
  }

  &.active {
    background: rgba(var(--accent-primary-rgb), 0.12);
    color: $text-primary;
    font-weight: 500;
  }

  &.active .session-item-title {
    color: $accent-primary;
  }
}

:deep(.session-item-content) {
  flex: 1;
  overflow: hidden;
}

:deep(.session-item-title-row) {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

:deep(.session-item-title) {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.session-item-streaming) {
  display: inline-block;
  flex-shrink: 0;
  margin-right: 4px;
  vertical-align: middle;
  animation: spin 1.2s linear infinite;
  color: $accent-primary;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

:deep(.session-item-pin) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: $accent-primary;
}

:deep(.session-item-time) {
  font-size: 11px;
  color: $text-muted;
}

:deep(.session-item-meta) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

:deep(.session-item-model) {
  font-size: 10px;
  color: $accent-primary;
  background: rgba($accent-primary, 0.08);
  padding: 0 5px;
  border-radius: 3px;
  line-height: 16px;
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.session-item-delete) {
  flex-shrink: 0;
  opacity: 0.5;
  padding: 2px;
  border: none;
  background: none;
  color: $text-muted;
  cursor: pointer;
  border-radius: 3px;
  transition: all $transition-fast;

  &:hover {
    color: $error;
    background: rgba($error, 0.1);
  }
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 21px 20px;
  border-bottom: 1px solid $border-color;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  font-size: 10px;
  color: $text-muted;
  background: rgba($text-muted, 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  line-height: 16px;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

@media (max-width: $breakpoint-mobile) {
  .chat-header {
    padding: 16px 12px 16px 52px;
  }
}

.workspace-badge {
  font-size: 11px;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
</style>
