<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { type Session } from '@/stores/hermes/chat'
import { useAppStore } from '@/stores/hermes/app'
import { useProfilesStore } from '@/stores/hermes/profiles'
import { useSessionBrowserPrefsStore } from '@/stores/hermes/session-browser-prefs'
import { NButton, NDropdown, NPopconfirm, NTooltip, useMessage, type DropdownOption } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { getSourceLabel } from '@/shared/session-display'
import { copyToClipboard } from '@/utils/clipboard'
import HistoryMessageList from '@/components/hermes/chat/HistoryMessageList.vue'
import SessionListItem from '@/components/hermes/chat/SessionListItem.vue'
import OutlinePanel from '@/components/hermes/chat/OutlinePanel.vue'
import PageSidebarNav from '@/components/layout/PageSidebarNav.vue'
import PageSidebarFooter from '@/components/layout/PageSidebarFooter.vue'
import { batchDeleteSessions, deleteSession, fetchHermesSessions, fetchHermesSession, fetchSessionMessagesPage, importHermesSession, unarchiveSession, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'

const appStore = useAppStore()
const profilesStore = useProfilesStore()
const sessionBrowserPrefsStore = useSessionBrowserPrefsStore()
const message = useMessage()
const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const routeSessionId = computed(() => {
  const value = route.params.sessionId
  return typeof value === 'string' && value.trim() ? value : null
})

const routeProfile = computed(() => {
  const value = route.query.profile
  return typeof value === 'string' && value.trim() ? value : null
})

const effectiveHistoryProfile = computed(() => profilesStore.activeProfileName || routeProfile.value || null)

// Hermes history sessions (exclude api_server)
const hermesSessions = ref<SessionSummary[]>([])
const hermesSessionsLoading = ref(false)
const hermesSessionsLoaded = ref(false)
// History page's own selected session (independent from chatStore)
const historySessionId = ref<string | null>(null)
const historySession = ref<Session | null>(null)
const showOutline = ref(false)
const historyMessageListRef = ref<InstanceType<typeof HistoryMessageList> | null>(null)
const isBatchMode = ref(false)
const isBatchDeleting = ref(false)
const showBatchDeleteConfirm = ref(false)
const selectedSessionKeys = ref<Set<string>>(new Set())
const contextSessionId = ref<string | null>(null)
const showContextMenu = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
let hermesSessionsRequestId = 0

const HISTORY_PAGE_SIZE = 150

function handleOutlineNavigate(target: { messageId: string; anchorId: string }) {
  historyMessageListRef.value?.scrollToAnchor(target.messageId, target.anchorId)
  if (isMobile.value) showOutline.value = false
}

function openNewChatPage() {
  void router.push({ name: 'hermes.chat' })
}

async function loadHermesSessions() {
  const requestId = ++hermesSessionsRequestId
  hermesSessionsLoading.value = true
  try {
    const sessions = await fetchHermesSessions(undefined, undefined, effectiveHistoryProfile.value)
    if (requestId !== hermesSessionsRequestId) return
    hermesSessions.value = sessions
    hermesSessionsLoaded.value = true
  } catch (err) {
    console.error('Failed to load Hermes sessions:', err)
  } finally {
    if (requestId === hermesSessionsRequestId) {
      hermesSessionsLoading.value = false
    }
  }
}

// Initialize synchronously from the media query so first paint is correct.
const showSessions = ref(
  typeof window === 'undefined' || !window.matchMedia('(max-width: 768px)').matches,
)
let mobileQuery: MediaQueryList | null = null
const isMobile = ref(false)

function findHistorySession(sessionId: string): SessionSummary | undefined {
  return hermesSessions.value.find(session => session.id === sessionId)
}

const contextSessionSummary = computed(() =>
  contextSessionId.value ? findHistorySession(contextSessionId.value) || null : null,
)

const contextSessionPinned = computed(() =>
  contextSessionId.value ? sessionBrowserPrefsStore.isPinned(contextSessionId.value) : false,
)

const contextMenuOptions = computed<DropdownOption[]>(() => {
  const options: DropdownOption[] = [
    {
      label: t('chat.importToWebUi'),
      key: 'import-webui',
      disabled: Boolean(contextSessionSummary.value?.webui_imported),
    },
    { label: t(contextSessionPinned.value ? 'chat.unpin' : 'chat.pin'), key: 'pin' },
    ...(contextSessionSummary.value?.is_archived ? [{ label: t('chat.unarchiveSession'), key: 'unarchive' }] : []),
    { label: t('chat.copySessionLink'), key: 'copy-link' },
    { label: t('chat.copySessionId'), key: 'copy-id' },
  ]
  return options
})

function mapHistoryMessages(messages: HermesMessage[]): Session['messages'] {
  return messages.map(m => {
    const msg: Session['messages'][number] = {
      id: String(m.id),
      role: m.role,
      content: m.content || '',
      timestamp: m.timestamp * 1000,
      reasoning: m.reasoning || undefined,
      systemType: m.role === 'command' ? 'command' : undefined,
    }

    if (m.role === 'tool') {
      msg.toolName = m.tool_name || undefined
      msg.toolCallId = m.tool_call_id || undefined
      msg.toolArgs = m.tool_calls?.[0]?.function?.arguments
        ? JSON.stringify(m.tool_calls[0].function.arguments)
        : undefined
      msg.toolStatus = 'done'
      msg.toolResult = m.content || undefined
      msg.content = ''
    }

    return msg
  })
}

function codingAgentFields(summary: SessionSummary): Pick<Session, 'agent' | 'agentSessionId' | 'agentNativeSessionId' | 'codingAgentId' | 'codingAgentMode'> {
  const isCodingAgentSession = summary.source === 'coding_agent' || summary.agent === 'claude' || summary.agent === 'codex'
  return {
    agent: summary.agent || undefined,
    agentSessionId: summary.agent_session_id || undefined,
    agentNativeSessionId: summary.agent_native_session_id || undefined,
    codingAgentId: summary.agent === 'codex' ? 'codex' : summary.agent === 'claude' ? 'claude-code' : undefined,
    codingAgentMode: isCodingAgentSession
      ? (summary.agent_mode === 'global' || summary.agent_mode === 'scoped'
          ? summary.agent_mode
          : summary.provider === 'global' ? 'global' : 'scoped')
      : undefined,
  }
}

function sessionFromSummary(summary: SessionSummary, messages: Session['messages'] = []): Session {
  return {
    id: summary.id,
    profile: summary.profile || undefined,
    title: summary.title || '',
    source: summary.source,
    ...codingAgentFields(summary),
    createdAt: summary.started_at * 1000,
    updatedAt: (summary.last_active || summary.ended_at || summary.started_at) * 1000,
    model: summary.model,
    provider: summary.provider,
    messageCount: summary.message_count,
    messageTotal: summary.message_count,
    loadedMessageCount: messages.length,
    hasMoreBefore: false,
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    endedAt: summary.ended_at ? summary.ended_at * 1000 : undefined,
    lastActiveAt: summary.last_active ? summary.last_active * 1000 : undefined,
    isArchived: Boolean(summary.is_archived),
    workspace: summary.workspace || undefined,
    messages,
  }
}

async function loadHistorySession(sessionId: string, profile?: string | null) {
  const summary = findHistorySession(sessionId)
  const sessionProfile = profile || summary?.profile || null
  const page = await fetchSessionMessagesPage(sessionId, 0, HISTORY_PAGE_SIZE, sessionProfile)
  let sessionData: Session | null = null

  if (page) {
    const base = summary || page.session
    sessionData = sessionFromSummary(base, mapHistoryMessages(page.messages))
    sessionData.profile = summary?.profile || sessionProfile || undefined
    sessionData.messageCount = page.total
    sessionData.messageTotal = page.total
    sessionData.loadedMessageCount = page.messages.length
    sessionData.hasMoreBefore = page.hasMore
  } else {
    // Some imported/legacy Hermes sessions may only exist in Hermes state.db.
    // Keep the old full-detail path as a compatibility fallback.
    const sessionDetail = await fetchHermesSession(sessionId, sessionProfile)
    if (!sessionDetail) {
      message.error(t('chat.sessionNotFound'))
      return
    }

    sessionData = {
      id: sessionDetail.id,
      profile: sessionDetail.profile || sessionProfile || undefined,
      title: sessionDetail.title || '',
      source: sessionDetail.source,
      createdAt: sessionDetail.started_at * 1000,
      updatedAt: (sessionDetail.last_active || sessionDetail.started_at) * 1000,
      model: sessionDetail.model,
      provider: sessionDetail.provider,
      messageCount: sessionDetail.message_count,
      messageTotal: sessionDetail.message_count,
      loadedMessageCount: sessionDetail.messages.length,
      hasMoreBefore: false,
      inputTokens: sessionDetail.input_tokens,
      outputTokens: sessionDetail.output_tokens,
      endedAt: sessionDetail.ended_at ? sessionDetail.ended_at * 1000 : undefined,
      lastActiveAt: sessionDetail.last_active ? sessionDetail.last_active * 1000 : undefined,
      workspace: sessionDetail.workspace || undefined,
      messages: mapHistoryMessages(sessionDetail.messages),
    }
  }

  // Set history page's own session state (independent from chatStore)
  historySessionId.value = sessionData.id
  historySession.value = sessionData

  if (mobileQuery?.matches) showSessions.value = false
}

async function loadOlderHistoryMessages(sessionId: string): Promise<boolean> {
  const target = historySession.value
  if (!target || target.id !== sessionId || target.isLoadingOlderMessages || !target.hasMoreBefore) return false
  const offset = target.loadedMessageCount || 0
  target.isLoadingOlderMessages = true
  try {
    const page = await fetchSessionMessagesPage(sessionId, offset, HISTORY_PAGE_SIZE, target.profile)
    if (!page || page.messages.length === 0) {
      target.hasMoreBefore = false
      return false
    }

    const existingIds = new Set(target.messages.map(message => message.id))
    const olderMessages = mapHistoryMessages(page.messages).filter(message => !existingIds.has(message.id))
    target.messages = [...olderMessages, ...target.messages]
    target.loadedMessageCount = offset + page.messages.length
    target.messageTotal = page.total
    target.messageCount = page.total
    target.hasMoreBefore = page.hasMore
    return olderMessages.length > 0
  } catch (err) {
    console.error('Failed to load older history messages:', err)
    return false
  } finally {
    target.isLoadingOlderMessages = false
  }
}

async function handleSessionClick(sessionId: string, profile?: string | null) {
  await router.push({
    name: 'hermes.historySession',
    params: { sessionId },
    query: profile ? { profile } : undefined,
  })
}

async function openDefaultHistorySession(replace = false) {
  const firstCliSession = hermesSessions.value.find(s => s.source === 'cli')
  const firstSession = firstCliSession || hermesSessions.value[0]
  if (!firstSession) {
    historySessionId.value = null
    historySession.value = null
    if (routeSessionId.value) await router.replace({ name: 'hermes.history' })
    return
  }

  if (collapsedGroups.value.has(firstSession.source)) {
    collapsedGroups.value = new Set([...collapsedGroups.value].filter(source => source !== firstSession.source))
  }

  const location = {
    name: 'hermes.historySession',
    params: { sessionId: firstSession.id },
    query: firstSession.profile ? { profile: firstSession.profile } : undefined,
  }
  if (replace) await router.replace(location)
  else await router.push(location)
}

async function syncRouteSession() {
  const sessionId = routeSessionId.value
  if (!sessionId) return

  if (!hermesSessions.value.some(s => s.id === sessionId)) {
    historySessionId.value = null
    historySession.value = null
    await router.replace({ name: 'hermes.history' })
    return
  }

  const sessionProfile = routeProfile.value || findHistorySession(sessionId)?.profile || null
  const currentProfile = historySession.value?.profile || null
  if (historySessionId.value !== sessionId || currentProfile !== sessionProfile) {
    historySessionId.value = sessionId
    historySession.value = null
    await loadHistorySession(sessionId, sessionProfile)
  }
}

function handleMobileChange(e: MediaQueryListEvent | MediaQueryList) {
  isMobile.value = e.matches
  if (e.matches && showSessions.value) {
    showSessions.value = false
  }
}

function openPageSidebar() {
  showSessions.value = true
}

onMounted(async () => {
  appStore.loadModels()
  await profilesStore.fetchProfiles()
  await loadHermesSessions()
  await syncRouteSession()

  mobileQuery = window.matchMedia('(max-width: 768px)')
  handleMobileChange(mobileQuery)
  mobileQuery.addEventListener('change', handleMobileChange)
  window.addEventListener('hermes:open-page-sidebar', openPageSidebar)
})

onUnmounted(() => {
  mobileQuery?.removeEventListener('change', handleMobileChange)
  window.removeEventListener('hermes:open-page-sidebar', openPageSidebar)
})

watch([routeSessionId, routeProfile], async ([sessionId]) => {
  if (!sessionId) {
    historySessionId.value = null
    historySession.value = null
    return
  }
  if (!hermesSessionsLoaded.value) return
  if (routeProfile.value && !hermesSessions.value.some(s => s.profile === routeProfile.value)) {
    await loadHermesSessions()
  }
  await syncRouteSession()
})

watch(() => profilesStore.activeProfileName, async () => {
  if (!hermesSessionsLoaded.value) return
  if (profilesStore.switching) return
  historySessionId.value = null
  historySession.value = null
  await loadHermesSessions()
  await openDefaultHistorySession(true)
})

const collapsedGroups = ref<Set<string>>(new Set(JSON.parse(localStorage.getItem('hermes_collapsed_groups') || '[]')))

// Convert SessionSummary to Session format
function sessionSummaryToSession(summary: SessionSummary): Session {
  return {
    id: summary.id,
    profile: summary.profile || undefined,
    title: summary.title || '',
    source: summary.source,
    ...codingAgentFields(summary),
    createdAt: summary.started_at * 1000,
    updatedAt: (summary.last_active || summary.started_at) * 1000,
    model: summary.model,
    provider: summary.provider,
    messageCount: summary.message_count,
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    endedAt: summary.ended_at ? summary.ended_at * 1000 : undefined,
    lastActiveAt: summary.last_active ? summary.last_active * 1000 : undefined,
    isArchived: Boolean(summary.is_archived),
    workspace: summary.workspace || undefined,
    messages: [],
  }
}

// Computed sessions from Hermes API
const historySessions = computed<Session[]>(() =>
  hermesSessions.value.map(sessionSummaryToSession)
)

function sessionSelectionKey(session: Pick<Session, 'id' | 'profile'>): string {
  return `${session.profile || 'default'}\u0000${session.id}`
}

function toggleBatchMode() {
  if (isBatchDeleting.value) return
  isBatchMode.value = !isBatchMode.value
  if (!isBatchMode.value) {
    selectedSessionKeys.value.clear()
    showBatchDeleteConfirm.value = false
  }
}

function toggleSessionSelection(session: Session) {
  if (isBatchDeleting.value) return
  const key = sessionSelectionKey(session)
  if (selectedSessionKeys.value.has(key)) {
    selectedSessionKeys.value.delete(key)
  } else {
    selectedSessionKeys.value.add(key)
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value)
  if (selectedSessionKeys.value.size === 0) {
    showBatchDeleteConfirm.value = false
  }
}

function isSessionSelected(session: Session): boolean {
  return selectedSessionKeys.value.has(sessionSelectionKey(session))
}

function toggleSelectAllSessions() {
  if (isBatchDeleting.value) return
  if (allSessionsSelected.value) {
    selectedSessionKeys.value.clear()
    selectedSessionKeys.value = new Set(selectedSessionKeys.value)
    showBatchDeleteConfirm.value = false
    return
  }
  selectedSessionKeys.value.clear()
  for (const session of historySessions.value) {
    selectedSessionKeys.value.add(sessionSelectionKey(session))
  }
  selectedSessionKeys.value = new Set(selectedSessionKeys.value)
}

const selectedCount = computed(() => selectedSessionKeys.value.size)
const canSelectAll = computed(() => historySessions.value.length > 0)
const allSessionsSelected = computed(() =>
  historySessions.value.length > 0 && selectedSessionKeys.value.size === historySessions.value.length
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
      void handleSessionClick(group.sessions[0].id, group.sessions[0].profile)
    }
  }
  localStorage.setItem('hermes_collapsed_groups', JSON.stringify([...collapsedGroups.value]))
}

