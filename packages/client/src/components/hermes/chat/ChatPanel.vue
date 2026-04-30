<script setup lang="ts">
import { renameSession, setSessionWorkspace } from '@/api/hermes/sessions'
import { useChatStore, type Session } from '@/stores/hermes/chat'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { NButton, NDropdown, NInput, NModal, NTooltip, useMessage } from 'naive-ui'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { getSourceLabel } from '@/shared/session-display'
import { copyToClipboard } from '@/utils/clipboard'
import FolderPicker from './FolderPicker.vue'
import ChatInput from './ChatInput.vue'
import ConversationMonitorPane from './ConversationMonitorPane.vue'
import MessageList from './MessageList.vue'
import SessionListItem from './SessionListItem.vue'

const chatStore = useChatStore()
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore()
const message = useMessage()
const { t } = useI18n()

const currentMode = ref<'chat' | 'live'>('chat')

// Initialize synchronously from the media query so first paint is correct.
// On narrow viewports the session list is an absolute-positioned overlay
// (z-index 10) on top of the chat area; if we default to `true`, onMounted
// only flips it to `false` AFTER the first render, causing a visible flash
// where the session list covers the chat content ("auto-fixes after a
// moment" — that was the race).
const showSessions = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
let mobileQuery: MediaQueryList | null = null
const isMobile = ref(false)

function handleSessionClick(sessionId: string) {
  chatStore.switchSession(sessionId)
  if (mobileQuery?.matches) showSessions.value = false
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches
  if (e.matches && showSessions.value) {
    showSessions.value = false
  }
}

onMounted(() => {
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
  sortSessionsWithActiveFirst(chatStore.sessions.filter(session => sessionBrowserPrefsStore.isPinned(session.id))),
)

const groupedSessions = computed<SessionGroup[]>(() => {
  const map = new Map<string, Session[]>()
  for (const s of chatStore.sessions) {
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
      chatStore.switchSession(group.sessions[0].id)
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
  collapsedGroups.value = new Set(groups.slice(1).map(group => group.source))
  localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]))
}, { once: true })

watch(
  () => [chatStore.sessionsLoaded, ...chatStore.sessions.map(session => session.id)],
  value => {
    const sessionIds = value.slice(1) as string[]
    if (!value[0] || sessionIds.length === 0) return
    sessionBrowserPrefsStore.pruneMissingSessions(sessionIds)
  },
  { immediate: true },
)

const activeSessionTitle = computed(() =>
  chatStore.activeSession?.title || t('chat.newChat'),
)

const headerTitle = computed(() =>
  currentMode.value === 'live' ? t('chat.liveSessions') : activeSessionTitle.value,
)

const activeSessionSource = computed(() =>
  currentMode.value === 'chat' ? (chatStore.activeSession?.source || '') : '',
)

function handleNewChat() {
  chatStore.newChat()
}

async function copySessionId(id?: string) {
  const sessionId = id || chatStore.activeSessionId
  if (sessionId) {
    const ok = await copyToClipboard(sessionId)
    if (ok) message.success(t('common.copied'))
    else message.error(t('common.copied') + ' ✗')
  }
}

function handleDeleteSession(id: string) {
  sessionBrowserPrefsStore.removePinned(id)
  chatStore.deleteSession(id)
  message.success(t('chat.sessionDeleted'))
}

const contextSessionId = ref<string | null>(null)
const contextSessionPinned = computed(() =>
  contextSessionId.value ? sessionBrowserPrefsStore.isPinned(contextSessionId.value) : false,
)

