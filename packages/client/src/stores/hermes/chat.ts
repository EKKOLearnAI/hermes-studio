import { startRunViaSocket, resumeSession, registerSessionHandlers, unregisterSessionHandlers, getChatRunSocket, respondToolApproval, onPeerUserMessage, onSessionCommand, onSessionTitleUpdated, respondClarify, type ChatRunTransport, type RunEvent, type ResumeSessionPayload, type StartRunRequest, type ContentBlock as ContentBlockImport } from '@/api/hermes/chat'
import { deleteSession as deleteSessionApi, fetchSessionMessagesPage, fetchSessions, setSessionModel, type HermesMessage, type SessionSummary } from '@/api/hermes/sessions'
import { getActiveProfileName } from '@/api/client'
import { inferCodingAgentApiMode, normalizeCodingAgentApiMode } from '@/api/coding-agents'
import { getDownloadUrl } from '@/api/hermes/download'
import type { ProviderApiMode } from '@/api/hermes/system'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { useAppStore } from './app'
import { useProfilesStore } from './profiles'
import { useSettingsStore } from './settings'
import { primeCompletionSound, playCompletionSound } from '@/utils/completion-sound'
import { showCompletionNotification } from '@/utils/completion-notification'
import { detectThinkingBoundary } from '@/utils/thinking-parser'
import { isKnownBridgeSessionCommand } from '@/utils/hermes/bridge-session-commands'
import { responseErrorMessage } from '@/utils/http-error'

// Re-export ContentBlock for convenience
export type ContentBlock = ContentBlockImport

export const LIVE_CHAT_MESSAGE_PAGE_SIZE = 150
export const LIVE_CHAT_MAX_LOADED_MESSAGES = 300

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
  role: 'user' | 'assistant' | 'system' | 'tool' | 'command'
  content: string
  timestamp: number
  toolName?: string
  toolCallId?: string
  toolPreview?: string
  toolArgs?: unknown
  toolResult?: unknown
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
  systemType?: 'command' | 'error'
  commandAction?: string
  commandData?: Record<string, unknown>
  finishReason?: string | null
  runMarker?: string | null
}

export interface PendingApproval {
  sessionId: string
  approvalId: string
  command: string
  description: string
  choices: Array<'once' | 'session' | 'always' | 'deny'>
  allowPermanent: boolean
  isMemoryWrite: boolean
  requestedAt: number
}

export interface PendingClarify {
  sessionId: string
  clarifyId: string
  question: string
  choices: string[] | null
  timeoutMs: number
  requestedAt: number
}

export interface Session {
  id: string
  profile?: string
  title: string
  source?: string
  agent?: string
  agentSessionId?: string
  agentNativeSessionId?: string
  codingAgentId?: 'claude-code' | 'codex'
  codingAgentMode?: 'global' | 'scoped'
  messages: Message[]
  createdAt: number
  updatedAt: number
  model?: string
  provider?: string
  baseUrl?: string
  apiKey?: string
  apiMode?: ProviderApiMode
  messageCount?: number
  messageTotal?: number
  loadedMessageCount?: number
  hasMoreBefore?: boolean
  isLoadingOlderMessages?: boolean
  inputTokens?: number
  outputTokens?: number
  contextTokens?: number
  endedAt?: number | null
  lastActiveAt?: number
  workspace?: string | null
  /** Per-session reasoning effort override.
   * Empty string / undefined = use config.yaml default.
   * Values: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' */
  reasoningEffort?: string
}

interface CompressionState {
  compressing: boolean
  messageCount: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean | null
  error?: string
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function isToolOutputError(output: unknown): boolean {
  if (typeof output !== 'string' || !output.trim()) return false
  try {
    const parsed = JSON.parse(output)
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (record.success === false) return true
      if (record.error != null && String(record.error).trim() !== '') return true
    }
  } catch {
    return false
  }
  return false
}

function errorMessageText(error: unknown): string {
  if (typeof error === 'string') return error.trim()
  if (error == null) return ''
  if (typeof error !== 'object') return String(error).trim()

  if (Array.isArray(error)) {
    return error.map(errorMessageText).filter(Boolean).join('\n')
  }

  const record = error as Record<string, unknown>
  for (const key of ['message', 'error', 'detail', 'description', 'code']) {
    const text = errorMessageText(record[key])
    if (text) return text
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

async function uploadFiles(attachments: Attachment[]): Promise<{ name: string; path: string }[]> {
  if (attachments.length === 0) return []
  const formData = new FormData()
  for (const att of attachments) {
    if (att.file) formData.append('file', att.file, att.name)
  }
  const token = localStorage.getItem('hermes_api_key') || ''
  const profileName = getActiveProfileName()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (profileName) headers['X-Hermes-Profile'] = profileName
  const res = await fetch('/upload', {
    method: 'POST',
    body: formData,
    headers,
  })
  if (!res.ok) throw new Error(await responseErrorMessage(res, 'Upload failed'))
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

function hasRuntimeToolPayload(value: unknown): boolean {
  return value !== null && value !== undefined && value !== ''
}

function runtimeToolPayloadOrUndefined(value: unknown): unknown | undefined {
  return hasRuntimeToolPayload(value) ? value : undefined
}

function runtimePayloadText(value: unknown): string {
  if (!hasRuntimeToolPayload(value)) return ''
  if (typeof value === 'string') return value
  try {
    const serialized = JSON.stringify(value)
    if (serialized !== undefined) return serialized
  } catch {
    // Fall through to String(value) for non-serializable runtime payloads.
  }
  return String(value)
}

function runtimeToolOutputHasError(value: unknown): boolean {
  return typeof value === 'string' && isToolOutputError(value)
}

function readFinishReason(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'finishReason')) {
    return (record as { finishReason?: string | null }).finishReason
  }
  if (Object.prototype.hasOwnProperty.call(record, 'finish_reason')) {
    return (record as { finish_reason?: string | null }).finish_reason
  }
  return undefined
}

function readRunMarker(value: unknown): string | null | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, 'runMarker')) {
    return typeof record.runMarker === 'string' || record.runMarker == null
      ? record.runMarker as string | null
      : undefined
  }
  if (Object.prototype.hasOwnProperty.call(record, 'run_marker')) {
    return typeof record.run_marker === 'string' || record.run_marker == null
      ? record.run_marker as string | null
      : undefined
  }
  return undefined
}

function hasAssistantVisibleText(message: Message | null | undefined): boolean {
  if (!message) return false
  return message.content.trim() !== '' || (message.reasoning?.trim() ?? '') !== ''
}

function selectResumedInFlightAssistant(messages: Message[], activeRunMarker?: string | null): Message | null {
  if (messages.length === 0) return null
  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role !== 'assistant') return null
  const finishReason = readFinishReason(lastMessage)
  const runMarker = readRunMarker(lastMessage)
  const hasMatchingRunMarker = !!activeRunMarker && !!runMarker && runMarker === activeRunMarker
  return finishReason === null || hasMatchingRunMarker ? lastMessage : null
}

function getReplayRunMarker(events?: Array<{ event: string; data: RunEvent }>): string | null {
  if (!Array.isArray(events)) return null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const runMarker = readRunMarker(events[i]?.data)
    if (typeof runMarker === 'string' && runMarker.trim() !== '') return runMarker
  }
  return null
}

function resolveResumedAssistantState(
  messages: Message[],
  options: {
    previousActiveAssistantMessageId?: string | null
    previousReasoningAssistantMessageId?: string | null
    activeRunMarker?: string | null
  },
): {
  activeAssistant: Message | null
  reasoningAssistant: Message | null
  runMarker: string | null
  hadVisibleText: boolean
} {
  const activeAssistant = options.previousActiveAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousActiveAssistantMessageId) || null
    : null
  const selectedActiveAssistant = activeAssistant || selectResumedInFlightAssistant(messages, options.activeRunMarker)
  const reasoningAssistant = options.previousReasoningAssistantMessageId
    ? messages.find(m => m.role === 'assistant' && m.id === options.previousReasoningAssistantMessageId) || null
    : null
  const selectedReasoningAssistant = reasoningAssistant || (selectedActiveAssistant?.reasoning ? selectedActiveAssistant : null)
  const selectedRunMarker = readRunMarker(selectedActiveAssistant) ?? options.activeRunMarker ?? null
  return {
    activeAssistant: selectedActiveAssistant,
    reasoningAssistant: selectedReasoningAssistant,
    runMarker: selectedRunMarker,
    hadVisibleText: hasAssistantVisibleText(selectedActiveAssistant),
  }
}

function mapHermesMessages(msgs: HermesMessage[]): Message[] {
  // Filter out assistant messages with no display content unless they carry tool call metadata
  // needed to name later tool result rows when resuming persisted history.
  const filteredMsgs = msgs.filter(m => {
    if (m.role === 'assistant') {
      return (m.tool_calls?.length || 0) > 0 || runtimePayloadText((m as any).content).trim() !== ''
    }
    return true
  })

  // Build lookups from assistant messages with tool_calls
  const toolNameMap = new Map<string, string>()
  const toolArgsMap = new Map<string, unknown>()
  for (const msg of filteredMsgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) {
          if (tc.function?.name) toolNameMap.set(tc.id, tc.function.name)
          if (hasRuntimeToolPayload(tc.function?.arguments)) toolArgsMap.set(tc.id, tc.function.arguments)
        }
      }
    }
  }

  const result: Message[] = []
  for (const msg of filteredMsgs) {
    // Skip assistant messages that only contain tool_calls (no meaningful content)
    if (msg.role === 'assistant' && msg.tool_calls?.length && !runtimePayloadText((msg as any).content).trim()) {
      // Emit a tool.started message for each tool call
      for (const tc of msg.tool_calls) {
        result.push({
          id: String(msg.id) + '_' + tc.id,
          role: 'tool',
          content: '',
          timestamp: Math.round(msg.timestamp * 1000),
          toolName: tc.function?.name || undefined,
          toolCallId: tc.id,
          toolArgs: runtimeToolPayloadOrUndefined(tc.function?.arguments),
          toolStatus: 'done',
          finishReason: readFinishReason(msg),
          runMarker: readRunMarker(msg),
        })
      }
      continue
    }

    // Tool result messages
    if (msg.role === 'tool') {
      const tcId = msg.tool_call_id || ''
      const toolName = msg.tool_name || toolNameMap.get(tcId) || undefined
      const toolArgs = toolArgsMap.has(tcId) ? toolArgsMap.get(tcId) : undefined
      // Extract a short preview from the content
      let preview = ''
      const contentText = runtimePayloadText((msg as any).content)
      if (contentText) {
        try {
          const parsed = typeof (msg as any).content === 'string'
            ? JSON.parse(contentText)
            : (msg as any).content
          preview = parsed?.url || parsed?.title || parsed?.preview || parsed?.summary || ''
        } catch {
          preview = contentText.slice(0, 80)
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
        toolResult: runtimeToolPayloadOrUndefined((msg as any).content),
        toolStatus: 'done',
        finishReason: readFinishReason(msg),
        runMarker: readRunMarker(msg),
      })
      continue
    }

    // Normal user/assistant/command messages
    const displayRole = msg.display_role || msg.role
    const displayContent = msg.display_content ?? msg.content
    result.push({
      id: String(msg.id),
      role: displayRole,
      content: displayContent || '',
      timestamp: Math.round(msg.timestamp * 1000),
      reasoning: msg.reasoning ? msg.reasoning : undefined,
      systemType: displayRole === 'command' ? 'command' : undefined,
      finishReason: readFinishReason(msg),
      runMarker: readRunMarker(msg),
    })
  }
  return result
}