watch(groupedSessions, groups => {
  if (localStorage.getItem('hermes_collapsed_groups') !== null) {
    const activeSource = historySession.value?.source
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

// Auto-load the first CLI session when Hermes sessions are loaded.
watch(hermesSessionsLoaded, (loaded) => {
  if (loaded && hermesSessions.value.length > 0 && !routeSessionId.value) {
    void openDefaultHistorySession(false)
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

function historySessionProfile(sessionId: string): string | null {
  return historySession.value?.id === sessionId
    ? historySession.value.profile || null
    : findHistorySession(sessionId)?.profile || null
}

function buildHistorySessionUrl(sessionId: string, profile?: string | null) {
  const href = router.resolve({
    name: 'hermes.historySession',
    params: { sessionId },
    query: profile ? { profile } : undefined,
  }).href
  return `${window.location.origin}${window.location.pathname}${href}`
}

async function copySessionLink(id?: string) {
  const sessionId = id || historySessionId.value
  if (sessionId) {
    const ok = await copyToClipboard(buildHistorySessionUrl(sessionId, historySessionProfile(sessionId)))
    if (ok) message.success(t('common.copied'))
    else message.error(t('common.copied') + ' ✗')
  }
}

function handleContextMenu(e: MouseEvent, sessionId: string) {
  e.preventDefault()
  contextSessionId.value = sessionId
  showContextMenu.value = true
  contextMenuX.value = e.clientX
  contextMenuY.value = e.clientY
}

function handleClickOutside() {
  showContextMenu.value = false
}

async function handleImportToWebUi(sessionId: string) {
  const summary = findHistorySession(sessionId)
  try {
    const result = await importHermesSession(sessionId, summary?.profile || null)
    if (result.ok) {
      message.success(t(result.imported ? 'chat.importSessionSuccess' : 'chat.importSessionAlreadyExists'))
      await loadHermesSessions()
      return
    }
  } catch {
    // Fall through to the shared failure message.
  }
  message.error(t('chat.importSessionFailed'))
}

async function handleContextMenuSelect(key: string) {
  showContextMenu.value = false
  if (!contextSessionId.value) return
  if (key === 'pin') {
    sessionBrowserPrefsStore.togglePinned(contextSessionId.value)
  } else if (key === 'copy-link') {
    await copySessionLink(contextSessionId.value)
  } else if (key === 'copy-id') {
    await copySessionId(contextSessionId.value)
  } else if (key === 'import-webui') {
    await handleImportToWebUi(contextSessionId.value)
  } else if (key === 'unarchive') {
    const summary = contextSessionSummary.value
    if (!summary?.is_archived) return
    const ok = await unarchiveSession(contextSessionId.value)
    if (!ok) {
      message.error(t('chat.unarchiveSessionFailed'))
      return
    }
    message.success(t('chat.sessionUnarchived'))
    await loadHermesSessions()
    if (!findHistorySession(contextSessionId.value)) {
      historySessionId.value = null
      historySession.value = null
      await router.replace({ name: 'hermes.history' })
      await openDefaultHistorySession(true)
    }
  }
}

async function handleDeleteSession(id: string, profile?: string | null) {
  const summary = findHistorySession(id)
  const sessionProfile = profile || summary?.profile || null
  const ok = await deleteSession(id, sessionProfile)
  if (!ok) {
    message.error(t('common.deleteFailed'))
    return
  }

  sessionBrowserPrefsStore.removePinned(id)
  hermesSessions.value = hermesSessions.value.filter(s => s.id !== id)

  if (historySessionId.value === id) {
    historySessionId.value = null
    historySession.value = null
    const next = historySessions.value[0]
    if (next) await handleSessionClick(next.id, next.profile)
    else await router.replace({ name: 'hermes.history' })
  }

  message.success(t('chat.sessionDeleted'))
}

async function handleBatchDelete() {
  if (selectedSessionKeys.value.size === 0 || isBatchDeleting.value) return

  const sessionsByKey = new Map(historySessions.value.map(session => [sessionSelectionKey(session), session]))
  const targets = Array.from(selectedSessionKeys.value)
    .map(key => sessionsByKey.get(key))
    .filter((session): session is Session => Boolean(session))
    .map(session => ({ id: session.id, profile: session.profile || null }))
  if (targets.length === 0) return

  const activeWasSelected = historySession.value
    ? selectedSessionKeys.value.has(sessionSelectionKey(historySession.value))
    : false

  isBatchDeleting.value = true
  try {
    const result = await batchDeleteSessions(targets)
    if (result.deleted > 0) {
      for (const target of targets) {
        sessionBrowserPrefsStore.removePinned(target.id)
      }

      await loadHermesSessions()

      if (activeWasSelected || (historySessionId.value && !findHistorySession(historySessionId.value))) {
        historySessionId.value = null
        historySession.value = null
        await openDefaultHistorySession(true)
      }

      message.success(t('chat.batchDeleteSuccess', { count: result.deleted }))
      if (result.failed > 0) {
        message.warning(t('chat.batchDeletePartial', { failed: result.failed }))
      }
    } else {
      message.error(t('chat.batchDeleteFailed'))
    }
  } catch {
    message.error(t('chat.batchDeleteFailed'))
  } finally {
    isBatchDeleting.value = false
    showBatchDeleteConfirm.value = false
    isBatchMode.value = false
    selectedSessionKeys.value.clear()
  }
}

function handleBatchDeleteConfirm() {
  void handleBatchDelete()
  return false
}

</script>

<template>
  <div class="history-panel">
    <div class="session-backdrop" :class="{ active: showSessions }" @click="showSessions = false" />
    <aside class="session-list" :class="{ collapsed: !showSessions }">
      <div v-if="showSessions" class="page-sidebar-top">
        <PageSidebarNav
          active="history"
          :primary-label="t('chat.newChat')"
          hide-mode-switch
          @primary="openNewChatPage"
        />
        <div class="session-list-toolbar">
          <span class="session-list-title">{{ t('chat.hermesHistory') }}</span>
          <div class="session-list-actions">
            <button class="session-close-btn" @click="showSessions = false">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <NButton
              v-if="!isBatchMode"
              quaternary
              size="tiny"
              :disabled="hermesSessions.length === 0"
              :title="t('chat.toggleBatchMode')"
              @click="toggleBatchMode"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </template>
            </NButton>
            <NButton
              v-if="isBatchMode"
              quaternary
              size="tiny"
              :disabled="!canSelectAll || isBatchDeleting"
              :title="allSessionsSelected ? t('common.cancel') : t('chat.selectAll')"
              @click="toggleSelectAllSessions"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 11l3 3L22 4" />
                  <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                </svg>
              </template>
            </NButton>
            <NPopconfirm
              v-if="isBatchMode && selectedCount > 0"
              v-model:show="showBatchDeleteConfirm"
              :positive-button-props="{ loading: isBatchDeleting, disabled: isBatchDeleting }"
              :negative-button-props="{ disabled: isBatchDeleting }"
              @positive-click="handleBatchDeleteConfirm"
            >
              <template #trigger>
                <NButton quaternary size="tiny" type="error" :loading="isBatchDeleting" :disabled="isBatchDeleting">
                  <template #icon>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </template>
                </NButton>
              </template>
              {{ t('chat.confirmBatchDelete', { count: selectedCount }) }}
            </NPopconfirm>
            <NButton
              v-if="isBatchMode"
              quaternary
              size="tiny"
              :disabled="isBatchDeleting"
              @click="toggleBatchMode"
            >
              <template #icon>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </template>
            </NButton>
          </div>
        </div>
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
            :can-delete="true"
            :streaming="false"
            :selectable="isBatchMode"
            :selected="isSessionSelected(s)"
            :show-profile="true"
            @select="isBatchMode ? toggleSessionSelection(s) : handleSessionClick(s.id, s.profile)"
            @contextmenu="handleContextMenu($event, s.id)"
            @delete="handleDeleteSession(s.id, s.profile)"
            @toggle-select="toggleSessionSelection(s)"
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
              :can-delete="true"
              :streaming="false"
              :selectable="isBatchMode"
              :selected="isSessionSelected(s)"
              :show-profile="true"
              @select="isBatchMode ? toggleSessionSelection(s) : handleSessionClick(s.id, s.profile)"
              @contextmenu="handleContextMenu($event, s.id)"
              @delete="handleDeleteSession(s.id, s.profile)"
              @toggle-select="toggleSessionSelection(s)"
            />
          </template>
        </template>
      </div>
      <PageSidebarFooter v-if="showSessions" />
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

    <div class="chat-main">
      <header class="chat-header">
        <div class="header-left">
          <NButton class="history-sidebar-toggle" quaternary size="small" @click="showSessions = !showSessions" circle>
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
              <NButton quaternary size="small" @click="showOutline = !showOutline" circle>
                <template #icon>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
                </template>
              </NButton>
            </template>
            {{ t('chat.outlineTitle') }}
          </NTooltip>
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

      <div class="history-content-wrapper">
        <div class="history-main-content">
          <HistoryMessageList
            ref="historyMessageListRef"
            :session="historySession"
            :load-older="loadOlderHistoryMessages"
          />
        </div>
        <OutlinePanel
          v-if="showOutline && historySession"
          :messages="historySession.messages || []"
          @navigate="handleOutlineNavigate"
        />
      </div>
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

.history-content-wrapper {
  flex: 1;
  display: flex;
  overflow: hidden;
  position: relative;
}

.history-main-content {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.session-list {
  width: $sidebar-width;
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
    z-index: 120;
    background: $bg-card;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.1);
    width: $sidebar-width;

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
    z-index: 110;
    opacity: 0;
    pointer-events: none;
    transition: opacity $transition-fast;

    &.active {
      opacity: 1;
      pointer-events: auto;
    }
  }
}

.page-sidebar-top {
  flex-shrink: 0;
  padding: 12px;
  border-bottom: 1px solid $border-color;
}

.session-list-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
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

.header-left :deep(.n-button) {
  flex: 0 0 auto;
}

.header-session-title {
  font-size: 16px;
  font-weight: 600;
  color: $text-primary;
  line-height: 28px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.source-badge {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  color: $text-muted;
  background: rgba($text-muted, 0.12);
  padding: 1px 7px;
  border-radius: 8px;
  flex-shrink: 0;
  white-space: nowrap;
  height: 18px;
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

  .history-sidebar-toggle {
    display: none;
  }
}

.workspace-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  color: $text-muted;
  background: rgba(255, 255, 255, 0.05);
  padding: 2px 8px;
  border-radius: 4px;
  height: 20px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
</style>
