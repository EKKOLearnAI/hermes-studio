import { startRunViaSocket, connectChatRun, resumeSession, type RunEvent } from '@/api/hermes/chat'
import { deleteSession as deleteSessionApi, fetchSession, fetchSessions, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'
import { getApiKey } from '@/api/client'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { detectThinkingBoundary } from '@/utils/thinking-parser'

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
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
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
      reasoning: msg.reasoning ? msg.reasoning : undefined,
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

const STORAGE_KEY_PREFIX = 'hermes_active_session_'
const LEGACY_STORAGE_KEY = 'hermes_active_session'
const IN_FLIGHT_TTL_MS = 15 * 60 * 1000 // Give up after 15 minutes

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
function legacyStorageKey(): string | null { return getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }
function inFlightKey(sid: string): string { return `hermes_in_flight_v1_${getProfileName()}_${sid}` }
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
      `hermes_session_msgs_v1_${getProfileName()}_`,
      `hermes_in_flight_v1_${getProfileName()}_`,
    ]
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

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, { abort: () => void }>>(new Map())
  /** sessionId → server-reported isWorking status */
  const serverWorking = ref<Set<string>>(new Set())
  const isStreaming = computed(() => {
    const sid = activeSessionId.value
    if (sid == null) return false
    return streamStates.value.has(sid) || serverWorking.value.has(sid)
  })
  const isLoadingSessions = ref(false)
  const sessionsLoaded = ref(false)
  const isLoadingMessages = ref(false)
  const isRunActive = computed(() => isStreaming.value)

  // Compression state
  const compressionState = ref<{
    compressing: boolean
    messageCount: number
    beforeTokens: number
    afterTokens: number
    compressed: boolean | null
    error?: string
  } | null>(null)

  function setCompressionState(state: typeof compressionState.value) {
    compressionState.value = state
  }

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])

  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId) || serverWorking.value.has(sessionId)
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

  async function loadSessions() {
    isLoadingSessions.value = true
    try {
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
      // Sessions without an active in-flight run are considered deleted and
      // cleaned up along with their cached messages.
      const localOnly = sessions.value.filter(s => {
        if (freshIds.has(s.id)) return false
        if (readInFlight(s.id)) return true
        removeItemWithLegacy(inFlightKey(s.id), legacyInFlightKey(s.id))
        return false
      })
      sessions.value = [...localOnly, ...fresh]

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

  // Re-pull active session from server. Used on tab-visible events.
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
    return session
  }

  async function switchSession(sessionId: string, focusId?: string | null) {
    clearThinkingObservationFor(sessionId)
    activeSessionId.value = sessionId
    focusMessageId.value = focusId ?? null
    setItemBestEffort(storageKey(), sessionId)
    const legacyActiveKey = legacyStorageKey()
    if (legacyActiveKey) removeItem(legacyActiveKey)
    activeSession.value = sessions.value.find(s => s.id === sessionId) || null

    if (!activeSession.value) return

    isLoadingMessages.value = true

    try {
      // Load messages via Socket.IO resume (server loads from DB if not in memory)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('resume timeout')), 15_000)
        resumeSession(sessionId, (data) => {
          clearTimeout(timeout)
          if (data.isWorking) {
            serverWorking.value.add(sessionId)
          } else {
            serverWorking.value.delete(sessionId)
          }
          if (data.inputTokens != null) activeSession.value!.inputTokens = data.inputTokens
          if (data.outputTokens != null) activeSession.value!.outputTokens = data.outputTokens
          if (data.messages?.length) {
            activeSession.value!.messages = mapHermesMessages(data.messages as any[])
          }
          if (!activeSession.value!.title) {
            const firstUser = activeSession.value!.messages.find(m => m.role === 'user')
            if (firstUser) {
              const t = firstUser.content.slice(0, 40)
              activeSession.value!.title = t + (firstUser.content.length > 40 ? '...' : '')
            }
          }
          // Process replayed events (compression state etc.)
          if (data.events?.length) {
            for (const evt of data.events) {
              const e = evt.data as any
              if (e.event === 'compression.started') {
                setCompressionState({
                  compressing: true,
                  messageCount: e.message_count || 0,
                  beforeTokens: e.token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
              } else if (e.event === 'compression.completed') {
                setCompressionState({
                  compressing: false,
                  messageCount: e.totalMessages || 0,
                  beforeTokens: e.beforeTokens || 0,
                  afterTokens: e.afterTokens || 0,
                  compressed: e.compressed ?? false,
                  error: e.error,
                })
              }
            }
          }
          resolve()
        })
      })
    } catch (err) {
      console.error('Failed to load session messages via resume:', err)
    } finally {
      isLoadingMessages.value = false
    }

    // Resume in-flight run event listeners if needed
    resumeInFlightRun(sessionId)
  }

  function newChat() {
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

    try {

      // Upload attachments and build input with file paths
      let inputText = content.trim()
      if (attachments && attachments.length > 0) {
        const uploaded = await uploadFiles(attachments)
        // Replace blob URLs with persistent download URLs on the user message
        const token = getApiKey()
        const urlMap = new Map(uploaded.map(f => {
          const base = `/api/hermes/download?path=${encodeURIComponent(f.path)}&name=${encodeURIComponent(f.name)}`
          return [f.name, token ? `${base}&token=${encodeURIComponent(token)}` : base]
        }))
        const msgs = getSessionMsgs(sid)
        const lastUser = msgs.findLast(m => m.id === userMsg.id)
        if (lastUser?.attachments) {
          lastUser.attachments = lastUser.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
        }
        const pathParts = uploaded.map(f => `[File: ${f.name}](${urlMap.get(f.name)})`)
        inputText = inputText ? inputText + '\n\n' + pathParts.join('\n') : pathParts.join('\n')
      }

      const appStore = useAppStore()
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const runPayload = {
        input: inputText,
        session_id: sid,
        model: sessionModel || undefined,
      }

      // Helper to clean up this session's stream state
      const cleanup = () => {
        streamStates.value.delete(sid)
        serverWorking.value.delete(sid)
      }

      // Per-run flags used to detect silently-swallowed errors at run.completed.
      // hermes-agent occasionally emits run.completed with empty output and no
      // usage when the agent layer caught an upstream error (e.g. invalid API
      // key). We need to distinguish: (a) run with assistant text produced,
      // (b) run with only tool activity, (c) run with truly nothing visible.
      // Reset per send() call — closures captured by Socket.IO callbacks are scoped
      // to this run, so there is no cross-run contamination.
      let runProducedAssistantText = false
      let runHadToolActivity = false

      // Send run via Socket.IO and listen to streamed events — all closures capture `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent
        (evt: RunEvent) => {
          switch (evt.event) {
            case 'run.started':
              break

            case 'compression.started': {
              setCompressionState({
                compressing: true,
                messageCount: (evt as any).message_count || 0,
                beforeTokens: (evt as any).token_count || 0,
                afterTokens: 0,
                compressed: null,
              })
              break
            }

            case 'compression.completed': {
              setCompressionState({
                compressing: false,
                messageCount: (evt as any).totalMessages || 0,
                beforeTokens: (evt as any).beforeTokens || 0,
                afterTokens: (evt as any).afterTokens || 0,
                compressed: (evt as any).compressed ?? false,
                error: (evt as any).error,
              })
              // Auto-clear after 5s
              setTimeout(() => {
                if (compressionState.value && !compressionState.value.compressing) {
                  setCompressionState(null)
                }
              }, 5000)
              break
            }

            case 'reasoning.delta':
            case 'thinking.delta': {
              const text = evt.text || evt.delta || ''
              if (!text) break
              runProducedAssistantText = true
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                last.reasoning = (last.reasoning || '') + text
                noteReasoningStart(last.id)
              } else {
                const newId = uid()
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: '',
                  timestamp: Date.now(),
                  isStreaming: true,
                  reasoning: text,
                })
                noteReasoningStart(newId)
              }

              break
            }

            case 'reasoning.available': {
              // Upstream run_agent.py fires reasoning.available with
              // `assistant_message.content[:500]` as the preview — i.e.,
              // the main answer, not real reasoning. Ignore the payload
              // and only use this event as a "thinking ended" signal so
              // the duration counter stops.
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                // 只有当 reasoning.delta 事件曾经启动过计时，才标记结束；
                // 否则（上游未转发 delta，只发这一次 available）不显示时长。
                noteReasoningEnd(last.id)
              }

              break
            }

            case 'message.delta': {
              if (evt.delta) runProducedAssistantText = true
              const msgs = getSessionMsgs(sid)
              const last = msgs[msgs.length - 1]
              if (last?.role === 'assistant' && last.isStreaming) {
                const prev = last.content
                const next = prev + (evt.delta || '')
                noteThinkingDelta(last.id, prev, next)
                // 若之前有 reasoning 累积，则 content 到达即视为推理结束。
                if (last.reasoning) noteReasoningEnd(last.id)
                last.content = next
              } else {
                const newId = uid()
                const nextContent = evt.delta || ''
                noteThinkingDelta(newId, '', nextContent)
                addMessage(sid, {
                  id: newId,
                  role: 'assistant',
                  content: nextContent,
                  timestamp: Date.now(),
                  isStreaming: true,
                })
              }

              break
            }

            case 'tool.started': {
              runHadToolActivity = true
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

              break
            }

            case 'tool.completed': {
              runHadToolActivity = true
              const msgs = getSessionMsgs(sid)
              const toolMsgs = msgs.filter(
                m => m.role === 'tool' && m.toolStatus === 'running',
              )
              if (toolMsgs.length > 0) {
                const last = toolMsgs[toolMsgs.length - 1]
                updateMessage(sid, last.id, { toolStatus: 'done' })
              }

              break
            }

            case 'run.completed': {
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              // Server-computed usage (local countTokens, snapshot-aware)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                }
              }
              // Belt-and-suspenders: some providers may deliver the final
              // assistant text only via run.completed.output (no message.delta
              // stream). If we never produced assistant text but the gateway
              // reports a non-empty output, fall back to rendering it as a
              // single assistant message so the user actually sees the reply.
              const finalOutput =
                typeof evt.output === 'string' ? evt.output : ''
              const finalOutputTrimmed = finalOutput.trim()
              if (!runProducedAssistantText && finalOutputTrimmed !== '') {
                addMessage(sid, {
                  id: uid(),
                  role: 'assistant',
                  content: finalOutput,
                  timestamp: Date.now(),
                })
                runProducedAssistantText = true
              }
              // Workaround for upstream hermes-agent bug: when the agent
              // layer silently swallows an error (e.g. invalid API key,
              // unsupported model), the gateway still emits run.completed
              // with an empty output. Without surfacing it here the chat UI
              // looks frozen / "succeeded with no reply". Detect by the
              // combination of: no assistant text AND no tool activity AND
              // empty final output. Usage being zero is a *supporting*
              // signal but not required, since some providers/local models
              // legitimately omit usage.
              const swallowedError =
                !runProducedAssistantText &&
                !runHadToolActivity &&
                finalOutputTrimmed === ''
              if (swallowedError) {
                addMessage(sid, {
                  id: uid(),
                  role: 'system',
                  content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
                  timestamp: Date.now(),
                })
              }
              cleanup()
              updateSessionTitle(sid)
              // the in-flight marker. If the browser is reloading right now
              // and kills us between the two localStorage writes, we want
              // the next page load to still see in-flight === true (so
              // polling kicks in and recovers) rather than the other way
              // around (cleared in-flight + stale streaming cache = UI stuck).

              clearInFlight(sid)
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

              clearInFlight(sid)
              break
            }

            case 'usage.updated': {
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                target.inputTokens = (evt as any).inputTokens
                target.outputTokens = (evt as any).outputTokens
              }
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
        (err) => {
          console.warn('Socket.IO run stream error:', err.message)
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          if (sid === activeSessionId.value) {
            void refreshActiveSession()
          }
        },
        // onStarted — called when server acks with run_id
        (runId: string) => {
          markInFlight(sid, runId)
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

  /**
   * Resume an in-flight run after page refresh.
   * Emits 'resume' to join the session room on the server,
   * then sets up event listeners to receive ongoing events.
   */
  function resumeInFlightRun(sid: string) {
    // Don't register duplicate listeners if already streaming
    if (streamStates.value.has(sid)) return
    // Only set up listeners if there's an actual in-flight run
    if (!readInFlight(sid)) return

    const socket = connectChatRun()
    let closed = false
    let runProducedAssistantText = false
    let runHadToolActivity = false

    const cleanup = () => {
      if (closed) return
      closed = true
      socket.off('run.started', onRunStarted)
      socket.off('run.failed', onRunFailed)
      socket.off('message.delta', onMessageDelta)
      socket.off('reasoning.delta', onReasoningDelta)
      socket.off('thinking.delta', onThinkingDelta)
      socket.off('reasoning.available', onReasoningAvailable)
      socket.off('tool.started', onToolStarted)
      socket.off('tool.completed', onToolCompleted)
      socket.off('run.completed', onRunCompleted)
      socket.off('compression.started', onCompressionStarted)
      socket.off('compression.completed', onCompressionCompleted)
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
    }

    // Shared event handler — filters by session_id tag
    function handleEvent(evt: RunEvent) {
      if (closed) return
      // Filter events for this session (server tags all events with session_id)
      if (evt.session_id && evt.session_id !== sid) return
      switch (evt.event) {
        case 'run.started':
          break

        case 'compression.started': {
          setCompressionState({
            compressing: true,
            messageCount: (evt as any).message_count || 0,
            beforeTokens: (evt as any).token_count || 0,
            afterTokens: 0,
            compressed: null,
          })
          break
        }

        case 'compression.completed': {
          setCompressionState({
            compressing: false,
            messageCount: (evt as any).totalMessages || 0,
            beforeTokens: (evt as any).beforeTokens || 0,
            afterTokens: (evt as any).afterTokens || 0,
            compressed: (evt as any).compressed ?? false,
            error: (evt as any).error,
          })
          setTimeout(() => {
            if (compressionState.value && !compressionState.value.compressing) {
              setCompressionState(null)
            }
          }, 5000)
          break
        }

        case 'reasoning.delta':
        case 'thinking.delta': {
          const text = evt.text || evt.delta || ''
          if (!text) break
          runProducedAssistantText = true
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            last.reasoning = (last.reasoning || '') + text
            noteReasoningStart(last.id)
          } else {
            const newId = uid()
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
              reasoning: text,
            })
            noteReasoningStart(newId)
          }

          break
        }

        case 'reasoning.available': {
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            noteReasoningEnd(last.id)
          }

          break
        }

        case 'message.delta': {
          if (evt.delta) runProducedAssistantText = true
          const msgs = getSessionMsgs(sid)
          const last = msgs[msgs.length - 1]
          if (last?.role === 'assistant' && last.isStreaming) {
            const prev = last.content
            const next = prev + (evt.delta || '')
            noteThinkingDelta(last.id, prev, next)
            if (last.reasoning) noteReasoningEnd(last.id)
            last.content = next
          } else {
            const newId = uid()
            const nextContent = evt.delta || ''
            noteThinkingDelta(newId, '', nextContent)
            addMessage(sid, {
              id: newId,
              role: 'assistant',
              content: nextContent,
              timestamp: Date.now(),
              isStreaming: true,
            })
          }

          break
        }

        case 'tool.started': {
          runHadToolActivity = true
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

          break
        }

        case 'tool.completed': {
          runHadToolActivity = true
          const msgs = getSessionMsgs(sid)
          const toolMsgs = msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
          if (toolMsgs.length > 0) {
            updateMessage(sid, toolMsgs[toolMsgs.length - 1].id, { toolStatus: 'done' })
          }

          break
        }

        case 'run.completed': {
          const msgs = getSessionMsgs(sid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          // Server-computed usage (local countTokens, snapshot-aware)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
            }
          }
          const finalOutput = typeof evt.output === 'string' ? evt.output : ''
          const finalOutputTrimmed = finalOutput.trim()
          if (!runProducedAssistantText && finalOutputTrimmed !== '') {
            addMessage(sid, {
              id: uid(),
              role: 'assistant',
              content: finalOutput,
              timestamp: Date.now(),
            })
          }
          const swallowedError = !runProducedAssistantText && !runHadToolActivity && finalOutputTrimmed === ''
          if (swallowedError) {
            addMessage(sid, {
              id: uid(),
              role: 'system',
              content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
              timestamp: Date.now(),
            })
          }
          cleanup()
          updateSessionTitle(sid)

          clearInFlight(sid)
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

          clearInFlight(sid)
          break
        }

        case 'usage.updated': {
          const target = sessions.value.find(s => s.id === sid)
          if (target) {
            target.inputTokens = (evt as any).inputTokens
            target.outputTokens = (evt as any).outputTokens
          }
          break
        }
      }
    }

    function onRunStarted(data: RunEvent) { handleEvent(data) }
    function onRunFailed(data: RunEvent) { handleEvent(data) }
    function onMessageDelta(data: RunEvent) { handleEvent(data) }
    function onReasoningDelta(data: RunEvent) { handleEvent(data) }
    function onThinkingDelta(data: RunEvent) { handleEvent(data) }
    function onReasoningAvailable(data: RunEvent) { handleEvent(data) }
    function onToolStarted(data: RunEvent) { handleEvent(data) }
    function onToolCompleted(data: RunEvent) { handleEvent(data) }
    function onRunCompleted(data: RunEvent) { handleEvent(data) }
    function onCompressionStarted(data: RunEvent) { handleEvent(data) }
    function onCompressionCompleted(data: RunEvent) { handleEvent(data) }

    socket.on('run.started', onRunStarted)
    socket.on('run.failed', onRunFailed)
    socket.on('message.delta', onMessageDelta)
    socket.on('reasoning.delta', onReasoningDelta)
    socket.on('thinking.delta', onThinkingDelta)
    socket.on('reasoning.available', onReasoningAvailable)
    socket.on('tool.started', onToolStarted)
    socket.on('tool.completed', onToolCompleted)
    socket.on('run.completed', onRunCompleted)
    socket.on('compression.started', onCompressionStarted)
    socket.on('compression.completed', onCompressionCompleted)

    // No need to emit resume here — switchSession already did it.
    // Server already joined room and replayed events.
    // Just set up listeners for ongoing streaming events.

    // Mark as streaming so UI shows the indicator
    streamStates.value.set(sid, { abort: cleanup })
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
      serverWorking.value.delete(sid)
    }
    clearInFlight(sid)
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        const sid = activeSessionId.value
        if (sid && !streamStates.value.has(sid)) {
          // Re-load messages via resume (server loads from DB)
          resumeSession(sid, (data) => {
            if (data.messages?.length && activeSession.value) {
              activeSession.value.messages = mapHermesMessages(data.messages as any[])
            }
          })
          resumeInFlightRun(sid)
        }
      }
    })
  }

  // Transient observation of <think> boundaries during active streaming.
  // Not persisted; cleared on session switch. See spec §5.3.
  const thinkingObservation = new Map<string, { startedAt?: number; endedAt?: number }>()

  function getThinkingObservation(messageId: string) {
    return thinkingObservation.get(messageId)
  }

  function noteThinkingDelta(messageId: string, prevContent: string, nextContent: string) {
    const { startedAtBoundary, endedAtBoundary } = detectThinkingBoundary(prevContent, nextContent)
    if (!startedAtBoundary && !endedAtBoundary) return
    const existing = thinkingObservation.get(messageId) || {}
    if (startedAtBoundary && existing.startedAt === undefined) {
      existing.startedAt = Date.now()
    }
    if (endedAtBoundary && existing.endedAt === undefined) {
      existing.endedAt = Date.now()
    }
    thinkingObservation.set(messageId, existing)
  }

  /** 第一次见到某条消息的 reasoning 文本时，标记 startedAt。 */
  function noteReasoningStart(messageId: string) {
    const existing = thinkingObservation.get(messageId) || {}
    if (existing.startedAt === undefined) {
      existing.startedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  /** 内容首次到达（视为推理结束）或显式收到 reasoning.available 时，标记 endedAt。 */
  function noteReasoningEnd(messageId: string) {
    const existing = thinkingObservation.get(messageId)
    if (!existing || existing.startedAt === undefined) return
    if (existing.endedAt === undefined) {
      existing.endedAt = Date.now()
      thinkingObservation.set(messageId, existing)
    }
  }

  function clearProviderFromSessions(provider: string) {
    if (!provider) return
    const target = provider.toLowerCase()
    for (const s of sessions.value) {
      if ((s.provider || '').toLowerCase() === target) {
        s.model = undefined
        s.provider = ''
      }
    }
  }

  function clearThinkingObservationFor(_sessionId: string) {
    // messageId 与 sessionId 的关联未单独持有；方案是切会话时一律清空。
    // 这符合 spec 定义：observation 是"当前会话范围内"的 transient 状态。
    thinkingObservation.clear()
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
    compressionState,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    switchSession,
    switchSessionModel,
    clearProviderFromSessions,
    deleteSession,
    sendMessage,
    stopStreaming,
    loadSessions,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
  }
})