function sessionActivitySeconds(s: SessionSummary): number {
  return Math.max(
    s.started_at || 0,
    s.ended_at || 0,
    s.last_active || 0,
  )
}

function mapHermesSession(s: SessionSummary): Session {
  const isCodingAgentSession = s.source === 'coding_agent' || s.agent === 'claude' || s.agent === 'codex'
  const codingAgentId = s.agent === 'codex' ? 'codex' : s.agent === 'claude' ? 'claude-code' : undefined
  const codingAgentMode = isCodingAgentSession
    ? (s.agent_mode === 'global' || s.agent_mode === 'scoped'
        ? s.agent_mode
        : s.provider === 'global' ? 'global' : 'scoped')
    : undefined
  const activitySeconds = sessionActivitySeconds(s)
  return {
    id: s.id,
    profile: s.profile || 'default',
    title: s.title || '',
    source: s.source || undefined,
    agent: s.agent || undefined,
    agentSessionId: s.agent_session_id || undefined,
    agentNativeSessionId: s.agent_native_session_id || undefined,
    codingAgentId,
    codingAgentMode,
    messages: [],
    createdAt: Math.round(s.started_at * 1000),
    updatedAt: Math.round(activitySeconds * 1000),
    model: s.model,
    provider: s.provider || (s as any).billing_provider || '',
    messageCount: s.message_count,
    messageTotal: s.message_count,
    loadedMessageCount: 0,
    hasMoreBefore: false,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    endedAt: s.ended_at != null ? Math.round(s.ended_at * 1000) : null,
    lastActiveAt: s.last_active != null ? Math.round(s.last_active * 1000) : undefined,
    workspace: s.workspace || null,
  }
}

const STORAGE_KEY_PREFIX = 'hermes_active_session_'
type ChatRuntimeMode = 'default' | 'global_agent'
let activeRuntimeMode: ChatRuntimeMode = 'default'
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

function runtimeStoragePrefix(): string {
  return activeRuntimeMode === 'global_agent' ? `${STORAGE_KEY_PREFIX}global_agent_` : STORAGE_KEY_PREFIX
}

function storageKey(): string { return runtimeStoragePrefix() + getProfileName() }
function legacyStorageKey(): string | null { return activeRuntimeMode === 'default' && getProfileName() === 'default' ? LEGACY_STORAGE_KEY : null }

function isCodingAgentLikeSession(session?: Pick<Session, 'source' | 'agent' | 'codingAgentId'> | null): boolean {
  return session?.source === 'coding_agent' ||
    session?.codingAgentId === 'claude-code' ||
    session?.codingAgentId === 'codex' ||
    session?.agent === 'claude' ||
    session?.agent === 'codex'
}

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

