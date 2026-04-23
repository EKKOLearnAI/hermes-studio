import { startRun, streamRunEvents, type ChatMessage, type RunEvent } from '@/api/hermes/chat'
import { deleteSession as deleteSessionApi, fetchSession, fetchSessions, fetchSessionUsageSingle, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'

export interface Attachment {
  id: string
  name: string
  type: string
  size: number
  url: string
  file?: File
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: number
  toolName?: string
  toolPreview?: string
  toolArgs?: string
  toolResult?: string
  toolStatus?: 'running' | 'done' | 'error'
  isStreaming?: boolean
  attachments?: Attachment[]
}

export interface Session {
  id: string
  title: string
  source?: string
  messages: Message[]
  createdAt: number
  updatedAt: number
  model?: string
  provider?: string
  messageCount?: number
  inputTokens?: number
  outputTokens?: number
  endedAt?: number | null
  lastActiveAt?: number
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const res = await fetch('/upload', {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`)
  const data = await res.json() as { files: { name: string; path: string }[] }
  return data.files
}

function mapHermesMessages(msgs: HermesMessage[]): Message[] {
  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, string>()
  for (const msg of msgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
          if (tc.function?.arguments) toolArgsMap.set(tc.id, tc.function.arguments)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of msgs) {
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !msg.content?.trim()) {
      // Emit a tool.started message for each tool call
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || 'tool',
          toolArgs: tc.function?.arguments || undefined,
          toolStatus: 'done',
        })
      }
      continue
    }

    // Tool result messages
    if (msg.role === 'tool') {
      const tcId = msg.tool_call_id || ''
      const toolName = msg.tool_name || toolNameMap.get(tcId) || 'tool'
      const toolArgs = toolArgsMap.get(tcId) || undefined
      // Extract a short preview from the content
      let preview = ''
      if (msg.content) {
        try {
          const parsed = JSON.parse(msg.content)
          preview = parsed.url || parsed.title || parsed.preview || parsed.summary || ''
        } catch {
          preview = msg.content.slice(0, 80)
        }
      }
      // Find and remove the matching placeholder from tool_calls above
      const placeholderIdx = result.findIndex(
        m => m.role === 'tool' && m.toolName === toolName && !m.toolResult && m.id.includes('_' + tcId)
      )
      if (placeholderIdx !== -1) {
        result.splice(placeholderIdx, 1)
      }
      result.push({
        id: String(msg.id),
        role: 'tool',
        content: '',
        timestamp: Math.round(msg.timestamp * 1000),
        toolName,
        toolArgs,
        toolPreview: typeof preview === 'string' ? preview.slice(0, 100) || undefined : undefined,
        toolResult: msg.content || undefined,
        toolStatus: 'done',
      })
      continue
    }

    // Normal user/assistant messages
    result.push({
      id: String(msg.id),
      role: msg.role,
      content: msg.content || '',
      timestamp: Math.round(msg.timestamp * 1000),
    })
  }
  return result
}

function mapHermesSession(s: SessionSummary): Session {
  return {
    id: s.id,
    title: s.title || '',
    source: s.source || undefined,
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round((s.last_active || s.ended_at || s.started_at) * 1000),
    model: s.model,
    provider: (s as any).billing_provider || '',
    messageCount: s.message_count,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
  }
}

// Cache keys for stale-while-revalidate loading of sessions / messages.
// All keys include the active profile name to isolate cache between profiles.
// Rendering from cache on boot avoids the multi-round-trip wait the user sees
// every time they open the page (esp. noticeable on mobile).
const STORAGE_KEY_PREFIX = 'hermes_active_session_'
const SESSIONS_CACHE_KEY_PREFIX = 'hermes_sessions_cache_v1_'
const LEGACY_STORAGE_KEY = 'hermes_active_session'
const LEGACY_SESSIONS_CACHE_KEY = 'hermes_sessions_cache_v1'
const IN_FLIGHT_TTL_MS = 15 * 60 * 1000 // Give up after 15 minutes
const POLL_INTERVAL_MS = 2000
const POLL_STABLE_EXITS = 3 // 3 × 2s = 6s of no change → assume run finished
const LIVE_BADGE_WINDOW_MS = 5 * 60 * 1000

// 获取当前 profile 名称，用于隔离缓存。
// 从 profiles store 的 activeProfileName（同步 localStorage）读取，
// 避免异步加载导致 chat store 初始化时拿到 null。
function getProfileName(): string {
  try {
    return useProfilesStore().activeProfileName || 'default'
  } catch {
    return 'default'
  }
}

function storageKey(): string { return STORAGE_KEY_PREFIX + getProfileName() }
function sessionsCacheKey(): string { return SESSIONS_CACHE_KEY_PREFIX + getProfileName() }
function msgsCacheKey(sid: string): string { return `hermes_session_msgs_v1_${getProfileName()}_${sid}_` }
function inFlightKey(sid: string): string { return `hermes_in_flight_v1_${getProfileName()}_${sid}` }
function legacyStorageKey(): string | null { return getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }
function legacySessionsCacheKey(): string | null { return getProfileName() === 'default' ? LEGACY_SESSIONS_CACHE_KEY : null }
function legacyMsgsCacheKey(sid: string): string | null { return getProfileName() === 'default' ? `hermes_session_msgs_v1_${sid}` : null }
function legacyInFlightKey(sid: string): string | null { return getProfileName() === 'default' ? `hermes_in_flight_v1_${sid}` : null }

interface InFlightRun {
  runId: string
  startedAt: number
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

function recoverStorageQuota() {
  try {
    const prefixes = [
      sessionsCacheKey(),
      `hermes_session_msgs_v1_${getProfileName()}_`,
      `hermes_in_flight_v1_${getProfileName()}_`,
    ]
    const legacySessions = legacySessionsCacheKey()
    if (legacySessions) prefixes.push(legacySessions)
    if (getProfileName() === 'default') {
      prefixes.push('hermes_session_msgs_v1_')
      prefixes.push('hermes_in_flight_v1_')
    }
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      if (key === storageKey() || key === LEGACY_STORAGE_KEY) continue
      if (prefixes.some(prefix => key.startsWith(prefix))) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach(key => removeItem(key))
  } catch {
    // ignore
  }
}

function setItemBestEffort(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    return
  } catch (error) {
    if (!isQuotaExceededError(error)) return
  }

  recoverStorageQuota()

  try {
    localStorage.setItem(key, value)
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

function saveJson(key: string, value: unknown) {
  try {
    setItemBestEffort(key, JSON.stringify(value))
  } catch {
    // quota exceeded or private mode — ignore, cache is best-effort
  }
}

function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
}

function loadJsonWithFallback<T>(key: string, legacyKey?: string | null): T | null {
  const value = loadJson<T>(key)
  if (value != null) return value
  if (!legacyKey) return null
  return loadJson<T>(legacyKey)
}

function saveJsonWithLegacy(key: string, value: unknown, legacyKey?: string | null) {
  saveJson(key, value)
  if (legacyKey) removeItem(legacyKey)
}

function removeItemWithLegacy(key: string, legacyKey?: string | null) {
  removeItem(key)
  if (legacyKey) removeItem(legacyKey)
}

// Strip the circular `file: File` reference from attachments before caching —
// File objects don't serialize and we only need name/type/size/url for display.
function sanitizeForCache(msgs: Message[]): Message[] {
  return msgs.map(m => {
    if (!m.attachments?.length) return m
    return {
      ...m,
      attachments: m.attachments.map(a => ({ id: a.id, name: a.name, type: a.type, size: a.size, url: a.url })),
    }
  })
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, AbortController>>(new Map())
  const isStreaming = computed(() => activeSessionId.value != null && streamStates.value.has(activeSessionId.value))
  const isLoadingSessions = ref(false)
  const sessionsLoaded = ref(false)
  const isLoadingMessages = ref(false)
  // tmux-like resume state: true when we recovered an in-flight run from
  // localStorage after a refresh and are polling fetchSession for progress.
  // UI shows the thinking indicator while this is set.
  const resumingRuns = ref<Set<string>>(new Set())
  const isRunActive = computed(() =>
    isStreaming.value
    || (activeSessionId.value != null && resumingRuns.value.has(activeSessionId.value))
  )
  const pollTimers = new Map<string, ReturnType<typeof setInterval>>()
  const pollSignatures = new Map<string, { sig: string, stableTicks: number }>()

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])

  function isSessionLive(sessionId: string): boolean {
    if (streamStates.value.has(sessionId) || resumingRuns.value.has(sessionId)) return true

    const session = sessions.value.find(candidate => candidate.id === sessionId)
    if (!session?.lastActiveAt || session.endedAt != null) return false
    return Date.now() - session.lastActiveAt <= LIVE_BADGE_WINDOW_MS
  }

  function persistSessionsList() {
    // Cache lightweight summaries only (messages are cached per-session).
    saveJsonWithLegacy(
      sessionsCacheKey(),
      sessions.value.map(s => ({ ...s, messages: [] })),
      legacySessionsCacheKey(),
    )
  }

  function persistActiveMessages() {
    const sid = activeSessionId.value
    if (!sid) return
    const s = sessions.value.find(sess => sess.id === sid)
    if (s) saveJsonWithLegacy(msgsCacheKey(sid), sanitizeForCache(s.messages), legacyMsgsCacheKey(sid))
  }

  function markInFlight(sid: string, runId: string) {
    saveJsonWithLegacy(inFlightKey(sid), { runId, startedAt: Date.now() } as InFlightRun, legacyInFlightKey(sid))
  }

  function clearInFlight(sid: string) {
    removeItemWithLegacy(inFlightKey(sid), legacyInFlightKey(sid))
  }

  function readInFlight(sid: string): InFlightRun | null {
    const rec = loadJsonWithFallback<InFlightRun>(inFlightKey(sid), legacyInFlightKey(sid))
    if (!rec) return null
    if (Date.now() - rec.startedAt > IN_FLIGHT_TTL_MS) {
      removeItemWithLegacy(inFlightKey(sid), legacyInFlightKey(sid))
      return null
    }
    return rec
  }

  function stopPolling(sid: string) {
    const t = pollTimers.get(sid)
    if (t) {
      clearInterval(t)
      pollTimers.delete(sid)
    }
    pollSignatures.delete(sid)
    resumingRuns.value = new Set([...resumingRuns.value].filter(x => x !== sid))
  }

  // Poll fetchSession while an in-flight run is recovering. Exits when the
  // server's message signature is stable for POLL_STABLE_EXITS ticks (run
  // presumed done), TTL elapses, or the user explicitly starts streaming.
  function startPolling(sid: string) {
    if (pollTimers.has(sid)) return
    resumingRuns.value = new Set([...resumingRuns.value, sid])
    const timer = setInterval(async () => {
      // If a fresh SSE stream started for this session, polling is redundant.
      if (streamStates.value.has(sid)) {
        stopPolling(sid)
        return
      }
      const inFlight = readInFlight(sid)
      if (!inFlight) {
        stopPolling(sid)
        return
      }
      try {
        const detail = await fetchSession(sid)
        if (!detail) return
        const mapped = mapHermesMessages(detail.messages || [])
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return
        // Use the same "content-aware" comparison as switchSession: server
        // is ahead iff it knows about at least as many user turns and its
        // last assistant text is at least as long as ours.
        const local = target.messages
        const localLastAssistant = [...local].reverse().find(m => m.role === 'assistant')
        const serverLastAssistant = [...mapped].reverse().find(m => m.role === 'assistant')
        const localAssistantLen = localLastAssistant?.content?.length ?? 0
        const serverAssistantLen = serverLastAssistant?.content?.length ?? 0
        const localUsers = local.filter(m => m.role === 'user').length
        const serverUsers = mapped.filter(m => m.role === 'user').length
        const serverIsCaughtUp = serverUsers >= localUsers
        // Same rationale as switchSession: strictly more user turns means
        // server is ahead (new turn complete). Equal user turns + longer
        // assistant means server caught up on the current turn.
        const serverIsAhead =
          serverUsers > localUsers
          || (serverUsers === localUsers && serverAssistantLen >= localAssistantLen)
        if (serverIsAhead) {
          target.messages = mapped
          if (detail.title && !target.title) target.title = detail.title
          if (sid === activeSessionId.value) persistActiveMessages()
        }
        // Stability detection ONLY matters when the server has at least as
        // many user turns as we do. Otherwise the server is still catching
        // up (e.g. the new turn we just sent hasn't been flushed server-side
        // yet) and a "stable" signature is a false positive — the stability
        // is the server NOT having our latest turn, not the run being done.
        if (!serverIsCaughtUp) {
          pollSignatures.delete(sid)
        } else {
          const last = mapped[mapped.length - 1]
          const sig = `${mapped.length}|${last?.content?.slice(-40) || ''}|${last?.toolStatus || ''}`
          const prev = pollSignatures.get(sid)
          if (prev && prev.sig === sig) {
            prev.stableTicks += 1
            if (prev.stableTicks >= POLL_STABLE_EXITS) {
              // Run is done on the server. Force-apply server view even if
              // our "don't retreat" guard above skipped it — the server is
              // now the authoritative source of truth.
              target.messages = mapped
              if (detail.title) target.title = detail.title
              if (sid === activeSessionId.value) persistActiveMessages()
              clearInFlight(sid)
              stopPolling(sid)
            }
          } else {
            pollSignatures.set(sid, { sig, stableTicks: 0 })
          }
        }
      } catch {
        // transient network error — ignore, next tick tries again
      }
    }, POLL_INTERVAL_MS)
    pollTimers.set(sid, timer)
  }

  async function loadSessions() {
    isLoadingSessions.value = true
    try {
      // 从 profile 对应的缓存中恢复，实现 instant render
      const cachedSessions = loadJsonWithFallback<Session[]>(sessionsCacheKey(), legacySessionsCacheKey())
      if (cachedSessions?.length) {
        sessions.value = cachedSessions
        const savedId = localStorage.getItem(storageKey()) || (legacyStorageKey() ? localStorage.getItem(legacyStorageKey()!) : null)
        if (savedId) {
          const cachedActive = cachedSessions.find(s => s.id === savedId) || null
          if (cachedActive) {
            const cachedMsgs = loadJsonWithFallback<Message[]>(msgsCacheKey(savedId), legacyMsgsCacheKey(savedId))
            if (cachedMsgs) cachedActive.messages = cachedMsgs
            activeSession.value = cachedActive
            activeSessionId.value = savedId
          }
        }
      }

      const list = await fetchSessions()
      const fresh = list.map(mapHermesSession)
      const freshIds = new Set(fresh.map(s => s.id))
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const msgsByIdBefore = new Map(sessions.value.map(s => [s.id, s.messages]))
      for (const s of fresh) {
        const prev = msgsByIdBefore.get(s.id)
        if (prev && prev.length) s.messages = prev
      }
      // Preserve local-only sessions the server hasn't seen yet — e.g. a chat
      // that was just created and whose first run is still in-flight. Without
      // this, refreshing mid-run would wipe the session and fall back to
      // sessions[0], which is exactly what the user reported.
      const localOnly = sessions.value.filter(s => !freshIds.has(s.id))
      sessions.value = [...localOnly, ...fresh]
      persistSessionsList()

      // Restore last active session, fallback to most recent
      const savedId = activeSessionId.value
      const targetId = savedId && sessions.value.some(s => s.id === savedId)
        ? savedId
        : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId)
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      isLoadingSessions.value = false
      sessionsLoaded.value = true
    }
  }

  // Re-pull active session from server and overwrite local messages. Used on
  // SSE drop and on tab-visible events — mobile browsers kill EventSource
  // while backgrounded, but the backend run usually completes anyway.
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const detail = await fetchSession(sid)
      if (!detail) return false
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      const mapped = mapHermesMessages(detail.messages || [])
      target.messages = mapped
      if (detail.title) target.title = detail.title
      persistActiveMessages()
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }


  function createSession(): Session {
    const session: Session = {
      id: uid(),
      title: '',
      source: 'api_server',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    sessions.value.unshift(session)
    // Persist immediately so a refresh before run.completed can still find
    // this session in the cache.
    persistSessionsList()
    return session
  }

  async function switchSession(sessionId: string, focusId?: string | null) {
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null

    if (!activeSession.value) return

    // Hydrate messages from localStorage cache first (instant render), then
    // revalidate from server in the background. If no cache exists, show the
    // loading state while we fetch.
    const hasLocalMessages = activeSession.value.messages.length > 0
    if (!hasLocalMessages) {
      const cachedMsgs = loadJsonWithFallback<Message[]>(msgsCacheKey(sessionId), legacyMsgsCacheKey(sessionId))
      if (cachedMsgs?.length) {
        activeSession.value.messages = cachedMsgs
      }
    }

    const needsBlockingLoad = activeSession.value.messages.length === 0
    if (needsBlockingLoad) isLoadingMessages.value = true

    try {
      const detail = await fetchSession(sessionId)
      if (detail && detail.messages) {
        const mapped = mapHermesMessages(detail.messages)
        // Pick whichever view has more information. Simple length comparison
        // is wrong because mapHermesMessages folds tool_call-only assistant
        // msgs and matches them with tool-result msgs — so post-fold `mapped`
        // can be SHORTER than the raw SSE-built local array even when the
        // server is strictly ahead. Instead, compare the last assistant
        // message content: if the server's is at least as long, the server
        // is up-to-date (and has the final complete text); otherwise keep
        // local (in-flight window where server hasn't flushed the new turn).
        const local = activeSession.value.messages
        const localLastAssistant = [...local].reverse().find(m => m.role === 'assistant')
        const serverLastAssistant = [...mapped].reverse().find(m => m.role === 'assistant')
        const localAssistantLen = localLastAssistant?.content?.length ?? 0
        const serverAssistantLen = serverLastAssistant?.content?.length ?? 0
        const localUsers = local.filter(m => m.role === 'user').length
        const serverUsers = mapped.filter(m => m.role === 'user').length
        // Trust server when:
        //   - it has STRICTLY MORE user turns than we do (new turn landed),
        //     OR
        //   - same user-turn count AND server's last assistant is at least
        //     as long as ours (same turn, server caught up or further)
        // Otherwise keep local (protects against the server-not-yet-flushed
        // race during in-flight runs). Length comparison alone is wrong
        // across different turns because each turn's last assistant is
        // unrelated to the previous turn's.
        const serverIsAhead =
          serverUsers > localUsers
          || (serverUsers === localUsers && serverAssistantLen >= localAssistantLen)
        if (serverIsAhead) {
          activeSession.value.messages = mapped
        }
        // Update title: use Hermes title, or fallback to first user message
        if (detail.title) {
          activeSession.value.title = detail.title
        } else if (!activeSession.value.title) {
          const firstUser = (activeSession.value.messages).find(m => m.role === 'user')
          if (firstUser) {
            const t = firstUser.content.slice(0, 40)
            activeSession.value.title = t + (firstUser.content.length > 40 ? '...' : '')
          }
        }
        persistActiveMessages()
      }
    } catch (err) {
      console.error('Failed to load session messages:', err)
    } finally {
      isLoadingMessages.value = false
    }

    // tmux-like resume: if this session has a recent in-flight run and we're
    // not currently streaming, start polling fetchSession to pick up progress
    // that happened while we were gone. Exits automatically on stability.
    if (readInFlight(sessionId) && !streamStates.value.has(sessionId)) {
      startPolling(sessionId)
    }

    // Fetch token usage for this session from web-ui DB
    try {
      const usage = await fetchSessionUsageSingle(sessionId)
      if (usage) {
        activeSession.value.inputTokens = usage.input_tokens
        activeSession.value.outputTokens = usage.output_tokens
      }
    } catch { /* non-critical */ }
  }

  function newChat() {
    if (isStreaming.value) return
    const session = createSession()
    // Inherit current global model
    const appStore = useAppStore()
    session.model = appStore.selectedModel || undefined
    switchSession(session.id)
  }

  async function switchSessionModel(modelId: string, provider?: string) {
    if (!activeSession.value) return
    activeSession.value.model = modelId
    activeSession.value.provider = provider || ''
    // If provider changed, update global config too (Hermes requires it)
    if (provider) {
      const { useAppStore } = await import('./app')
      await useAppStore().switchModel(modelId, provider)
    }
  }

  async function deleteSession(sessionId: string) {
    await deleteSessionApi(sessionId)
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    removeItemWithLegacy(msgsCacheKey(sessionId), legacyMsgsCacheKey(sessionId))
    persistSessionsList()
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
  }

  function getSessionMsgs(sessionId: string): Message[] {
    const s = sessions.value.find(s => s.id === sessionId)
    return s?.messages || []
  }

  function addMessage(sessionId: string, msg: Message) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (s) s.messages.push(msg)
  }

  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  function updateSessionTitle(sessionId: string) {
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target) return
    if (!target.title) {
      const firstUser = target.messages.find(m => m.role === 'user')
      if (firstUser) {
        const title = firstUser.attachments?.length
          ? firstUser.attachments.map(a => a.name).join(', ')
          : firstUser.content
        target.title = title.slice(0, 40) + (title.length > 40 ? '...' : '')
      }
    }
    target.updatedAt = Date.now()
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if ((!content.trim() && !(attachments && attachments.length > 0)) || isStreaming.value) return

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    }
    addMessage(sid, userMsg)
    updateSessionTitle(sid)
    // Persist immediately so a refresh before the first SSE event (e.g. the
    // user closes the tab right after sending) still has the user's message
    // and session title in the cache.
    if (sid === activeSessionId.value) {
      persistActiveMessages()
      persistSessionsList()
    }

    try {
      // Build conversation history from past messages
      const sessionMsgs = getSessionMsgs(sid)
      const history: ChatMessage[] = sessionMsgs
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
        .map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content }))

      // Upload attachments and build input with file paths
      let inputText = content.trim()
      if (attachments && attachments.length > 0) {
        const uploaded = await uploadFiles(attachments)
        const pathParts = uploaded.map(f => `[File: ${f.name}](${f.path})`)
        inputText = inputText ? inputText + '\n\n' + pathParts.join('\n') : pathParts.join('\n')
      }

      const appStore = useAppStore()
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const run = await startRun({
        input: inputText,
        conversation_history: history,
        session_id: sid,
        model: sessionModel || undefined,
      })

      const runId = (run as any).run_id || (run as any).id
      if (!runId) {
        addMessage(sid, {
          id: uid(),
          role: 'system',
          content: `Error: startRun returned no run ID. Response: ${JSON.stringify(run)}`,
          timestamp: Date.now(),
        })
        return
      }

      // tmux-like resume: persist run_id so refresh/reopen can pick up the
      // working indicator and poll for progress.
      markInFlight(sid, runId)
      // If we were already polling (e.g. user re-sent while resume was still
      // polling an earlier run), cancel that polling — the new SSE stream is
      // the authoritative live source.
      stopPolling(sid)

      // Helper to clean up this session's stream state
      const cleanup = () => {
        streamStates.value.delete(sid)
        if (persistTimer) {
          clearTimeout(persistTimer)
          persistTimer = null
        }
      }

      // Throttle in-flight cache writes so a refresh mid-stream still shows
      // the partial reply. 800ms keeps quota pressure low while guaranteeing
      // at most ~1s of unsaved delta on reload.
      let persistTimer: ReturnType<typeof setTimeout> | null = null
      const schedulePersist = () => {
        if (sid !== activeSessionId.value || persistTimer) return
        persistTimer = setTimeout(() => {
          persistTimer = null
          persistActiveMessages()
        }, 800)
      }

      // Listen to SSE events — all closures capture `sid`
      const ctrl = streamRunEvents(
        runId,
        // onEvent
        (evt: RunEvent) => {
          switch (evt.event) {
            case 'run.started':
              break

            case 'message.delta': {
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                last.content += evt.delta || ''
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: evt.delta || '',
                  timestamp: Date.now(),
                  isStreaming: true,
                })
              }
              schedulePersist()
              break
            }

            case 'tool.started': {
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.isStreaming) {
                updateMessage(sid, last.id, { isStreaming: false })
              }
              addMessage(sid, {
                id: uid(),
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolName: evt.tool || evt.name,
                toolPreview: evt.preview,
                toolStatus: 'running',
              })
              schedulePersist()
              break
            }

            case 'tool.completed': {
              const msgs = getSessionMsgs(sid)
              const toolMsgs = msgs.filter(
                m => m.role === 'tool' && m.toolStatus === 'running',
              )
              if (toolMsgs.length > 0) {
                const last = toolMsgs[toolMsgs.length - 1]
                updateMessage(sid, last.id, { toolStatus: 'done' })
              }
              schedulePersist()
              break
            }

            case 'run.completed': {
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              if (evt.usage) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = evt.usage.input_tokens
                  target.outputTokens = evt.usage.output_tokens
                }
              }
              cleanup()
              updateSessionTitle(sid)
              // the in-flight marker. If the browser is reloading right now
              // and kills us between the two localStorage writes, we want
              // the next page load to still see in-flight === true (so
              // polling kicks in and recovers) rather than the other way
              // around (cleared in-flight + stale streaming cache = UI stuck).
              if (sid === activeSessionId.value) persistActiveMessages()
              clearInFlight(sid)
              stopPolling(sid)
              break
            }

            case 'run.failed': {
              const msgs = getSessionMsgs(sid)
              const lastErr = msgs[msgs.length - 1]
              if (lastErr?.isStreaming) {
                updateMessage(sid, lastErr.id, {
                  isStreaming: false,
                  content: evt.error ? `Error: ${evt.error}` : 'Run failed',
                  role: 'system',
                })
              } else {
                addMessage(sid, {
                  id: uid(),
                  role: 'system',
                  content: evt.error ? `Error: ${evt.error}` : 'Run failed',
                  timestamp: Date.now(),
                })
              }
              msgs.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  msgs[i] = { ...m, toolStatus: 'error' }
                }
              })
              cleanup()
              if (sid === activeSessionId.value) persistActiveMessages()
              clearInFlight(sid)
              stopPolling(sid)
              break
            }
          }
        },
        // onDone
        () => {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          cleanup()
          updateSessionTitle(sid)
        },
        // onError
        // Mobile browsers drop EventSource when the tab backgrounds / screen
        // locks / network flips. The backend run usually completes anyway, so
        // rather than injecting a stale "SSE connection error" bubble we mark
        // streaming as done and silently re-sync from the server, which has
        // the real final answer. If the server fetch itself fails, we leave
        // whatever text we already streamed in place — no visible error.
        (err) => {
          console.warn('SSE connection dropped, resyncing from server:', err.message)
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          // Any tool messages still marked 'running' will be replaced by the
          // server's view after refresh; clear their spinner state now.
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          if (sid === activeSessionId.value) {
            void refreshActiveSession()
          }
          // The run might still be going on the server side (SSE drop doesn't
          // abort it). If we still have an in-flight record, fall back to
          // polling fetchSession to keep the user updated.
          if (readInFlight(sid)) {
            startPolling(sid)
          }
        },
      )

      streamStates.value.set(sid, ctrl)
    } catch (err: any) {
      addMessage(sid, {
        id: uid(),
        role: 'system',
        content: `Error: ${err.message}`,
        timestamp: Date.now(),
      })
    }
  }

  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      streamStates.value.delete(sid)
      clearInFlight(sid)
      stopPolling(sid)
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        void refreshActiveSession()
        if (readInFlight(activeSessionId.value)) {
          startPolling(activeSessionId.value)
        }
      }
    })
  }

  return {
    sessions,
    activeSessionId,
    activeSession,
    focusMessageId,
    messages,
    isStreaming,
    isRunActive,
    isSessionLive,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    switchSession,
    switchSessionModel,
    deleteSession,
    sendMessage,
    stopStreaming,
    loadSessions,
    refreshActiveSession,
  }
})
