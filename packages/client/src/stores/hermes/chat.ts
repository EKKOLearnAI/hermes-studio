import { startRunViaSocket, resumeSession, registerSessionHandlers, unregisterSessionHandlers, getChatRunSocket, type RunEvent, type ContentBlock as ContentBlockImport } from '@/api/hermes/chat'
import { deleteSession as deleteSessionApi, fetchSession, fetchSessions, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'
import { getApiKey } from '@/api/client'
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { detectThinkingBoundary } from '@/utils/thinking-parser'

// Re-export ContentBlock for convenience
export type ContentBlock = ContentBlockImport

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
  toolCallId?: string
  toolPreview?: string
  toolArgs?: string
  toolResult?: string
  toolStatus?: 'running' | 'done' | 'error'
  toolDuration?: number  // 工具执行时长（秒）
  isStreaming?: boolean
  attachments?: Attachment[]
  // 思考/推理文本。两条来源：
  //   1) 历史消息：来自 HermesMessage.reasoning 字段
  //   2) 流式：由 reasoning.delta / thinking.delta / reasoning.available 事件累加
  // 不含 <think> 包裹标签；内容自身可以为多段纯文本。
  reasoning?: string
  queued?: boolean
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
  workspace?: string | null
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

async function buildContentBlocks(
  content: string,
  attachments?: Attachment[],
  uploadedFiles?: { name: string; path: string }[]
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  // Add text block if content is not empty
  if (content.trim()) {
    blocks.push({ type: 'text', text: content.trim() })
  }

  // Add attachment blocks using uploaded file paths
  if (attachments && attachments.length > 0 && uploadedFiles) {
    for (let i = 0; i < uploadedFiles.length; i++) {
      const uploaded = uploadedFiles[i]
      const attachment = attachments[i]

      // Check if it's an image
      if (attachment?.type.startsWith('image/')) {
        blocks.push({
          type: 'image',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment.type,
        })
      } else {
        // Other files
        blocks.push({
          type: 'file',
          name: uploaded.name,
          path: uploaded.path,
          media_type: attachment?.type,
        })
      }
    }
  }

  return blocks
}

function mapHermesMessages(msgs: HermesMessage[]): Message[] {
  // Filter out assistant messages with empty content
  const filteredMsgs = msgs.filter(m => {
    if (m.role === 'assistant') {
      return m.content && m.content.trim() !== ''
    }
    return true
  })

  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, string>()
  for (const msg of filteredMsgs) {
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
  for (const msg of filteredMsgs) {
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
          toolCallId: tc.id,
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
        toolCallId: tcId || undefined,
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
    workspace: s.workspace || null,
  }
}

const STORAGE_KEY_PREFIX = 'hermes_active_session_'
const LEGACY_STORAGE_KEY = 'hermes_active_session'

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

function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { name?: string, code?: number }
  return e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014
}

function recoverStorageQuota() {
  try {
    // 清理所有会话相关的旧缓存（已完全废弃）
    const prefixes = [
      'hermes_sessions_cache_v1_',
      'hermes_session_msgs_v1_',
      'hermes_session_pins_v1_',
      'hermes_human_only_v1_',
    ]
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
    if (keysToRemove.length > 0) {
      console.log(`Recovered storage: cleared ${keysToRemove.length} old session cache entries`)
    }
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

function removeItem(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // ignore
  }
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
  /** sessionId → queued message count */
  const queueLengths = ref<Map<string, number>>(new Map())
  /** sessionId → queued user messages not yet visible in the transcript */
  const queuedUserMessages = ref<Map<string, Message[]>>(new Map())

  // 自动播放语音开关
  const autoPlaySpeechEnabled = ref(false)

  function setAutoPlaySpeech(enabled: boolean) {
    autoPlaySpeechEnabled.value = enabled
  }
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

  const abortState = ref<{
    aborting: boolean
    synced: boolean | null
    error?: string
  } | null>(null)
  const isAborting = computed(() => abortState.value?.aborting === true)

  function setAbortState(state: typeof abortState.value) {
    abortState.value = state
  }

  const activeSession = ref<Session | null>(null)
  const messages = computed<Message[]>(() => activeSession.value?.messages || [])

  function isSessionLive(sessionId: string): boolean {
    return streamStates.value.has(sessionId) || serverWorking.value.has(sessionId)
  }

  async function loadSessions() {
    isLoadingSessions.value = true
    try {
      const list = await fetchSessions()
      const fresh = list.map(mapHermesSession)
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const msgsByIdBefore = new Map(sessions.value.map(s => [s.id, s.messages]))
      for (const s of fresh) {
        const prev = msgsByIdBefore.get(s.id)
        if (prev && prev.length) s.messages = prev
      }
      sessions.value = fresh

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
          if (data.queueLength && data.queueLength > 0) {
            queueLengths.value.set(sessionId, data.queueLength)
          } else {
            queueLengths.value.delete(sessionId)
          }
          if ((data as any).isAborting) {
            setAbortState({ aborting: true, synced: null })
          } else if (!data.isWorking) {
            setAbortState(null)
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
              } else if (e.event === 'abort.started') {
                setAbortState({ aborting: true, synced: null })
              } else if (e.event === 'abort.completed') {
                setAbortState({ aborting: false, synced: e.synced ?? false })
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
    resumeServerWorkingRun(sessionId)
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

  function addOrUpdateSession(session: Session) {
    const existingIndex = sessions.value.findIndex(s => s.id === session.id)
    if (existingIndex !== -1) {
      // Update existing session
      sessions.value[existingIndex] = session
    } else {
      // Add new session
      sessions.value.push(session)
    }
  }

  function updateMessage(sessionId: string, id: string, update: Partial<Message>) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    const idx = s.messages.findIndex(m => m.id === id)
    if (idx !== -1) {
      s.messages[idx] = { ...s.messages[idx], ...update }
    }
  }

  function enqueueUserMessage(sessionId: string, message: Message) {
    const queue = queuedUserMessages.value.get(sessionId) || []
    queue.push({ ...message, queued: true })
    queuedUserMessages.value.set(sessionId, queue)
  }

  function removeQueuedMessage(sessionId: string, messageId: string) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.filter(message => message.id !== messageId)
    if (next.length > 0) {
      queuedUserMessages.value.set(sessionId, next)
    } else {
      queuedUserMessages.value.delete(sessionId)
    }
    queueLengths.value.set(sessionId, next.length)
    getChatRunSocket()?.emit('cancel_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function showNextQueuedUserMessage(sessionId: string) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.shift()!
    if (queue.length > 0) {
      queuedUserMessages.value.set(sessionId, queue)
    } else {
      queuedUserMessages.value.delete(sessionId)
    }
    addMessage(sessionId, { ...next, queued: false })
    updateSessionTitle(sessionId)
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

  function primeCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      primeCompletionSound()
    }
  }

  function playCompletionBellIfEnabled() {
    if (useSettingsStore().display.bell_on_complete) {
      void playCompletionSound()
    }
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if ((!content.trim() && !(attachments && attachments.length > 0))) return

    primeCompletionBellIfEnabled()

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    const shouldQueue = isSessionLive(sid)

    const userMsg: Message = {
      id: uid(),
      role: 'user',
      content: content.trim(),
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      queued: shouldQueue,
    }

    if (!shouldQueue) {
      addMessage(sid, userMsg)
      updateSessionTitle(sid)
    }

    try {

      // Build input in Anthropic format
      let input: string | ContentBlock[]
      if (attachments && attachments.length > 0) {
        // Has attachments: upload first, then build content blocks
        const uploaded = await uploadFiles(attachments)

        // Update attachment URLs on the user message for display
        const token = getApiKey()
        const urlMap = new Map(uploaded.map(f => {
          const base = `/api/hermes/download?path=${encodeURIComponent(f.path)}&name=${encodeURIComponent(f.name)}`
          return [f.name, token ? `${base}&token=${encodeURIComponent(token)}` : base]
        }))
        if (shouldQueue && userMsg.attachments) {
          userMsg.attachments = userMsg.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
        } else {
          const msgs = getSessionMsgs(sid)
          const lastUser = msgs.findLast(m => m.id === userMsg.id)
          if (lastUser?.attachments) {
            lastUser.attachments = lastUser.attachments.map(a => {
              const dl = urlMap.get(a.name)
              return dl ? { ...a, url: dl } : a
            })
          }
        }

        // Build content blocks with uploaded file paths
        input = await buildContentBlocks(content, attachments, uploaded)
      } else {
        // No attachments: use plain text format
        input = content.trim()
      }

      const appStore = useAppStore()
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const runPayload = {
        input,
        session_id: sid,
        model: sessionModel || undefined,
        queue_id: userMsg.id,
      }

      if (shouldQueue) {
        enqueueUserMessage(sid, userMsg)
      }

      // Helper to clean up this session's stream state
      const cleanup = () => {
        streamStates.value.delete(sid)
        serverWorking.value.delete(sid)
      }

      // Per-active-run flags used to detect silently-swallowed errors at run.completed.
      // hermes-agent occasionally emits run.completed with empty output and no
      // usage when the agent layer caught an upstream error (e.g. invalid API
      // key). We need to distinguish: (a) run with assistant text produced,
      // (b) run with only tool activity, (c) run with truly nothing visible.
      // Reset on every run.started because one handler may span multiple queued runs.
      let runProducedAssistantText = false
      let runHadToolActivity = false
      let activeAssistantMessageId: string | null = null

      const startNextQueuedUser = () => {
        showNextQueuedUserMessage(sid)
      }

      const closeStreamingAssistant = () => {
        const msgs = getSessionMsgs(sid)
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.isStreaming) {
            updateMessage(sid, m.id, { isStreaming: false })
          }
        })
        activeAssistantMessageId = null
      }

      // Send run via Socket.IO and listen to streamed events — all closures capture `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent
        (evt: RunEvent) => {
          switch (evt.event) {
            case 'run.started':
              setAbortState(null)
              runProducedAssistantText = false
              runHadToolActivity = false
              closeStreamingAssistant()
              startNextQueuedUser()
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
              } else {
                queueLengths.value.delete(sid)
              }
              break

            case 'run.queued': {
              queueLengths.value.set(sid, (evt as any).queue_length || 0)
              break
            }

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

            case 'abort.started': {
              setAbortState({ aborting: true, synced: null })
              break
            }

            case 'abort.completed': {
              setAbortState({ aborting: false, synced: (evt as any).synced ?? false })
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
                setAbortState(null)
                break
              }
              const msgs = getSessionMsgs(sid)
              const lastMsg = msgs[msgs.length - 1]
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              msgs.forEach((m, i) => {
                if (m.role === 'tool' && m.toolStatus === 'running') {
                  msgs[i] = { ...m, toolStatus: 'done' }
                }
              })
              cleanup()
              setAbortState(null)
              break
            }

            case 'reasoning.delta':
            case 'thinking.delta': {
              const text = evt.text || evt.delta || ''
              if (!text) break
              runProducedAssistantText = true
              const msgs = getSessionMsgs(sid)
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
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
                activeAssistantMessageId = newId
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
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : null
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
                activeAssistantMessageId = newId
              }

              break
            }

            case 'tool.started': {
              runHadToolActivity = true
              const msgs = getSessionMsgs(sid)
              const toolCallId = (evt as any).tool_call_id as string | undefined
              const last = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              if (last?.isStreaming) {
                updateMessage(sid, last.id, { isStreaming: false })
              }
              activeAssistantMessageId = null
              const existingTool = toolCallId
                ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
                : null
              if (existingTool) {
                updateMessage(sid, existingTool.id, {
                  toolName: evt.tool || evt.name,
                  toolArgs: typeof (evt as any).arguments === 'string' ? (evt as any).arguments : existingTool.toolArgs,
                  toolPreview: evt.preview || existingTool.toolPreview,
                  toolStatus: existingTool.toolStatus || 'running',
                })
                break
              }
              addMessage(sid, {
                id: uid(),
                role: 'tool',
                content: '',
                timestamp: Date.now(),
                toolName: evt.tool || evt.name,
                toolCallId,
                toolPreview: evt.preview,
                toolArgs: typeof (evt as any).arguments === 'string' ? (evt as any).arguments : undefined,
                toolStatus: 'running',
              })

              break
            }

            case 'tool.completed': {
              runHadToolActivity = true
              const msgs = getSessionMsgs(sid)
              const toolCallId = (evt as any).tool_call_id as string | undefined
              const toolMsgs = toolCallId
                ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
                : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
              if (toolMsgs.length > 0) {
                const last = toolMsgs[toolMsgs.length - 1]
                // Check if tool errored
                const hasError = (evt as any).error === true
                const duration = (evt as any).duration
                updateMessage(sid, last.id, {
                  toolStatus: hasError ? 'error' : 'done',
                  toolDuration: duration,
                  toolResult: typeof (evt as any).output === 'string' ? (evt as any).output : undefined,
                })
              }

              break
            }

            case 'run.completed': {
              const msgs = getSessionMsgs(sid)
              const lastMsg = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
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

              // Check if backend provided parsed content (from stringified array format)
              let finalOutputTrimmed = ''
              if ((evt as any).parsed_content !== undefined) {
                // Backend has parsed stringified array format, update last assistant message
                const msgs = getSessionMsgs(sid)
                const lastAssistant = activeAssistantMessageId
                  ? msgs.find(m => m.id === activeAssistantMessageId)
                  : [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant) {
                  updateMessage(sid, lastAssistant.id, {
                    content: (evt as any).parsed_content || '',
                  })
                  if ((evt as any).parsed_reasoning) {
                    updateMessage(sid, lastAssistant.id, {
                      reasoning: (evt as any).parsed_reasoning,
                    })
                  }
                  finalOutputTrimmed = ((evt as any).parsed_content || '').trim()
                }
              } else {
                // Fallback to output field (legacy behavior)
                const finalOutput =
                  typeof evt.output === 'string' ? evt.output : ''
                finalOutputTrimmed = finalOutput.trim()
                if (!runProducedAssistantText && finalOutputTrimmed !== '') {
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: finalOutput,
                    timestamp: Date.now(),
                  })
                  runProducedAssistantText = true
                }
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
              } else {
                playCompletionBellIfEnabled()
              }

              // 自动播放语音
              if (autoPlaySpeechEnabled.value) {
                const msgs = getSessionMsgs(sid)
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant?.content) {
                  // 延迟一小会儿再播放，确保 UI 更新完成
                  setTimeout(() => {
                    playMessageSpeech(lastAssistant.id, lastAssistant.content)
                  }, 300)
                }
              }

              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              updateSessionTitle(sid)
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
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
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
        undefined,
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
  function resumeServerWorkingRun(sid: string) {
    // Don't register duplicate listeners if already streaming
    if (streamStates.value.has(sid)) return
    // Only set up listeners if the server reported an active run during resume.
    if (!serverWorking.value.has(sid)) return

    let closed = false
    let runProducedAssistantText = false
    let runHadToolActivity = false
    let activeAssistantMessageId: string | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      // Unregister from global session handlers
      unregisterSessionHandlers(sid)
    }

    const startNextQueuedUser = () => {
      showNextQueuedUserMessage(sid)
    }

    const closeStreamingAssistant = () => {
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.role === 'assistant' && m.isStreaming) {
          updateMessage(sid, m.id, { isStreaming: false })
        }
      })
      activeAssistantMessageId = null
    }

    // Shared event handler — filters by session_id tag
    function handleEvent(evt: RunEvent) {
      if (closed) return
      // Filter events for this session (server tags all events with session_id)
      if (evt.session_id && evt.session_id !== sid) return
      switch (evt.event) {
        case 'run.queued': {
          queueLengths.value.set(sid, (evt as any).queue_length || 0)
          break
        }

        case 'run.started':
          setAbortState(null)
          runProducedAssistantText = false
          runHadToolActivity = false
          closeStreamingAssistant()
          startNextQueuedUser()
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
          } else {
            queueLengths.value.delete(sid)
          }
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

        case 'abort.started': {
          setAbortState({ aborting: true, synced: null })
          break
        }

        case 'abort.completed': {
          setAbortState({ aborting: false, synced: (evt as any).synced ?? false })
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
            setAbortState(null)
            break
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'done' }
            }
          })
          cleanup()
          setAbortState(null)
          break
        }

        case 'reasoning.delta':
        case 'thinking.delta': {
          const text = evt.text || evt.delta || ''
          if (!text) break
          runProducedAssistantText = true
          const msgs = getSessionMsgs(sid)
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
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
            activeAssistantMessageId = newId
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
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : null
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
            activeAssistantMessageId = newId
          }

          break
        }

        case 'tool.started': {
          runHadToolActivity = true
          const msgs = getSessionMsgs(sid)
          const toolCallId = (evt as any).tool_call_id as string | undefined
          const last = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
          if (last?.isStreaming) {
            updateMessage(sid, last.id, { isStreaming: false })
          }
          activeAssistantMessageId = null
          const existingTool = toolCallId
            ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
            : null
          if (existingTool) {
            updateMessage(sid, existingTool.id, {
              toolName: evt.tool || evt.name,
              toolArgs: typeof (evt as any).arguments === 'string' ? (evt as any).arguments : existingTool.toolArgs,
              toolPreview: evt.preview || existingTool.toolPreview,
              toolStatus: existingTool.toolStatus || 'running',
            })
            break
          }
          addMessage(sid, {
            id: uid(),
            role: 'tool',
            content: '',
            timestamp: Date.now(),
            toolName: evt.tool || evt.name,
            toolCallId,
            toolPreview: evt.preview,
            toolArgs: typeof (evt as any).arguments === 'string' ? (evt as any).arguments : undefined,
            toolStatus: 'running',
          })

          break
        }

        case 'tool.completed': {
          runHadToolActivity = true
          const msgs = getSessionMsgs(sid)
          const toolCallId = (evt as any).tool_call_id as string | undefined
          const toolMsgs = toolCallId
            ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
            : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
          if (toolMsgs.length > 0) {
            const hasError = (evt as any).error === true
            updateMessage(sid, toolMsgs[toolMsgs.length - 1].id, {
              toolStatus: hasError ? 'error' : 'done',
              toolDuration: (evt as any).duration,
              toolResult: typeof (evt as any).output === 'string' ? (evt as any).output : undefined,
            })
          }

          break
        }

        case 'run.completed': {
          const hasQueue = (evt as any).queue_remaining > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          const msgs = getSessionMsgs(sid)
          const lastMsg = activeAssistantMessageId
            ? msgs.find(m => m.id === activeAssistantMessageId)
            : msgs[msgs.length - 1]
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
          // Check if backend provided parsed content (from stringified array format)
          let finalOutputTrimmed = ''
          if ((evt as any).parsed_content !== undefined) {
            // Backend has parsed stringified array format, update last assistant message
            const msgs = getSessionMsgs(sid)
            const lastAssistant = activeAssistantMessageId
              ? msgs.find(m => m.id === activeAssistantMessageId)
              : [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant) {
              updateMessage(sid, lastAssistant.id, {
                content: (evt as any).parsed_content || '',
              })
              if ((evt as any).parsed_reasoning) {
                updateMessage(sid, lastAssistant.id, {
                  reasoning: (evt as any).parsed_reasoning,
                })
              }
              finalOutputTrimmed = ((evt as any).parsed_content || '').trim()
            }
          } else {
            // Fallback to output field (legacy behavior)
            const finalOutput = typeof evt.output === 'string' ? evt.output : ''
            finalOutputTrimmed = finalOutput.trim()
            if (!runProducedAssistantText && finalOutputTrimmed !== '') {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: finalOutput,
                timestamp: Date.now(),
              })
            }
          }
          const swallowedError = !runProducedAssistantText && !runHadToolActivity && finalOutputTrimmed === ''
          if (swallowedError) {
            addMessage(sid, {
              id: uid(),
              role: 'system',
              content: 'Error: Agent returned no output. The model call may have failed (e.g. invalid API key, model not supported by provider, or context exceeded). Check the hermes-agent logs for details.',
              timestamp: Date.now(),
            })
          } else {
            playCompletionBellIfEnabled()
          }

          // Auto-play speech for every completed assistant message
          if (autoPlaySpeechEnabled.value) {
            const msgs = getSessionMsgs(sid)
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }

          if (!hasQueue) {
            cleanup()
            activeAssistantMessageId = null
          } else {
            // More runs pending — reset for next run but don't cleanup
            activeAssistantMessageId = null
          }
          updateSessionTitle(sid)
          break
        }

        case 'run.failed': {
          const hasQueue = (evt as any).queue_remaining > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
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
          if (!hasQueue) {
            cleanup()
          }
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

    // Register handlers in global session map
    registerSessionHandlers(sid, {
      onMessageDelta: (evt) => handleEvent(evt),
      onReasoningDelta: (evt) => handleEvent(evt),
      onThinkingDelta: (evt) => handleEvent(evt),
      onReasoningAvailable: (evt) => handleEvent(evt),
      onToolStarted: (evt) => handleEvent(evt),
      onToolCompleted: (evt) => handleEvent(evt),
      onRunStarted: (evt) => handleEvent(evt),
      onRunCompleted: (evt) => handleEvent(evt),
      onRunFailed: (evt) => handleEvent(evt),
      onCompressionStarted: (evt) => handleEvent(evt),
      onCompressionCompleted: (evt) => handleEvent(evt),
      onAbortStarted: (evt) => handleEvent(evt),
      onAbortCompleted: (evt) => handleEvent(evt),
      onUsageUpdated: (evt) => handleEvent(evt),
      onRunQueued: (evt) => handleEvent(evt),
    })

    // No need to emit resume here — switchSession already did it.
    // Server already joined room and replayed events.
    // Just set up handlers for ongoing streaming events.

    // Mark as streaming so UI shows the indicator and can still abort after refresh.
    streamStates.value.set(sid, {
      abort: () => {
        getChatRunSocket()?.emit('abort', { session_id: sid })
      },
    })
  }

  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (isAborting.value) return
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      setAbortState({ aborting: true, synced: null })
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      window.setTimeout(() => {
        if (activeSessionId.value === sid && abortState.value?.aborting) {
          streamStates.value.delete(sid)
          serverWorking.value.delete(sid)
          setAbortState(null)
        }
      }, 20_000)
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && activeSessionId.value && !isStreaming.value) {
        const sid = activeSessionId.value
        if (sid && !streamStates.value.has(sid)) {
          // Re-load messages via resume (server loads from DB)
          resumeSession(sid, (data) => {
            if (data.isWorking) {
              serverWorking.value.add(sid)
            } else {
              serverWorking.value.delete(sid)
            }
            if (data.isAborting) {
              setAbortState({ aborting: true, synced: null })
            } else if (!data.isWorking) {
              setAbortState(null)
            }
            if (data.messages?.length && activeSession.value) {
              activeSession.value.messages = mapHermesMessages(data.messages as any[])
            }
            resumeServerWorkingRun(sid)
          })
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

  // 播放消息语音
  function playMessageSpeech(messageId: string, content: string) {
    // 触发自定义事件，让 MessageItem 组件处理播放
    const event = new CustomEvent('auto-play-speech', {
      detail: { messageId, content }
    })
    window.dispatchEvent(event)
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
    abortState,
    isAborting,
    queueLengths,
    queuedUserMessages,
    removeQueuedMessage,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    switchSession,
    switchSessionModel,
    addOrUpdateSession,
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
    setAutoPlaySpeech,
    playMessageSpeech,
  }
})