const contextMenuOptions = computed(() => [
  { label: t(contextSessionPinned.value ? 'chat.unpin' : 'chat.pin'), key: 'pin' },
  { label: t('chat.rename'), key: 'rename' },
  { label: t('chat.setWorkspace'), key: 'workspace' },
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

function handleContextMenuSelect(key: string) {
  showContextMenu.value = false
  if (!contextSessionId.value) return
  if (key === 'pin') {
    sessionBrowserPrefsStore.togglePinned(contextSessionId.value)
    return
  }
  if (key === 'copy-id') {
    copySessionId(contextSessionId.value)
  } else if (key === 'workspace') {
    const session = chatStore.sessions.find(s => s.id === contextSessionId.value)
    workspaceSessionId.value = contextSessionId.value
    workspaceValue.value = session?.workspace || ''
    showWorkspaceModal.value = true
  } else if (key === 'rename') {
    const session = chatStore.sessions.find(s => s.id === contextSessionId.value)
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
    const session = chatStore.sessions.find(s => s.id === renameSessionId.value)
    if (session) session.title = renameValue.value.trim()
    if (chatStore.activeSession?.id === renameSessionId.value) {
      chatStore.activeSession.title = renameValue.value.trim()
    }
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
    const session = chatStore.sessions.find(s => s.id === workspaceSessionId.value)
    if (session) session.workspace = workspaceValue.value || null
    if (chatStore.activeSession?.id === workspaceSessionId.value) {
      chatStore.activeSession.workspace = workspaceValue.value || null
    }
    message.success(t('chat.workspaceSet'))
  } else {
    message.error(t('chat.workspaceSetFailed'))
  }
  showWorkspaceModal.value = false
}
</script>

<template>
  <div class="chat-panel">
    <div v-if="currentMode === 'chat'" class="session-backdrop" :class="{ active: showSessions }" @click="showSessions = false" />
    <aside v-if="currentMode === 'chat'" class="session-list" :class="{ collapsed: !showSessions }">
      <div class="session-list-header">
        <span v-if="showSessions" class="session-list-title">{{ t('chat.sessions') }}</span>
        <div class="session-list-actions">
          <button class="session-close-btn" @click="showSessions = false">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <NButton quaternary size="tiny" @click="handleNewChat" circle>
            <template #icon>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </template>
          </NButton>
        </div>
      </div>
      <div v-if="showSessions" class="session-items">
        <div v-if="chatStore.isLoadingSessions && chatStore.sessions.length === 0" class="session-loading">{{ t('common.loading') }}</div>
        <div v-else-if="chatStore.sessions.length === 0" class="session-empty">{{ t('chat.noSessions') }}</div>

        <template v-if="pinnedSessions.length > 0">
          <div class="session-group-header session-group-header--static">
            <span class="session-group-label">{{ t('chat.pinned') }}</span>
            <span class="session-group-count">{{ pinnedSessions.length }}</span>
          </div>
          <SessionListItem
            v-for="s in pinnedSessions"
            :key="`pinned-${s.id}`"
            :session="s"
            :active="s.id === chatStore.activeSessionId"
            :pinned="true"
            :can-delete="s.id !== chatStore.activeSessionId || chatStore.sessions.length > 1"
            :streaming="chatStore.isSessionLive(s.id)"
            @select="handleSessionClick(s.id)"
            @contextmenu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id)"
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
              :active="s.id === chatStore.activeSessionId"
              :pinned="false"
              :can-delete="s.id !== chatStore.activeSessionId || chatStore.sessions.length > 1"
              :streaming="chatStore.isSessionLive(s.id)"
              @select="handleSessionClick(s.id)"
              @contextmenu="handleContextMenu($event, s.id)"
              @delete="handleDeleteSession(s.id)"
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
          <NButton v-if="currentMode === 'chat'" quaternary size="small" @click="showSessions = !showSessions" circle>
            <template #icon>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </template>
          </NButton>
          <span class="header-session-title">{{ headerTitle }}</span>
          <span v-if="activeSessionSource" class="source-badge">{{ getSourceLabel(activeSessionSource) }}</span>
          <span v-if="chatStore.activeSession?.workspace" class="workspace-badge" :title="chatStore.activeSession.workspace">📁 {{ chatStore.activeSession.workspace.split('/').pop() || chatStore.activeSession.workspace }}</span>
        </div>
        <div class="header-actions">
          <!-- chat/live mode toggle hidden -->
          <template v-if="currentMode === 'chat'">
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
            <NButton size="small" :circle="isMobile" @click="handleNewChat">
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </template>
              <template v-if="!isMobile">{{ t('chat.newChat') }}</template>
            </NButton>
          </template>
        </div>
      </header>

      <template v-if="currentMode === 'chat'">
        <MessageList />
        <ChatInput />
      </template>
      <ConversationMonitorPane v-else :human-only="sessionBrowserPrefsStore.humanOnly" />
    </div>
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.chat-panel {
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

.chat-mode-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-right: 4px;
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