function getItemBestEffort(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
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
  const runtimeMode = ref<ChatRuntimeMode>(activeRuntimeMode)
  const seenSessionCommandEvents = new WeakSet<RunEvent>()
  const sessions = ref<Session[]>([])
  const activeSessionId = ref<string | null>(null)
  const focusMessageId = ref<string | null>(null)
  const streamStates = ref<Map<string, { abort: () => void }>>(new Map())
  /** sessionId → server-reported isWorking status */
  const serverWorking = ref<Set<string>>(new Set())
  /** Sessions that completed while the user was viewing another session. */
  const completedUnreadSessions = ref<Set<string>>(new Set())
  const sessionProfileFilter = ref<string | null>(null)
  /** sessionId → queued message count */
  const queueLengths = ref<Map<string, number>>(new Map())
  /** sessionId → queued user messages not yet visible in the transcript */
  const queuedUserMessages = ref<Map<string, Message[]>>(new Map())
  /** sessionId → queue ids that server reported as dequeued before the peer message arrived */
  const dequeuedQueueIds = ref<Map<string, Set<string>>>(new Map())
  const pendingApprovals = ref<Map<string, PendingApproval>>(new Map())
  const activePendingApproval = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingApprovals.value.get(sid) || null : null
  })

  const pendingClarifies = ref<Map<string, PendingClarify>>(new Map())
  const activePendingClarify = computed(() => {
    const sid = activeSessionId.value
    return sid ? pendingClarifies.value.get(sid) || null : null
  })

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

  async function fetchRuntimeSessions(profile?: string | null): Promise<SessionSummary[]> {
    const scopedProfile = profile || undefined
    if (runtimeMode.value === 'global_agent') return fetchSessions('global_agent', undefined, scopedProfile)

    const [localSessions, globalSessions] = await Promise.all([
      fetchSessions(undefined, undefined, scopedProfile),
      fetchSessions('global_agent', undefined, scopedProfile),
    ])
    const byId = new Map<string, SessionSummary>()
    for (const session of [...localSessions, ...globalSessions]) byId.set(session.id, session)
    return [...byId.values()].sort((a, b) =>
      sessionActivitySeconds(b) - sessionActivitySeconds(a),
    )
  }

  function runtimeTransport(): ChatRunTransport {
    return runtimeMode.value === 'global_agent' ? 'global-agent' : 'chat-run'
  }

  function setRuntimeMode(mode: ChatRuntimeMode) {
    if (runtimeMode.value === mode) return
    activeRuntimeMode = mode
    runtimeMode.value = mode
    sessions.value = []
    completedUnreadSessions.value = new Set()
    queueLengths.value = new Map()
    queuedUserMessages.value = new Map()
    pendingApprovals.value = new Map()
    pendingClarifies.value = new Map()
    streamStates.value = new Map()
    serverWorking.value = new Set()
    sessionsLoaded.value = false
    clearActiveSession()
  }

  // Compression state is scoped per session because sockets can stay joined to
  // background sessions while another chat is active.
  const compressionStates = ref<Map<string, CompressionState>>(new Map())
  const compressionState = computed<CompressionState | null>(() => {
    const sid = activeSessionId.value
    return sid ? compressionStates.value.get(sid) || null : null
  })

  function setCompressionState(sessionId: string | null | undefined, state: CompressionState | null) {
    if (!sessionId) return
    const next = new Map(compressionStates.value)
    if (state) next.set(sessionId, state)
    else next.delete(sessionId)
    compressionStates.value = next
  }

  const abortState = ref<{
    aborting: boolean
    synced: boolean | null
    timedOut?: boolean
    message?: string
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

  function isSessionCompletedUnread(sessionId: string): boolean {
    return completedUnreadSessions.value.has(sessionId)
  }

  function clearSessionCompletedUnread(sessionId: string) {
    if (!completedUnreadSessions.value.has(sessionId)) return
    const next = new Set(completedUnreadSessions.value)
    next.delete(sessionId)
    completedUnreadSessions.value = next
  }

  function markSessionCompletedUnread(sessionId: string, hasQueue = false) {
    if (hasQueue) {
      return
    }
    if (activeSessionId.value === sessionId) {
      clearSessionCompletedUnread(sessionId)
      return
    }
    const next = new Set(completedUnreadSessions.value)
    next.add(sessionId)
    completedUnreadSessions.value = next
  }

  function pruneCompletedUnreadSessions(existingIds: Set<string>) {
    const next = new Set([...completedUnreadSessions.value].filter(id => existingIds.has(id)))
    if (next.size !== completedUnreadSessions.value.size) completedUnreadSessions.value = next
  }

  function clearActiveSession() {
    const sid = activeSessionId.value
    activeSessionId.value = null
    activeSession.value = null
    focusMessageId.value = null
    setAbortState(null)
    setCompressionState(sid, null)
    removeItem(storageKey())
  }

  async function loadSessions(profile?: string | null, preferredSessionId?: string | null) {
    isLoadingSessions.value = true
    try {
      const list = await fetchRuntimeSessions(profile)
      const fresh = list.map(mapHermesSession)
      // Preserve already-loaded messages for sessions that are still present,
      // so we don't blow away the active session's messages on refresh.
      const runtimeByIdBefore = new Map(sessions.value.map(s => [s.id, {
        messages: s.messages,
        contextTokens: s.contextTokens,
      }]))
      for (const s of fresh) {
        const prev = runtimeByIdBefore.get(s.id)
        if (prev?.messages?.length) s.messages = prev.messages
        if (prev?.contextTokens != null) s.contextTokens = prev.contextTokens
      }
      sessions.value = fresh
      pruneCompletedUnreadSessions(new Set(sessions.value.map(s => s.id)))

      // Restore route-selected session first (tab-local source of truth),
      // then current in-memory session, then persisted legacy/default choice,
      // then fallback to the most recent session.
      const currentId = activeSessionId.value
      const legacyActiveKey = legacyStorageKey()
      const storedId = getItemBestEffort(storageKey()) || (legacyActiveKey ? getItemBestEffort(LEGACY_STORAGE_KEY) : null)
      const targetId = preferredSessionId && sessions.value.some(s => s.id === preferredSessionId)
        ? preferredSessionId
        : currentId && sessions.value.some(s => s.id === currentId)
          ? currentId
          : storedId && sessions.value.some(s => s.id === storedId)
            ? storedId
            : sessions.value[0]?.id
      if (targetId) {
        await switchSession(targetId)
      } else {
        clearActiveSession()
      }
    } catch (err) {
      console.error('Failed to load sessions:', err)
    } finally {
      isLoadingSessions.value = false
      sessionsLoaded.value = true
    }
  }

  // Refresh ONLY the session list metadata (titles, ordering, new/removed
  // sessions) without switching the active session or reloading its messages.
  // Used for live sync so sessions created elsewhere (CLI, Telegram, another
  // device) appear without a manual reload. Skips while streaming to avoid
  // churn.
  //
  // CRITICAL: this MERGES IN-PLACE into the existing session objects instead of
  // replacing the array with `mapHermesSession` clones. `activeSession` is a ref
  // bound to a specific object inside `sessions.value` (see switchSession), and
  // streaming deltas mutate that same object via `sessions.value.find(...)`. If
  // we swapped in fresh objects, `activeSession.value` would point at an orphan
  // and live messages would stop appearing until a manual reload. Mutating the
  // existing objects preserves referential identity so streaming keeps working.
  async function refreshSessionListOnly(profile?: string | null): Promise<void> {
    if (isStreaming.value) return
    if (isLoadingSessions.value) return
    try {
      const list = await fetchRuntimeSessions(profile ?? sessionProfileFilter.value)
      const incoming = list.map(mapHermesSession)
      const existingById = new Map(sessions.value.map(s => [s.id, s]))
      const incomingIds = new Set(incoming.map(s => s.id))

      // Build the next array reusing existing objects (identity-preserving) and
      // inserting genuinely-new sessions as fresh objects.
      const next: Session[] = []
      for (const fresh of incoming) {
        const existing = existingById.get(fresh.id)
        if (existing) {
          // Update scalar metadata in-place; never touch runtime/scroll state
          // (messages, loadedMessageCount, hasMoreBefore, contextTokens).
          existing.title = fresh.title
          existing.source = fresh.source
          existing.updatedAt = fresh.updatedAt
          existing.lastActiveAt = fresh.lastActiveAt
          existing.endedAt = fresh.endedAt
          existing.model = fresh.model
          existing.provider = fresh.provider
          existing.messageCount = fresh.messageCount
          existing.inputTokens = fresh.inputTokens
          existing.outputTokens = fresh.outputTokens
          existing.workspace = fresh.workspace
          // messageTotal: keep the larger of server count vs what we've loaded,
          // so we don't shrink below already-rendered messages mid-session.
          if (fresh.messageTotal != null) {
            existing.messageTotal = Math.max(fresh.messageTotal, existing.loadedMessageCount || 0)
          }
          next.push(existing)
        } else {
          next.push(fresh)
        }
      }

      // Keep the active session even if the server no longer lists it (don't
      // pull the rug out from under what the user is viewing).
      const activeId = activeSessionId.value
      if (activeId && !incomingIds.has(activeId)) {
        const keep = existingById.get(activeId)
        if (keep) next.push(keep)
      }

      sessions.value = next
      pruneCompletedUnreadSessions(new Set(next.map(s => s.id)))

      // Defensive: re-bind activeSession to the (same) object now in the array,
      // by id, in case anything above changed array membership.
      if (activeId) {
        const again = sessions.value.find(s => s.id === activeId)
        if (again && activeSession.value !== again) activeSession.value = again
      }
    } catch (err) {
      console.error('Failed to refresh session list:', err)
    }
  }

  // Re-pull active session from server. Used on tab-visible events.
  async function refreshActiveSession(): Promise<boolean> {
    const sid = activeSessionId.value
    if (!sid) return false
    try {
      const target = sessions.value.find(s => s.id === sid)
      if (!target) return false
      const limit = Math.min(
        Math.max(target.loadedMessageCount || LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MESSAGE_PAGE_SIZE),
        LIVE_CHAT_MAX_LOADED_MESSAGES,
      )
      const detail = await fetchSessionMessagesPage(sid, 0, limit, activeSession.value?.profile)
      if (!detail) return false
      const mapped = mapHermesMessages(detail.messages || [])
      target.messages = mapped
      target.loadedMessageCount = detail.messages.length
      target.messageTotal = detail.total
      target.messageCount = detail.total
      target.hasMoreBefore = detail.hasMore
      if (detail.session.title) target.title = detail.session.title
      return true
    } catch (err) {
      console.error('Failed to refresh active session:', err)
      return false
    }
  }


  function createSession(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent'
    agent?: 'hermes' | 'claude' | 'codex'
    codingAgentId?: 'claude-code' | 'codex'
    codingAgentMode?: 'global' | 'scoped'
    workspace?: string | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const source = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || (options.agent === 'codex' ? 'codex' : options.agent === 'claude' ? 'claude-code' : undefined)
    const codingAgentMode = codingAgentId ? (options.codingAgentMode || 'scoped') : undefined
    const session: Session = {
      id: uid(),
      profile: options.profile || useProfilesStore().activeProfileName || 'default',
      title: '',
      source,
      agent: options.agent || (codingAgentId ? (codingAgentId === 'codex' ? 'codex' : 'claude') : 'hermes'),
      codingAgentId,
      codingAgentMode,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: options.model || undefined,
      provider: options.provider || '',
      workspace: options.workspace || null,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    }
    sessions.value.unshift(session)
    return session
  }

  function newCliSession(): Session {
    const now = new Date()
    const ts = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
      '_',
      String(now.getHours()).padStart(2, '0'),
      String(now.getMinutes()).padStart(2, '0'),
      String(now.getSeconds()).padStart(2, '0'),
    ].join('')
    const hex = Math.random().toString(16).slice(2, 8)
    const session: Session = {
      id: `${ts}_${hex}`,
      title: '',
      source: runtimeMode.value === 'global_agent' ? 'global_agent' : 'cli',
      agent: 'hermes',
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
    clearSessionCompletedUnread(sessionId)

    if (!activeSession.value) return

    isLoadingMessages.value = true

    try {
      // Load messages via Socket.IO resume (server loads from DB if not in memory)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('resume timeout')), 15_000)
        resumeSession(sessionId, (data) => {
          clearTimeout(timeout)
          if (data.session_id !== sessionId || activeSessionId.value !== sessionId) {
            resolve()
            return
          }
          const target = sessions.value.find(s => s.id === sessionId)
          if (!target) {
            resolve()
            return
          }
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
          if (Array.isArray((data as any).queueMessages)) {
            replaceQueuedUserMessages(sessionId, normalizeQueuedUserMessages((data as any).queueMessages))
          } else if (!data.queueLength) {
            replaceQueuedUserMessages(sessionId, [])
          }
          if ((data as any).isAborting) {
            setAbortState({ aborting: true, synced: null })
          } else if (!data.isWorking) {
            setAbortState(null)
          }
          if (!data.isWorking) setCompressionState(sessionId, null)
          if (data.inputTokens != null) target.inputTokens = data.inputTokens
          if (data.outputTokens != null) target.outputTokens = data.outputTokens
          if ((data as any).contextTokens != null) target.contextTokens = (data as any).contextTokens
          if (data.messages?.length) {
            target.messages = mapHermesMessages(data.messages as any[])
            target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
            target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
            target.messageCount = target.messageTotal
            target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal
          }
          if (!target.title) {
            const firstUser = target.messages.find(m => m.role === 'user')
            if (firstUser) {
              const t = firstUser.content.slice(0, 40)
              target.title = t + (firstUser.content.length > 40 ? '...' : '')
            }
          }
          activeSession.value = target
          // Process replayed events (compression state etc.)
          if (data.events?.length) {
            for (const evt of data.events) {
              const e = evt.data as any
              if (e.event === 'compression.started') {
                setCompressionState(sessionId, {
                  compressing: true,
                  messageCount: e.message_count || 0,
                  beforeTokens: e.token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
              } else if (e.event === 'compression.completed') {
                const afterTokens = e.contextTokens || e.afterTokens || 0
                setCompressionState(sessionId, {
                  compressing: false,
                  messageCount: e.totalMessages || 0,
                  beforeTokens: e.beforeTokens || 0,
                  afterTokens,
                  compressed: e.compressed ?? false,
                  error: e.error,
                })
                if (e.contextTokens != null) target.contextTokens = e.contextTokens
              } else if (e.event === 'abort.started') {
                setAbortState({ aborting: true, synced: null })
              } else if (e.event === 'abort.timeout') {
                setAbortState({ aborting: true, synced: false, timedOut: true, message: (e as any).message })
              } else if (e.event === 'abort.completed') {
                setAbortState({ aborting: false, synced: e.synced ?? false })
              } else if (e.event === 'approval.requested') {
                setPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'approval.resolved') {
                clearPendingApproval({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.requested') {
                setPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'clarify.resolved') {
                clearPendingClarify({ ...e, session_id: sessionId } as RunEvent)
              } else if (e.event === 'run.failed') {
                addAgentErrorMessage(sessionId, e.error)
                serverWorking.value.delete(sessionId)
                queueLengths.value.delete(sessionId)
              } else if (e.event === 'agent.event' || e.event === 'run.reattach_failed') {
                handleAgentEvent(e)
              } else if (e.event === 'tool.started') {
                const msgs = getSessionMsgs(sessionId)
                const toolCallId = e.tool_call_id as string | undefined
                const existingTool = toolCallId
                  ? msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
                  : null
                if (existingTool) {
                  updateMessage(sessionId, existingTool.id, {
                    toolName: e.tool || e.name,
                    toolArgs: hasRuntimeToolPayload((e as any).arguments) ? (e as any).arguments : existingTool.toolArgs,
                    toolPreview: e.preview || existingTool.toolPreview,
                    toolStatus: existingTool.toolStatus || 'running',
                  })
                } else {
                  addMessage(sessionId, {
                    id: uid(),
                    role: 'tool',
                    content: '',
                    timestamp: Date.now(),
                    toolName: e.tool || e.name,
                    toolCallId,
                    toolPreview: e.preview,
                    toolArgs: runtimeToolPayloadOrUndefined((e as any).arguments),
                    toolStatus: 'running',
                  })
                }
              } else if (e.event === 'tool.completed') {
                const msgs = getSessionMsgs(sessionId)
                const toolCallId = e.tool_call_id as string | undefined
                const toolMsgs = toolCallId
                  ? msgs.filter(m => m.role === 'tool' && m.toolCallId === toolCallId)
                  : msgs.filter(m => m.role === 'tool' && m.toolStatus === 'running')
                if (toolMsgs.length > 0) {
                  const output = runtimeToolPayloadOrUndefined((e as any).output)
                  updateMessage(sessionId, toolMsgs[toolMsgs.length - 1].id, {
                    toolStatus: e.error === true || runtimeToolOutputHasError(output) ? 'error' : 'done',
                    toolDuration: e.duration,
                    toolResult: output,
                  })
                }
              } else if (String(e.event || '').startsWith('subagent.')) {
                handleSubagentEvent(sessionId, e as RunEvent)
              }
            }
          }
          resolve()
        }, activeSession.value?.profile, runtimeTransport())
      })
    } catch (err) {
      console.error('Failed to load session messages via resume:', err)
    } finally {
      isLoadingMessages.value = false
    }

    // Resume in-flight run event listeners if needed
    if (activeSessionId.value === sessionId) {
      resumeServerWorkingRun(sessionId)
    }
  }

  async function loadOlderMessages(sessionId = activeSessionId.value): Promise<boolean> {
    if (!sessionId) return false
    const target = sessions.value.find(s => s.id === sessionId)
    if (!target || target.isLoadingOlderMessages || !target.hasMoreBefore) return false
    const offset = target.loadedMessageCount || 0
    if (offset >= LIVE_CHAT_MAX_LOADED_MESSAGES) return false
    const limit = Math.min(LIVE_CHAT_MESSAGE_PAGE_SIZE, LIVE_CHAT_MAX_LOADED_MESSAGES - offset)
    target.isLoadingOlderMessages = true
    try {
      const page = await fetchSessionMessagesPage(sessionId, offset, limit, target.profile)
      if (!page || page.messages.length === 0) {
        target.hasMoreBefore = false
        return false
      }

      const existingIds = new Set(target.messages.map(message => message.id))
      const olderMessages = mapHermesMessages(page.messages).filter(message => !existingIds.has(message.id))
      target.messages = [...olderMessages, ...target.messages]
      target.loadedMessageCount = offset + page.messages.length
      target.messageTotal = page.total
      target.messageCount = page.total
      target.hasMoreBefore = page.hasMore
      return olderMessages.length > 0
    } catch (err) {
      console.error('Failed to load older session messages:', err)
      return false
    } finally {
      target.isLoadingOlderMessages = false
    }
  }

  function newChat(options: {
    profile?: string
    model?: string
    provider?: string
    source?: 'api_server' | 'cli' | 'coding_agent' | 'global_agent'
    agent?: 'hermes' | 'claude' | 'codex'
    codingAgentId?: 'claude-code' | 'codex'
    codingAgentMode?: 'global' | 'scoped'
    workspace?: string | null
    baseUrl?: string
    apiKey?: string
    apiMode?: ProviderApiMode
  } = {}): Session {
    const appStore = useAppStore()
    const storageSource = runtimeMode.value === 'global_agent' ? 'global_agent' : options.source || 'cli'
    const codingAgentId = options.codingAgentId || (options.agent === 'codex' ? 'codex' : options.agent === 'claude' ? 'claude-code' : undefined)
    const isGlobalCodingAgent = Boolean(codingAgentId) && options.codingAgentMode === 'global'
    const session = createSession({
      profile: options.profile,
      model: isGlobalCodingAgent ? undefined : options.model || appStore.selectedModel || undefined,
      provider: isGlobalCodingAgent ? '' : options.provider || appStore.selectedProvider || '',
      source: storageSource,
      agent: options.agent,
      codingAgentId,
      codingAgentMode: options.codingAgentMode,
      workspace: options.workspace,
      baseUrl: options.baseUrl,
      apiKey: options.apiKey,
      apiMode: options.apiMode,
    })
    void switchSession(session.id)
    return session
  }

  async function switchSessionModel(modelId: string, provider?: string, sessionId?: string): Promise<boolean> {
    const targetId = sessionId || activeSession.value?.id
    if (!targetId) return false
    const ok = await setSessionModel(targetId, modelId, provider || '')
    if (!ok) return false
    const target = sessions.value.find(s => s.id === targetId)
    if (target) {
      target.model = modelId
      target.provider = provider || ''
    }
    if (activeSession.value?.id === targetId) {
      activeSession.value.model = modelId
      activeSession.value.provider = provider || ''
    }
    return true
  }

  async function deleteSession(sessionId: string): Promise<boolean> {
    const target = sessions.value.find(s => s.id === sessionId)
    const ok = await deleteSessionApi(sessionId, target?.profile)
    if (!ok) return false
    sessions.value = sessions.value.filter(s => s.id !== sessionId)
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0) {
        await switchSession(sessions.value[0].id)
      } else {
        const session = createSession()
        switchSession(session.id)
      }
    }
    return true
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

  function settleRunningTools(sessionId: string, status: 'done' | 'error') {
    const msgs = getSessionMsgs(sessionId)
    msgs.forEach((m, i) => {
      if (m.role === 'tool' && m.toolStatus === 'running') {
        msgs[i] = { ...m, toolStatus: status }
      }
    })
  }

  function clearAgentEventMessages(sessionId: string) {
    const s = sessions.value.find(s => s.id === sessionId)
    if (!s) return
    s.messages = s.messages.filter(m => m.commandAction !== 'agent.event')
  }

  function handleSubagentEvent(sessionId: string, evt: RunEvent) {
    const eventName = String(evt.event || '')
    if (!eventName.startsWith('subagent.')) return

    const subagentId = String((evt as any).subagent_id || `${(evt as any).task_index ?? 0}`)
    const toolCallId = `subagent:${evt.run_id || 'run'}:${subagentId}`
    const taskIndex = Number((evt as any).task_index ?? 0)
    const taskCount = Number((evt as any).task_count ?? 1)
    const label = `${taskIndex + 1}/${Math.max(1, taskCount || 1)}`
    const toolName = String((evt as any).tool || (evt as any).name || '')
    const toolCount = Number((evt as any).tool_count || 0)
    const goal = String((evt as any).goal || '').trim()
    const text = String(evt.text || evt.preview || '').trim()
    const summary = String((evt as any).summary || '').trim()
    const duration = Number((evt as any).duration_seconds ?? (evt as any).duration)

    let preview = text || summary || goal
    if (eventName === 'subagent.start') {
      preview = `subagent ${label} started${goal ? `: ${goal}` : ''}`
    } else if (eventName === 'subagent.tool') {
      const prefix = `subagent ${label}${toolCount ? ` turn ${toolCount}` : ''}`
      preview = `${prefix}${toolName ? `: ${toolName}` : ''}${text ? ` - ${text}` : ''}`
    } else if (eventName === 'subagent.progress') {
      preview = `subagent ${label}: ${text || 'working'}`
    } else if (eventName === 'subagent.complete') {
      const status = String((evt as any).status || 'completed')
      preview = `subagent ${label} ${status}${summary ? `: ${summary}` : ''}`
    }

    const msgs = getSessionMsgs(sessionId)
    const existing = msgs.find(m => m.role === 'tool' && m.toolCallId === toolCallId)
    const toolStatus = eventName === 'subagent.complete'
      ? ((evt as any).status && String((evt as any).status) !== 'completed' ? 'error' : 'done')
      : 'running'
    const update: Partial<Message> = {
      toolName: 'delegate_task',
      toolCallId,
      toolPreview: preview.slice(0, 220),
      toolStatus,
      toolDuration: Number.isFinite(duration) ? duration : undefined,
      toolResult: eventName === 'subagent.complete'
        ? JSON.stringify({
            status: (evt as any).status || 'completed',
            summary: summary || text,
            api_calls: (evt as any).api_calls,
            input_tokens: (evt as any).input_tokens,
            output_tokens: (evt as any).output_tokens,
          }, null, 2)
        : undefined,
    }

    if (existing) {
      updateMessage(sessionId, existing.id, update)
      return
    }

    addMessage(sessionId, {
      id: uid(),
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      ...update,
    })
  }

  function addAgentErrorMessage(sessionId: string, error?: unknown) {
    const message = errorMessageText(error)
    const content = message ? `Error: ${message}` : 'Run failed'
    const msgs = getSessionMsgs(sessionId)
    const last = msgs[msgs.length - 1]
    if (last?.isStreaming) {
      updateMessage(sessionId, last.id, {
        role: 'assistant',
        content,
        isStreaming: false,
        systemType: 'error',
      })
      return
    }
    if (last?.role === 'assistant' && last.systemType === 'error' && last.content === content) return
    addMessage(sessionId, {
      id: uid(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      systemType: 'error',
    })
  }

  function handleSessionCommandEvent(evt: RunEvent) {
    if (seenSessionCommandEvents.has(evt)) return
    seenSessionCommandEvents.add(evt)

    const sid = evt.session_id
    if (!sid) return
    const target = sessions.value.find(s => s.id === sid)
    const action = (evt as any).action as string | undefined
    const command = String((evt as any).command || '').toLowerCase()
    if ((evt as any).started === true && (evt as any).terminal === false) {
      serverWorking.value.add(sid)
    }

    if (action === 'clear' && command === 'clear') {
      if (target) target.messages = []
      queuedUserMessages.value.delete(sid)
      queueLengths.value.delete(sid)
      if ((evt as any).clearHistory) {
        const message = String((evt as any).message || '')
        if (message) {
          addMessage(sid, {
            id: uid(),
            role: 'command',
            content: message,
            timestamp: Date.now(),
            systemType: (evt as any).ok === false ? 'error' : 'command',
            commandAction: action,
            commandData: { ...(evt as any) },
          })
        }
      }
      return
    }

    if (action === 'title' && target && typeof (evt as any).title === 'string') {
      target.title = (evt as any).title
      target.updatedAt = Date.now()
    }

    if (action === 'usage' && target) {
      target.inputTokens = (evt as any).inputTokens
      target.outputTokens = (evt as any).outputTokens
      if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
    }

    if (action === 'destroy') {
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      queueLengths.value.delete(sid)
      queuedUserMessages.value.delete(sid)
      setAbortState(null)
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.isStreaming) updateMessage(sid, m.id, { isStreaming: false })
        if (m.role === 'tool' && m.toolStatus === 'running') m.toolStatus = 'error'
      })
    }

    const message = String((evt as any).message || '')
    if (message) {
      addMessage(sid, {
        id: uid(),
        role: 'command',
        content: message,
        timestamp: Date.now(),
        systemType: (evt as any).ok === false ? 'error' : 'command',
        commandAction: action,
        commandData: { ...(evt as any) },
      })
    }
  }

  function handleAgentEvent(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    if ((evt as any).source === 'coding_agent' && (evt as any).kind === 'status') return
    const text = String((evt as any).text || (evt as any).message || '').trim()
    if (!text) return

    const msgs = getSessionMsgs(sid)
    const last = msgs[msgs.length - 1]
    const commandData = { ...(evt as any) }
    if (last?.role === 'system' && last.commandAction === 'agent.event') {
      if (last.content === text) return
      updateMessage(sid, last.id, {
        content: text,
        timestamp: Date.now(),
        commandData,
      })
      return
    }

    addMessage(sid, {
      id: uid(),
      role: 'system',
      content: text,
      timestamp: Date.now(),
      commandAction: 'agent.event',
      commandData,
    })
  }

  function enqueueUserMessage(sessionId: string, message: Message) {
    const queue = queuedUserMessages.value.get(sessionId) || []
    if (queue.some(item => item.id === message.id)) return
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, [...queue, { ...message, queued: true }])
    queuedUserMessages.value = nextMap
  }

  function updateQueuedUserMessage(sessionId: string, messageId: string, patch: Partial<Message>) {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return
    const next = queue.map(message => message.id === messageId
      ? { ...message, ...patch, queued: true }
      : message)
    const nextMap = new Map(queuedUserMessages.value)
    nextMap.set(sessionId, next)
    queuedUserMessages.value = nextMap
  }

  function dropQueuedUserMessage(sessionId: string, messageId: string): boolean {
    const queue = queuedUserMessages.value.get(sessionId)
    if (!queue?.length) return false
    const next = queue.filter(message => message.id !== messageId)
    if (next.length === queue.length) return false
    const nextMap = new Map(queuedUserMessages.value)
    if (next.length > 0) {
      nextMap.set(sessionId, next)
      queueLengths.value.set(sessionId, next.length)
    } else {
      nextMap.delete(sessionId)
      queueLengths.value.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
    return true
  }

  function removeQueuedMessage(sessionId: string, messageId: string) {
    if (!dropQueuedUserMessage(sessionId, messageId)) return
    getChatRunSocket(runtimeTransport())?.emit('cancel_queued_run', {
      session_id: sessionId,
      queue_id: messageId,
    })
  }

  function normalizeQueuedUserMessages(rawMessages: unknown): Message[] {
    if (!Array.isArray(rawMessages)) return []
    return rawMessages.flatMap((raw) => {
      const peer = raw as NonNullable<RunEvent['queued_messages']>[number]
      const content = typeof peer?.content === 'string' ? peer.content : ''
      const messageId = peer?.id != null ? String(peer.id) : ''
      if (!messageId || !content.trim()) return []
      const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
        ? Math.round(peer.timestamp * 1000)
        : Date.now()
      const role = peer?.role === 'command' ? 'command' : 'user'
      return [{
        id: messageId,
        role,
        content,
        timestamp,
        queued: true,
        systemType: role === 'command' ? 'command' as const : undefined,
      }]
    })
  }

  function replaceQueuedUserMessages(sessionId: string, messages: Message[]) {
    const existingById = new Map((queuedUserMessages.value.get(sessionId) || []).map(message => [message.id, message]))
    const merged = messages.map(message => ({
      ...(existingById.get(message.id) || {}),
      ...message,
      attachments: existingById.get(message.id)?.attachments || message.attachments,
      queued: true,
    }))
    const nextMap = new Map(queuedUserMessages.value)
    if (merged.length > 0) {
      nextMap.set(sessionId, merged)
    } else {
      nextMap.delete(sessionId)
    }
    queuedUserMessages.value = nextMap
  }

  function markDequeuedQueueId(sessionId: string, messageId: string) {
    const nextMap = new Map(dequeuedQueueIds.value)
    const ids = new Set(nextMap.get(sessionId) || [])
    ids.add(messageId)
    nextMap.set(sessionId, ids)
    dequeuedQueueIds.value = nextMap
  }

  function consumeDequeuedQueueId(sessionId: string, messageId: string): boolean {
    const ids = dequeuedQueueIds.value.get(sessionId)
    if (!ids?.has(messageId)) return false
    const nextIds = new Set(ids)
    nextIds.delete(messageId)
    const nextMap = new Map(dequeuedQueueIds.value)
    if (nextIds.size > 0) nextMap.set(sessionId, nextIds)
    else nextMap.delete(sessionId)
    dequeuedQueueIds.value = nextMap
    return true
  }

  function handleRunQueuedEvent(sessionId: string, evt: RunEvent) {
    const queueLength = Number((evt as any).queue_length || 0)
    if (queueLength > 0) {
      queueLengths.value.set(sessionId, queueLength)
    } else {
      queueLengths.value.delete(sessionId)
    }

    const dequeuedId = (evt as any).dequeued_queue_id != null
      ? String((evt as any).dequeued_queue_id)
      : ''
    if (dequeuedId) {
      const existingQueue = queuedUserMessages.value.get(sessionId) || []
      const dequeued = existingQueue.find(message => message.id === dequeuedId)
      if (Array.isArray((evt as any).queued_messages)) {
        const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
        replaceQueuedUserMessages(sessionId, queued)
      } else {
        const nextQueue = existingQueue.filter(message => message.id !== dequeuedId)
        replaceQueuedUserMessages(sessionId, nextQueue)
      }
      if (dequeued && !getSessionMsgs(sessionId).some(message => message.id === dequeued.id)) {
        addMessage(sessionId, { ...dequeued, queued: false })
        updateSessionTitle(sessionId)
      } else if (!dequeued) {
        markDequeuedQueueId(sessionId, dequeuedId)
      }
      return
    }

    if (Array.isArray((evt as any).queued_messages)) {
      const queued = normalizeQueuedUserMessages((evt as any).queued_messages)
      replaceQueuedUserMessages(sessionId, queued)
      return
    }

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    const messageId = peer?.id != null ? String(peer.id) : ''
    if (!messageId || !content.trim()) return

    if ((queuedUserMessages.value.get(sessionId) || []).some(msg => msg.id === messageId)) return

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()
    const msgs = getSessionMsgs(sessionId)
    const existingIndex = msgs.findIndex(msg => msg.id === messageId && msg.role === 'user')
    const existing = existingIndex >= 0 ? msgs[existingIndex] : null
    if (existingIndex >= 0) {
      msgs.splice(existingIndex, 1)
    }

    enqueueUserMessage(sessionId, {
      ...(existing || {}),
      id: messageId,
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp: existing?.timestamp || timestamp,
      attachments: existing?.attachments,
      queued: true,
      systemType: peer?.role === 'command' ? 'command' : existing?.systemType,
    })
  }

  function setPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    const approvalId = (evt as any).approval_id as string | undefined
    if (!sid || !approvalId) return
    const description = String((evt as any).description || '')
    const normalizedDescription = description.trim().toLowerCase().replace(/\s+/g, ' ')
    const isMemoryWrite = !Boolean((evt as any).allow_permanent) && (
      normalizedDescription === 'save to memory' ||
      normalizedDescription.startsWith('save to memory:') ||
      normalizedDescription.startsWith('save to memory?')
    )
    const rawChoices = Array.isArray((evt as any).choices) ? (evt as any).choices : ['once', 'session', 'deny']
    const choices = rawChoices
      .filter((choice: unknown): choice is PendingApproval['choices'][number] =>
        choice === 'once' || choice === 'session' || choice === 'always' || choice === 'deny')
    pendingApprovals.value.set(sid, {
      sessionId: sid,
      approvalId,
      command: String((evt as any).command || ''),
      description,
      choices: isMemoryWrite ? ['once', 'deny'] : choices.length ? choices : ['once', 'session', 'deny'],
      allowPermanent: Boolean((evt as any).allow_permanent),
      isMemoryWrite,
      requestedAt: Date.now(),
    })
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function clearPendingApproval(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const current = pendingApprovals.value.get(sid)
    if (!current) return
    const approvalId = (evt as any).approval_id
    if (approvalId && current.approvalId !== approvalId) return
    pendingApprovals.value.delete(sid)
    pendingApprovals.value = new Map(pendingApprovals.value)
  }

  function setPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    const clarifyId = (evt as any).clarify_id as string | undefined
    if (!sid || !clarifyId) return
    pendingClarifies.value.set(sid, {
      sessionId: sid,
      clarifyId,
      question: String((evt as any).question || ''),
      choices: Array.isArray((evt as any).choices) ? (evt as any).choices : null,
      timeoutMs: Number((evt as any).timeout_ms) || 300000,
      requestedAt: Date.now(),
    })
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingClarify(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid) return
    const current = pendingClarifies.value.get(sid)
    if (!current) return
    const clarifyId = (evt as any).clarify_id
    if (clarifyId && current.clarifyId !== clarifyId) return
    pendingClarifies.value.delete(sid)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }

  function clearPendingInteractions(sessionId: string) {
    let changed = false
    if (pendingApprovals.value.has(sessionId)) {
      pendingApprovals.value.delete(sessionId)
      changed = true
    }
    if (pendingClarifies.value.has(sessionId)) {
      pendingClarifies.value.delete(sessionId)
      changed = true
    }
    if (changed) {
      pendingApprovals.value = new Map(pendingApprovals.value)
      pendingClarifies.value = new Map(pendingClarifies.value)
    }
  }

  function respondToClarify(response: string) {
    const pending = activePendingClarify.value
    if (!pending) return
    respondClarify(pending.sessionId, pending.clarifyId, response, runtimeTransport())
    pendingClarifies.value.delete(pending.sessionId)
    pendingClarifies.value = new Map(pendingClarifies.value)
  }


  function respondApproval(choice: PendingApproval['choices'][number]) {
    const pending = activePendingApproval.value
    if (!pending) return
    respondToolApproval(pending.sessionId, pending.approvalId, choice, runtimeTransport())
    pendingApprovals.value.delete(pending.sessionId)
    pendingApprovals.value = new Map(pendingApprovals.value)
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

  function applyGeneratedSessionTitle(evt: RunEvent) {
    const sid = evt.session_id
    const title = typeof (evt as any).title === 'string' ? (evt as any).title.trim() : ''
    if (!sid || !title) return
    const target = sessions.value.find(s => s.id === sid)
    if (target) {
      target.title = title
      target.updatedAt = Date.now()
    }
    if (activeSession.value?.id === sid) {
      activeSession.value.title = title
    }
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

  function truncateNotificationText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (normalized.length <= maxLength) return normalized
    return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`
  }

  function completionNotificationAgent(session: Session): { icon: string } {
    const codingAgentId = session.codingAgentId || (session.agent === 'codex' ? 'codex' : session.agent === 'claude' ? 'claude-code' : undefined)
    if (codingAgentId === 'codex') {
      return { icon: '/coding-agents/codex-openai.png' }
    }
    if (codingAgentId === 'claude-code') {
      return { icon: '/coding-agents/claude-code.svg' }
    }
    return { icon: '/coding-agents/hermes.png' }
  }

  function completionNotificationBody(session: Session, message?: Message): string {
    const preview = message?.content || session.title || 'Message complete.'
    return truncateNotificationText(preview, 140)
  }

  function showCompletionNotificationIfEnabled(sessionId: string, messageId?: string | null) {
    const settingsStore = useSettingsStore()
    if (!settingsStore.display.notify_on_complete) return

    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    const message = messageId
      ? session.messages.find(m => m.id === messageId)
      : [...session.messages].reverse().find(m => m.role === 'assistant')

    const agent = completionNotificationAgent(session)
    void showCompletionNotification({
      title: truncateNotificationText(session.title || 'Hermes', 80),
      body: completionNotificationBody(session, message),
      icon: agent.icon,
      tag: `hermes-complete-${sessionId}-${message?.id || Date.now()}`,
    })
  }

  async function sendMessage(content: string, attachments?: Attachment[]) {
    if ((!content.trim() && !(attachments && attachments.length > 0))) return

    primeCompletionBellIfEnabled()

    const trimmedContent = content.trim()

    if (!activeSession.value) {
      const session = createSession()
      switchSession(session.id)
    }

    // Capture session ID at send time — all callbacks use this, not activeSessionId
    const sid = activeSessionId.value!
    const shouldSendInitialSessionConfig = activeSession.value
      ? activeSession.value.messageCount == null || activeSession.value.messageCount === 0
      : false
    const isCodingAgentSession = isCodingAgentLikeSession(activeSession.value)
    const isBridgeSlashCommand = !isCodingAgentSession && isKnownBridgeSessionCommand(trimmedContent)
    const isBridgeCompressCommand = isBridgeSlashCommand && /^\/compress(?:\s|$)/i.test(trimmedContent)
    const isBridgePlanCommand = isBridgeSlashCommand && /^\/plan(?:\s|$)/i.test(trimmedContent)
    const isBridgeSkillCommand = isBridgeSlashCommand && /^\/skill(?:\s|$)/i.test(trimmedContent)
    const isBridgeGoalCommand = isBridgeSlashCommand && /^\/goal(?:\s|$)/i.test(trimmedContent)
    const wasLiveBeforeSend = isSessionLive(sid)
    const shouldQueue = wasLiveBeforeSend && (!isBridgeSlashCommand || isBridgePlanCommand || isBridgeSkillCommand)

    const userMsg: Message = {
      id: uid(),
      role: isBridgeSlashCommand ? 'command' : 'user',
      content: trimmedContent,
      timestamp: Date.now(),
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      queued: shouldQueue,
      systemType: isBridgeSlashCommand ? 'command' : undefined,
    }

    if (shouldQueue) {
      enqueueUserMessage(sid, userMsg)
    } else {
      addMessage(sid, userMsg)
      updateSessionTitle(sid)
      if (!isCodingAgentSession) serverWorking.value.add(sid)
    }

    let runSubmitted = false
    try {

      // Build input in Anthropic format
      let input: string | ContentBlock[]
      if (attachments && attachments.length > 0) {
        // Has attachments: upload first, then build content blocks
        const uploaded = await uploadFiles(attachments)

        // Update attachment URLs on the user message for display
        const urlMap = new Map(uploaded.map(f => {
          return [f.name, getDownloadUrl(f.path, f.name)]
        }))
        if (shouldQueue && userMsg.attachments) {
          userMsg.attachments = userMsg.attachments.map(a => {
            const dl = urlMap.get(a.name)
            return dl ? { ...a, url: dl } : a
          })
          updateQueuedUserMessage(sid, userMsg.id, { attachments: userMsg.attachments })
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
        input = trimmedContent
      }

      const appStore = useAppStore()
      await appStore.waitForModelsForRun()
      const sessionModel = activeSession.value?.model || appStore.selectedModel
      const sessionProvider = activeSession.value?.provider || appStore.selectedProvider
      const sessionProfile = activeSession.value?.profile || useProfilesStore().activeProfileName || undefined
      const profileModelGroups = sessionProfile
        ? appStore.profileModelGroups.find(entry => entry.profile === sessionProfile)?.groups
        : undefined
      const runModelGroups = profileModelGroups?.length ? profileModelGroups : appStore.modelGroups
      const providerGroup = runModelGroups.find(group => group.provider === sessionProvider)
      const sessionSource: StartRunRequest['source'] = activeSession.value?.source === 'global_agent'
        ? 'global_agent'
        : isCodingAgentSession
          ? 'coding_agent'
          : 'cli'
      const codingAgentId: 'claude-code' | 'codex' =
        activeSession.value?.codingAgentId ||
        (activeSession.value?.agent === 'codex' ? 'codex' : 'claude-code')
      const codingAgentMode = activeSession.value?.codingAgentMode || 'scoped'
      const codingAgentApiMode = sessionSource === 'coding_agent' && codingAgentMode !== 'global'
        ? normalizeCodingAgentApiMode(
            activeSession.value?.apiMode || providerGroup?.api_mode,
            inferCodingAgentApiMode(
              sessionProvider || providerGroup?.provider,
              activeSession.value?.baseUrl || providerGroup?.base_url,
            ),
          )
        : undefined
      const runPayload: StartRunRequest = {
        input,
        session_id: sid,
        profile: sessionProfile,
        model: sessionSource === 'coding_agent'
          ? (codingAgentMode === 'global' ? undefined : sessionModel || undefined)
          : shouldSendInitialSessionConfig ? sessionModel || undefined : undefined,
        provider: sessionSource === 'coding_agent'
          ? (codingAgentMode === 'global' ? undefined : sessionProvider || undefined)
          : shouldSendInitialSessionConfig ? sessionProvider || undefined : undefined,
        model_groups: runModelGroups.map(group => ({
          provider: group.provider,
          models: group.models,
        })),
        queue_id: userMsg.id,
        workspace: activeSession.value?.workspace || undefined,
        source: sessionSource,
        ...(runtimeMode.value === 'global_agent' ? { session_source: 'global_agent' as const } : {}),
        ...(sessionSource === 'coding_agent'
          ? {
              coding_agent_id: codingAgentId,
              mode: codingAgentMode,
              baseUrl: codingAgentMode === 'global' ? undefined : activeSession.value?.baseUrl || providerGroup?.base_url || undefined,
              apiKey: codingAgentMode === 'global' ? undefined : activeSession.value?.apiKey || providerGroup?.api_key || undefined,
              apiMode: codingAgentApiMode,
            }
          : {}),
        // Per-session reasoning effort override. Coding Agent runners do not
        // consume this setting yet, so keep their payloads explicit.
        reasoning_effort: sessionSource === 'coding_agent' ? undefined : activeSession.value?.reasoningEffort || undefined,
      }
      if (shouldSendInitialSessionConfig && activeSession.value) {
        activeSession.value.messageCount = Math.max(activeSession.value.messageCount || 0, 1)
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
      let runProducedAssistantContent = false
      let runHadToolActivity = false
      let activeAssistantMessageId: string | null = null
      let reasoningAssistantMessageId: string | null = null
      let activeRunMarker: string | null = null

      const closeStreamingAssistant = () => {
        const msgs = getSessionMsgs(sid)
        msgs.forEach(m => {
          if (m.role === 'assistant' && m.isStreaming) {
            updateMessage(sid, m.id, { isStreaming: false })
          }
        })
        activeAssistantMessageId = null
        reasoningAssistantMessageId = null
        activeRunMarker = null
      }

      const applyReconnectResume = (data: ResumeSessionPayload) => {
        if (data.session_id !== sid) return
        const target = sessions.value.find(s => s.id === sid)
        if (!target) return

        if (data.isWorking) serverWorking.value.add(sid)
        else serverWorking.value.delete(sid)

        if (data.queueLength && data.queueLength > 0) {
          queueLengths.value.set(sid, data.queueLength)
        } else {
          queueLengths.value.delete(sid)
        }

        if (Array.isArray(data.queueMessages)) {
          replaceQueuedUserMessages(sid, normalizeQueuedUserMessages(data.queueMessages))
        } else if (!data.queueLength) {
          replaceQueuedUserMessages(sid, [])
        }

        if (data.isAborting) {
          setAbortState({ aborting: true, synced: null })
        } else if (!data.isWorking) {
          setAbortState(null)
        }
        if (!data.isWorking) setCompressionState(sid, null)

        if (data.inputTokens != null) target.inputTokens = data.inputTokens
        if (data.outputTokens != null) target.outputTokens = data.outputTokens
        if (data.contextTokens != null) target.contextTokens = data.contextTokens

        if (Array.isArray(data.messages)) {
          const previousActiveAssistantMessageId = activeAssistantMessageId
          const previousReasoningAssistantMessageId = reasoningAssistantMessageId
          const replayRunMarker = getReplayRunMarker(data.events) ?? activeRunMarker
          target.messages = mapHermesMessages(data.messages as any[])
          target.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
          target.messageTotal = data.messageTotal ?? target.messageCount ?? target.loadedMessageCount
          target.messageCount = target.messageTotal
          target.hasMoreBefore = data.hasMoreBefore ?? target.loadedMessageCount < target.messageTotal

          const resumedAssistantState = data.isWorking
            ? resolveResumedAssistantState(target.messages, {
                previousActiveAssistantMessageId,
                previousReasoningAssistantMessageId,
                activeRunMarker: replayRunMarker,
              })
            : {
                activeAssistant: null,
                reasoningAssistant: null,
                runMarker: null,
                hadVisibleText: false,
              }

          const resumedActiveAssistant = resumedAssistantState.activeAssistant
          const resumedReasoningAssistant = resumedAssistantState.reasoningAssistant
          activeRunMarker = resumedAssistantState.runMarker

          if (resumedActiveAssistant) {
            resumedActiveAssistant.isStreaming = true
            activeAssistantMessageId = resumedActiveAssistant.id
            if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
          } else {
            activeAssistantMessageId = null
          }

          if (resumedReasoningAssistant) {
            reasoningAssistantMessageId = resumedReasoningAssistant.id
            if (resumedReasoningAssistant.reasoning) noteReasoningStart(resumedReasoningAssistant.id)
          } else {
            reasoningAssistantMessageId = null
          }
        }

        if (data.events?.length) {
          for (const evt of data.events) {
            const e = evt.data as RunEvent
            switch (e.event) {
              case 'compression.started':
                setCompressionState(sid, {
                  compressing: true,
                  messageCount: (e as any).message_count || 0,
                  beforeTokens: (e as any).token_count || 0,
                  afterTokens: 0,
                  compressed: null,
                })
                break
              case 'compression.completed': {
                const afterTokens = (e as any).contextTokens || (e as any).afterTokens || 0
                setCompressionState(sid, {
                  compressing: false,
                  messageCount: (e as any).totalMessages || 0,
                  beforeTokens: (e as any).beforeTokens || 0,
                  afterTokens,
                  compressed: (e as any).compressed ?? false,
                  error: (e as any).error,
                })
                if ((e as any).contextTokens != null) target.contextTokens = (e as any).contextTokens
                break
              }
              case 'abort.started':
                setAbortState({ aborting: true, synced: null })
                break
              case 'abort.timeout':
                setAbortState({ aborting: true, synced: false, timedOut: true, message: (e as any).message })
                break
              case 'abort.completed':
                setAbortState({ aborting: false, synced: (e as any).synced ?? false })
                break
              case 'approval.requested':
                setPendingApproval({ ...e, session_id: sid })
                break
              case 'approval.resolved':
                clearPendingApproval({ ...e, session_id: sid })
                break
              case 'clarify.requested':
                setPendingClarify({ ...e, session_id: sid })
                break
              case 'clarify.resolved':
                clearPendingClarify({ ...e, session_id: sid })
                break
              case 'run.failed':
                addAgentErrorMessage(sid, e.error)
                break
              case 'agent.event':
                handleAgentEvent(e)
                break
            }
          }
        }

        if (activeSessionId.value === sid) activeSession.value = target
        if (!data.isWorking && !(data.queueLength && data.queueLength > 0)) {
          clearAgentEventMessages(sid)
          cleanup()
          activeAssistantMessageId = null
          updateSessionTitle(sid)
        }
      }

      // Send run via Socket.IO and listen to streamed events — all closures capture `sid`
      const ctrl = startRunViaSocket(
        runPayload,
        // onEvent
        (evt: RunEvent) => {
          const eventRunMarker = readRunMarker(evt)
          if (eventRunMarker) activeRunMarker = eventRunMarker
          switch (evt.event) {
            case 'run.started':
              clearSessionCompletedUnread(sid)
              serverWorking.value.add(sid)
              clearAgentEventMessages(sid)
              setAbortState(null)
              setCompressionState(sid, null)
              runProducedAssistantText = false
              runProducedAssistantContent = false
              runHadToolActivity = false
              closeStreamingAssistant()
              activeRunMarker = readRunMarker(evt) ?? null
              if ((evt as any).queue_length > 0) {
                queueLengths.value.set(sid, (evt as any).queue_length)
              } else {
                queueLengths.value.delete(sid)
              }
              break

            case 'run.queued': {
              handleRunQueuedEvent(sid, evt)
              break
            }

            case 'session.command': {
              handleSessionCommandEvent(evt)
              break
            }

            case 'agent.event': {
              handleAgentEvent(evt)
              break
            }

            case 'run.reattach_failed': {
              handleAgentEvent(evt)
              break
            }

            case 'compression.started': {
              setCompressionState(sid, {
                compressing: true,
                messageCount: (evt as any).message_count || 0,
                beforeTokens: (evt as any).token_count || 0,
                afterTokens: 0,
                compressed: null,
              })
              break
            }

            case 'compression.completed': {
              const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
              setCompressionState(sid, {
                compressing: false,
                messageCount: (evt as any).totalMessages || 0,
                beforeTokens: (evt as any).beforeTokens || 0,
                afterTokens,
                compressed: (evt as any).compressed ?? false,
                error: (evt as any).error,
              })
              if ((evt as any).contextTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) target.contextTokens = (evt as any).contextTokens
              }
              // Auto-clear after 5s
              setTimeout(() => {
                const state = compressionStates.value.get(sid)
                if (state && !state.compressing) {
                  setCompressionState(sid, null)
                }
              }, 5000)
              break
            }

            case 'abort.started': {
              setAbortState({ aborting: true, synced: null })
              break
            }

            case 'abort.timeout': {
              setAbortState({ aborting: true, synced: false, timedOut: true, message: (evt as any).message })
              break
            }

            case 'abort.completed': {
              setAbortState({ aborting: false, synced: (evt as any).synced ?? false })
              clearPendingInteractions(sid)
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
              const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
              const last = reasoningTargetId
                ? msgs.find(m => m.id === reasoningTargetId)
                : null
              if (last?.role === 'assistant') {
                last.reasoning = (last.reasoning || '') + text
                reasoningAssistantMessageId = last.id
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
                reasoningAssistantMessageId = newId
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
              if (evt.delta) {
                runProducedAssistantText = true
                runProducedAssistantContent = true
              }
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

            case 'session.title.updated': {
              applyGeneratedSessionTitle(evt)
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
                  toolArgs: hasRuntimeToolPayload((evt as any).arguments) ? (evt as any).arguments : existingTool.toolArgs,
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
                toolArgs: runtimeToolPayloadOrUndefined((evt as any).arguments),
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
                const output = runtimeToolPayloadOrUndefined((evt as any).output)
                const hasError = (evt as any).error === true || runtimeToolOutputHasError(output)
                const duration = (evt as any).duration
                updateMessage(sid, last.id, {
                  toolStatus: hasError ? 'error' : 'done',
                  toolDuration: duration,
                  toolResult: output,
                })
              }

              break
            }

            case 'subagent.start':
            case 'subagent.tool':
            case 'subagent.progress':
            case 'subagent.complete': {
              runHadToolActivity = true
              handleSubagentEvent(sid, evt)
              break
            }

            case 'approval.requested': {
              setPendingApproval(evt)
              break
            }

            case 'approval.resolved': {
              clearPendingApproval(evt)
              break
            }

            case 'clarify.requested': {
              setPendingClarify(evt)
              break
            }

            case 'clarify.resolved': {
              clearPendingClarify(evt)
              break
            }

            case 'run.completed': {
              clearAgentEventMessages(sid)
              const msgs = getSessionMsgs(sid)
              const lastMsg = activeAssistantMessageId
                ? msgs.find(m => m.id === activeAssistantMessageId)
                : msgs[msgs.length - 1]
              const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
                ? lastMsg.id
                : null
              if (lastMsg?.isStreaming) {
                updateMessage(sid, lastMsg.id, { isStreaming: false })
              }
              settleRunningTools(sid, 'done')
              // Server-computed usage (local countTokens, snapshot-aware)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
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
                  : completedAssistantMessageId
                    ? msgs.find(m => m.id === completedAssistantMessageId)
                    : undefined
                const parsedContent = typeof (evt as any).parsed_content === 'string'
                  ? (evt as any).parsed_content
                  : ''
                const parsedContentTrimmed = parsedContent.trim()
                if (lastAssistant) {
                  const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
                  if (parsedContentTrimmed || !existingContentTrimmed) {
                    updateMessage(sid, lastAssistant.id, {
                      content: parsedContent,
                    })
                    finalOutputTrimmed = parsedContentTrimmed
                    if (parsedContentTrimmed) {
                      runProducedAssistantText = true
                      runProducedAssistantContent = true
                    }
                  } else {
                    finalOutputTrimmed = existingContentTrimmed
                    runProducedAssistantText = true
                  }
                  if ((evt as any).parsed_reasoning) {
                    updateMessage(sid, lastAssistant.id, {
                      reasoning: (evt as any).parsed_reasoning,
                    })
                  }
                } else if (parsedContentTrimmed) {
                  addMessage(sid, {
                    id: uid(),
                    role: 'assistant',
                    content: parsedContent,
                    reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                    timestamp: Date.now(),
                  })
                  finalOutputTrimmed = parsedContentTrimmed
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
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
                  runProducedAssistantContent = true
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
                showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
              }

              // 自动播放语音
              if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
                const msgs = getSessionMsgs(sid)
                const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
                if (lastAssistant?.content) {
                  // 延迟一小会儿再播放，确保 UI 更新完成
                  setTimeout(() => {
                    playMessageSpeech(lastAssistant.id, lastAssistant.content)
                  }, 300)
                }
              }

              const hasQueue = (evt as any).queue_remaining > 0
              markSessionCompletedUnread(sid, hasQueue)
              if (hasQueue) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              updateSessionTitle(sid)
              break
            }

            case 'run.failed': {
              clearAgentEventMessages(sid)
              if ((evt as any).inputTokens != null) {
                const target = sessions.value.find(s => s.id === sid)
                if (target) {
                  target.inputTokens = (evt as any).inputTokens
                  target.outputTokens = (evt as any).outputTokens
                  if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
                }
              }
              addAgentErrorMessage(sid, evt.error)
              settleRunningTools(sid, 'error')
              if ((evt as any).queue_remaining > 0) {
                queueLengths.value.set(sid, (evt as any).queue_remaining)
              } else {
                cleanup()
              }
              activeAssistantMessageId = null
              reasoningAssistantMessageId = null
              activeRunMarker = null
              break
            }

            case 'usage.updated': {
              const target = sessions.value.find(s => s.id === sid)
              if (target) {
                target.inputTokens = (evt as any).inputTokens
                target.outputTokens = (evt as any).outputTokens
                if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
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
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          updateSessionTitle(sid)
        },
        // onError
        (err) => {
          console.warn('Socket.IO run stream error:', err.message)
          addAgentErrorMessage(sid, err.message)
          const msgs = getSessionMsgs(sid)
          msgs.forEach((m, i) => {
            if (m.role === 'tool' && m.toolStatus === 'running') {
              msgs[i] = { ...m, toolStatus: 'error' }
            }
          })
          cleanup()
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
        },
        undefined,
        { onReconnectResume: applyReconnectResume, transport: runtimeTransport() },
      )
      runSubmitted = true

      if (isCodingAgentSession) {
        serverWorking.value.add(sid)
        streamStates.value.set(sid, ctrl)
      } else if (!isBridgeSlashCommand || isBridgeCompressCommand || isBridgePlanCommand || isBridgeGoalCommand) {
        streamStates.value.set(sid, ctrl)
      }
    } catch (err: any) {
      if (shouldQueue && !runSubmitted) {
        dropQueuedUserMessage(sid, userMsg.id)
      }
      if (!shouldQueue && !runSubmitted) {
        serverWorking.value.delete(sid)
      }
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
  function resumeServerWorkingRun(sid: string, force = false) {
    // Don't register duplicate listeners if already streaming
    if (streamStates.value.has(sid)) return
    // Only set up listeners if the server reported an active run during resume.
    if (!force && !serverWorking.value.has(sid)) return

    let closed = false
    let runProducedAssistantText = false
    let runProducedAssistantContent = false
    let runHadToolActivity = false
    let activeAssistantMessageId: string | null = null
    let reasoningAssistantMessageId: string | null = null
    let activeRunMarker: string | null = null

    const cleanup = () => {
      if (closed) return
      closed = true
      streamStates.value.delete(sid)
      serverWorking.value.delete(sid)
      // Unregister from global session handlers
      unregisterSessionHandlers(sid)
    }

    const closeStreamingAssistant = () => {
      const msgs = getSessionMsgs(sid)
      msgs.forEach(m => {
        if (m.role === 'assistant' && m.isStreaming) {
          updateMessage(sid, m.id, { isStreaming: false })
        }
      })
      activeAssistantMessageId = null
      reasoningAssistantMessageId = null
      activeRunMarker = null
    }

    const initializeResumedAssistantState = () => {
      const resumedAssistantState = resolveResumedAssistantState(getSessionMsgs(sid), { activeRunMarker })
      activeRunMarker = resumedAssistantState.runMarker
      if (resumedAssistantState.activeAssistant) {
        resumedAssistantState.activeAssistant.isStreaming = true
        activeAssistantMessageId = resumedAssistantState.activeAssistant.id
        if (resumedAssistantState.hadVisibleText) runProducedAssistantText = true
      }
      if (resumedAssistantState.reasoningAssistant) {
        reasoningAssistantMessageId = resumedAssistantState.reasoningAssistant.id
        if (resumedAssistantState.reasoningAssistant.reasoning) {
          noteReasoningStart(resumedAssistantState.reasoningAssistant.id)
        }
      }
    }

    initializeResumedAssistantState()

    // Shared event handler — filters by session_id tag
    function handleEvent(evt: RunEvent) {
      if (closed) return
      // Filter events for this session (server tags all events with session_id)
      if (evt.session_id && evt.session_id !== sid) return
      const eventRunMarker = readRunMarker(evt)
      if (eventRunMarker) activeRunMarker = eventRunMarker
      switch (evt.event) {
        case 'run.queued': {
          handleRunQueuedEvent(sid, evt)
          break
        }

        case 'session.command': {
          handleSessionCommandEvent(evt)
          break
        }

        case 'agent.event': {
          handleAgentEvent(evt)
          break
        }

        case 'run.reattach_failed': {
          handleAgentEvent(evt)
          break
        }

        case 'run.started':
          clearSessionCompletedUnread(sid)
          serverWorking.value.add(sid)
          clearAgentEventMessages(sid)
          setAbortState(null)
          setCompressionState(sid, null)
          runProducedAssistantText = false
          runProducedAssistantContent = false
          runHadToolActivity = false
          closeStreamingAssistant()
          activeRunMarker = readRunMarker(evt) ?? null
          if ((evt as any).queue_length > 0) {
            queueLengths.value.set(sid, (evt as any).queue_length)
          } else {
            queueLengths.value.delete(sid)
          }
          break

        case 'compression.started': {
          setCompressionState(sid, {
            compressing: true,
            messageCount: (evt as any).message_count || 0,
            beforeTokens: (evt as any).token_count || 0,
            afterTokens: 0,
            compressed: null,
          })
          break
        }

        case 'compression.completed': {
          const afterTokens = (evt as any).contextTokens || (evt as any).afterTokens || 0
          setCompressionState(sid, {
            compressing: false,
            messageCount: (evt as any).totalMessages || 0,
            beforeTokens: (evt as any).beforeTokens || 0,
            afterTokens,
            compressed: (evt as any).compressed ?? false,
            error: (evt as any).error,
          })
          if ((evt as any).contextTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) target.contextTokens = (evt as any).contextTokens
          }
          setTimeout(() => {
            const state = compressionStates.value.get(sid)
            if (state && !state.compressing) {
              setCompressionState(sid, null)
            }
          }, 5000)
          break
        }

        case 'abort.started': {
          setAbortState({ aborting: true, synced: null })
          break
        }

        case 'abort.timeout': {
          setAbortState({ aborting: true, synced: false, timedOut: true, message: (evt as any).message })
          break
        }

        case 'abort.completed': {
          setAbortState({ aborting: false, synced: (evt as any).synced ?? false })
          clearPendingInteractions(sid)
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
          const reasoningTargetId = reasoningAssistantMessageId || activeAssistantMessageId
          const last = reasoningTargetId
            ? msgs.find(m => m.id === reasoningTargetId)
            : null
          if (last?.role === 'assistant') {
            last.reasoning = (last.reasoning || '') + text
            reasoningAssistantMessageId = last.id
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
            reasoningAssistantMessageId = newId
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
          if (evt.delta) {
            runProducedAssistantText = true
            runProducedAssistantContent = true
          }
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

        case 'session.title.updated': {
          applyGeneratedSessionTitle(evt)
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
              toolArgs: hasRuntimeToolPayload((evt as any).arguments) ? (evt as any).arguments : existingTool.toolArgs,
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
            toolArgs: runtimeToolPayloadOrUndefined((evt as any).arguments),
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
            const output = runtimeToolPayloadOrUndefined((evt as any).output)
            const hasError = (evt as any).error === true || runtimeToolOutputHasError(output)
            updateMessage(sid, toolMsgs[toolMsgs.length - 1].id, {
              toolStatus: hasError ? 'error' : 'done',
              toolDuration: (evt as any).duration,
              toolResult: output,
            })
          }

          break
        }

        case 'subagent.start':
        case 'subagent.tool':
        case 'subagent.progress':
        case 'subagent.complete': {
          runHadToolActivity = true
          handleSubagentEvent(sid, evt)
          break
        }

        case 'approval.requested': {
          setPendingApproval(evt)
          break
        }

        case 'approval.resolved': {
          clearPendingApproval(evt)
          break
        }

        case 'clarify.requested': {
          setPendingClarify(evt)
          break
        }

        case 'clarify.resolved': {
          clearPendingClarify(evt)
          break
        }

        case 'run.completed': {
          clearAgentEventMessages(sid)
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
          const completedAssistantMessageId = lastMsg?.role === 'assistant' && lastMsg.isStreaming
            ? lastMsg.id
            : null
          if (lastMsg?.isStreaming) {
            updateMessage(sid, lastMsg.id, { isStreaming: false })
          }
          settleRunningTools(sid, 'done')
          // Server-computed usage (local countTokens, snapshot-aware)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          // Check if backend provided parsed content (from stringified array format)
          let finalOutputTrimmed = ''
          if ((evt as any).parsed_content !== undefined) {
            // Backend has parsed stringified array format, update last assistant message
            const msgs = getSessionMsgs(sid)
            const lastAssistant = activeAssistantMessageId
              ? msgs.find(m => m.id === activeAssistantMessageId)
              : completedAssistantMessageId
                ? msgs.find(m => m.id === completedAssistantMessageId)
                : undefined
            const parsedContent = typeof (evt as any).parsed_content === 'string'
              ? (evt as any).parsed_content
              : ''
            const parsedContentTrimmed = parsedContent.trim()
            if (lastAssistant) {
              const existingContentTrimmed = lastAssistant.content?.trim() ?? ''
              if (parsedContentTrimmed || !existingContentTrimmed) {
                updateMessage(sid, lastAssistant.id, {
                  content: parsedContent,
                })
                finalOutputTrimmed = parsedContentTrimmed
                if (parsedContentTrimmed) {
                  runProducedAssistantText = true
                  runProducedAssistantContent = true
                }
              } else {
                finalOutputTrimmed = existingContentTrimmed
                runProducedAssistantText = true
              }
              if ((evt as any).parsed_reasoning) {
                updateMessage(sid, lastAssistant.id, {
                  reasoning: (evt as any).parsed_reasoning,
                })
              }
            } else if (parsedContentTrimmed) {
              addMessage(sid, {
                id: uid(),
                role: 'assistant',
                content: parsedContent,
                reasoning: typeof (evt as any).parsed_reasoning === 'string' ? (evt as any).parsed_reasoning : undefined,
                timestamp: Date.now(),
              })
              finalOutputTrimmed = parsedContentTrimmed
              runProducedAssistantText = true
              runProducedAssistantContent = true
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
              runProducedAssistantText = true
              runProducedAssistantContent = true
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
            showCompletionNotificationIfEnabled(sid, completedAssistantMessageId)
          }

          // Auto-play speech for every completed assistant message
          if (autoPlaySpeechEnabled.value && runProducedAssistantContent) {
            const msgs = getSessionMsgs(sid)
            const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant')
            if (lastAssistant?.content) {
              setTimeout(() => {
                playMessageSpeech(lastAssistant.id, lastAssistant.content)
              }, 300)
            }
          }

          if (!hasQueue) {
            markSessionCompletedUnread(sid)
            cleanup()
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          } else {
            markSessionCompletedUnread(sid, true)
            // More runs pending — reset for next run but don't cleanup
            activeAssistantMessageId = null
            reasoningAssistantMessageId = null
            activeRunMarker = null
          }
          updateSessionTitle(sid)
          break
        }

        case 'run.failed': {
          clearAgentEventMessages(sid)
          if ((evt as any).inputTokens != null) {
            const target = sessions.value.find(s => s.id === sid)
            if (target) {
              target.inputTokens = (evt as any).inputTokens
              target.outputTokens = (evt as any).outputTokens
              if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
            }
          }
          const hasQueue = (evt as any).queue_remaining > 0
          if (hasQueue) {
            queueLengths.value.set(sid, (evt as any).queue_remaining)
          } else {
            queueLengths.value.delete(sid)
          }
          addAgentErrorMessage(sid, evt.error)
          settleRunningTools(sid, 'error')
          if (!hasQueue) {
            cleanup()
          }
          activeAssistantMessageId = null
          reasoningAssistantMessageId = null
          activeRunMarker = null
          break
        }

        case 'usage.updated': {
          const target = sessions.value.find(s => s.id === sid)
          if (target) {
            target.inputTokens = (evt as any).inputTokens
            target.outputTokens = (evt as any).outputTokens
            if ((evt as any).contextTokens != null) target.contextTokens = (evt as any).contextTokens
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
      onSubagentEvent: (evt) => handleEvent(evt),
      onRunStarted: (evt) => handleEvent(evt),
      onRunCompleted: (evt) => handleEvent(evt),
      onRunFailed: (evt) => handleEvent(evt),
      onCompressionStarted: (evt) => handleEvent(evt),
      onCompressionCompleted: (evt) => handleEvent(evt),
      onAbortStarted: (evt) => handleEvent(evt),
      onAbortTimeout: (evt) => handleEvent(evt),
      onAbortCompleted: (evt) => handleEvent(evt),
      onUsageUpdated: (evt) => handleEvent(evt),
      onAgentEvent: (evt) => handleEvent(evt),
      onSessionCommand: (evt) => handleEvent(evt),
      onRunQueued: (evt) => handleEvent(evt),
      onClarifyRequested: (evt) => handleEvent(evt),
      onClarifyResolved: (evt) => handleEvent(evt),
    })

    // No need to emit resume here — switchSession already did it.
    // Server already joined room and replayed events.
    // Just set up handlers for ongoing streaming events.

    // Mark as streaming so UI shows the indicator and can still abort after refresh.
    streamStates.value.set(sid, {
      abort: () => {
        getChatRunSocket(runtimeTransport())?.emit('abort', { session_id: sid })
      },
    })
  }

  function handlePeerUserMessage(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return

    const peer = evt.message
    const content = typeof peer?.content === 'string' ? peer.content : ''
    if (!content.trim()) return

    const messageId = peer?.id != null ? String(peer.id) : ''
    const msgs = getSessionMsgs(sid)
    if (messageId && msgs.some(msg => msg.id === messageId)) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
      return
    }
    if (messageId && (queuedUserMessages.value.get(sid) || []).some(msg => msg.id === messageId)) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
      return
    }

    const timestamp = typeof peer?.timestamp === 'number' && Number.isFinite(peer.timestamp)
      ? Math.round(peer.timestamp * 1000)
      : Date.now()

    const message: Message = {
      id: messageId || uid(),
      role: peer?.role === 'command' ? 'command' : 'user',
      content,
      timestamp,
      queued: !!peer?.queued,
      systemType: peer?.role === 'command' ? 'command' : undefined,
    }
    const wasDequeued = messageId ? consumeDequeuedQueueId(sid, messageId) : false
    if (peer?.queued || (!wasDequeued && isSessionLive(sid))) {
      enqueueUserMessage(sid, message)
    } else {
      addMessage(sid, message)
      updateSessionTitle(sid)
    }
    serverWorking.value.add(sid)
    resumeServerWorkingRun(sid, true)
  }

  onPeerUserMessage(handlePeerUserMessage)

  function handleGlobalSessionCommand(evt: RunEvent) {
    const sid = evt.session_id
    if (!sid || activeSessionId.value !== sid || !activeSession.value) return
    const shouldAttachToStartedRun = (evt as any).started === true && (evt as any).terminal === false
    handleSessionCommandEvent(evt)
    if (shouldAttachToStartedRun) {
      serverWorking.value.add(sid)
      resumeServerWorkingRun(sid, true)
    }
  }

  onSessionCommand(handleGlobalSessionCommand)

  onSessionTitleUpdated(applyGeneratedSessionTitle)

  function stopStreaming() {
    const sid = activeSessionId.value
    if (!sid) return
    if (isAborting.value) return
    clearPendingInteractions(sid)
    const ctrl = streamStates.value.get(sid)
    if (ctrl) {
      setAbortState({ aborting: true, synced: null })
      ctrl.abort()
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
      return
    }
    if (serverWorking.value.has(sid)) {
      setAbortState({ aborting: true, synced: null })
      getChatRunSocket(runtimeTransport())?.emit('abort', { session_id: sid })
      const msgs = getSessionMsgs(sid)
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.isStreaming) {
        updateMessage(sid, lastMsg.id, { isStreaming: false })
      }
    }
  }

  // Tab visibility: re-sync when returning to foreground
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !isStreaming.value) {
        // Live-sync the session list so sessions created elsewhere (CLI,
        // Telegram, another device) appear without a manual reload.
        void refreshSessionListOnly()
      }
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
            if (!data.isWorking) setCompressionState(sid, null)
            if (data.messages?.length && activeSession.value) {
              activeSession.value.messages = mapHermesMessages(data.messages as any[])
              activeSession.value.loadedMessageCount = data.messageLoadedCount ?? data.messages.length
              activeSession.value.messageTotal = data.messageTotal ?? activeSession.value.messageCount ?? activeSession.value.loadedMessageCount
              activeSession.value.messageCount = activeSession.value.messageTotal
              activeSession.value.hasMoreBefore = data.hasMoreBefore ?? activeSession.value.loadedMessageCount < activeSession.value.messageTotal
            }
            resumeServerWorkingRun(sid)
          }, activeSession.value?.profile, runtimeTransport())
        }
      }
    })
  }

  // Mild background polling for live session-list sync (covers sessions created
  // on the VM via CLI/Telegram while this client is in the foreground). Only
  // runs when the tab is visible and not streaming, so it's cheap and never
  // disrupts an active run. visibilitychange (above) handles the wake-from-hidden
  // case; this covers the "left it open and watching" case.
  if (typeof window !== 'undefined') {
    window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (isStreaming.value) return
      void refreshSessionListOnly()
    }, 12_000)
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

  // Persisted in localStorage keyed by sessionId so the choice survives
  // page reloads. Cleared on session deletion is NOT implemented (best-effort
  // — orphan keys are tiny and never read again).
  const REASONING_LS_PREFIX = 'hermes:reasoning_effort:'
  function setSessionReasoningEffort(sessionId: string, effort: string) {
    const session = sessions.value.find(s => s.id === sessionId)
    if (!session) return
    session.reasoningEffort = effort || undefined
    try {
      if (effort) {
        localStorage.setItem(REASONING_LS_PREFIX + sessionId, effort)
      } else {
        localStorage.removeItem(REASONING_LS_PREFIX + sessionId)
      }
    } catch {
      // localStorage may be unavailable (private mode); silently ignore
    }
  }
  function getStoredReasoningEffort(sessionId: string): string | undefined {
    try {
      return localStorage.getItem(REASONING_LS_PREFIX + sessionId) || undefined
    } catch {
      return undefined
    }
  }
  // Hydrate reasoningEffort onto sessions whenever they come in fresh from
  // the server (mapHermesSession doesn't carry this — it's client-only state).
  watch(sessions, (list) => {
    for (const s of list) {
      if (s.reasoningEffort === undefined) {
        const stored = getStoredReasoningEffort(s.id)
        if (stored) s.reasoningEffort = stored
      }
    }
  }, { deep: false })

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
    runtimeMode,
    activeSessionId,
    activeSession,
    focusMessageId,
    messages,
    isStreaming,
    isRunActive,
    isSessionLive,
    isSessionCompletedUnread,
    clearSessionCompletedUnread,
    sessionProfileFilter,
    compressionState,
    abortState,
    isAborting,
    queueLengths,
    queuedUserMessages,
    pendingApprovals,
    activePendingApproval,
    activePendingClarify,
    removeQueuedMessage,
    isLoadingSessions,
    sessionsLoaded,
    isLoadingMessages,

    newChat,
    newCliSession,
    switchSession,
    loadOlderMessages,
    switchSessionModel,
    addOrUpdateSession,
    clearProviderFromSessions,
    deleteSession,
    sendMessage,
    stopStreaming,
    respondApproval,
    respondToClarify,
    loadSessions,
    refreshSessionListOnly,
    refreshActiveSession,
    getThinkingObservation,
    noteThinkingDelta,
    noteReasoningStart,
    noteReasoningEnd,
    clearThinkingObservationFor,
    setAutoPlaySpeech,
    playMessageSpeech,
    setSessionReasoningEffort,
    setRuntimeMode,
  }
})
