<script setup lang="ts">
import { resumeCliSession, startCliRun, watchCliSession, type CliRunEvent } from '@/api/hermes/cli-chat'
import type { ContentBlock } from '@/api/hermes/chat'
import { getApiKey } from '@/api/client'
import {
  buildContentBlocks,
  uploadFiles,
  useChatStore,
  type Attachment,
  type Message,
} from '@/stores/hermes/chat'
import { useMessage } from 'naive-ui'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ChatInput from './ChatInput.vue'
import MessageList from './MessageList.vue'

const chatStore = useChatStore()
const message = useMessage()

const isRunning = ref(false)
const isAborting = ref(false)
const assistantMessageId = ref<string | null>(null)
const pendingCommandMessageId = ref<string | null>(null)
let activeHandle: ReturnType<typeof startCliRun> | null = null

const activeCliSessionId = computed(() => {
  const session = chatStore.activeSession
  return session?.source === 'cli' ? session.id : ''
})

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function currentAssistantMessage(): Message | null {
  const session = chatStore.activeSession
  if (!session || !assistantMessageId.value) return null
  return session.messages.find((item) => item.id === assistantMessageId.value) || null
}

function appendAssistantDelta(delta: string) {
  const msg = currentAssistantMessage()
  if (msg) msg.content += delta
}

function finishAssistant(output?: string) {
  const msg = currentAssistantMessage()
  if (msg) {
    if (output && (!msg.content || output.length >= msg.content.length)) {
      msg.content = output
    }
    msg.isStreaming = false
  }
  isRunning.value = false
  isAborting.value = false
  activeHandle?.cleanup()
  activeHandle = null
}

function ensureStreamingAssistant(): Message | null {
  const session = chatStore.activeSession
  if (!session) return null
  const existing = currentAssistantMessage()
  if (existing) return existing
  const msg: Message = {
    id: uid(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
  }
  session.messages.push(msg)
  assistantMessageId.value = msg.id
  return msg
}

function handleRunEvent(event: CliRunEvent) {
  if (event.delta) appendAssistantDelta(event.delta)
}

function handleRunCompleted(event: CliRunEvent) {
  finishAssistant(event.output)
  const session = chatStore.activeSession
  if (session) {
    session.updatedAt = Date.now()
    if (!session.title) {
      const firstUser = session.messages.find((item) => item.role === 'user')
      if (firstUser) session.title = firstUser.content.slice(0, 40)
    }
  }
}

function handleRunFailed(event: CliRunEvent) {
  const msg = ensureStreamingAssistant()
  if (msg && !msg.content) msg.content = event.error || 'Run failed'
  finishAssistant()
  if (event.error) message.error(event.error)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block: any) => {
      if (typeof block === 'string') return block
      if (block?.type === 'text') return block.text || ''
      return block?.name || block?.path || ''
    }).filter(Boolean).join('\n')
  }
  return content == null ? '' : String(content)
}

function mapBridgeHistory(history: unknown[]): Message[] {
  return history
    .filter((item: any) => ['user', 'assistant', 'system', 'tool'].includes(item?.role))
    .map((item: any) => ({
      id: uid(),
      role: item.role,
      content: contentToText(item.content),
      timestamp: Date.now(),
      reasoning: typeof item.reasoning === 'string' ? item.reasoning : undefined,
      toolName: item.tool_name || item.name,
      toolCallId: item.tool_call_id,
    }))
}

function appendCommandMessage(text: string) {
  const session = chatStore.activeSession
  if (!session || !text.trim()) return
  const id = uid()
  session.messages.push({
    id,
    role: 'system',
    content: text.trim(),
    timestamp: Date.now(),
  })
  return id
}

function clearPendingCommandMessage() {
  const session = chatStore.activeSession
  const id = pendingCommandMessageId.value
  pendingCommandMessageId.value = null
  if (!session || !id) return
  session.messages = session.messages.filter((item) => item.id !== id)
}

function handleCommandCompleted(event: CliRunEvent) {
  const session = chatStore.activeSession
  if (!session) return
  clearPendingCommandMessage()

  if (event.history) {
    session.messages = mapBridgeHistory(event.history)
  }

  if (event.title) {
    session.title = event.title
  }

  if (event.new_session_id) {
    chatStore.replaceActiveSessionId(event.new_session_id)
    const next = chatStore.activeSession
    if (next && ['new', 'reset', 'clear'].includes((event.command || '').slice(1).split(/\s+/)[0])) {
      next.messages = []
    }
  }

  if (event.retry && event.retry_input) {
    const next = chatStore.activeSession
    if (next) {
      next.messages.push({
        id: uid(),
        role: 'user',
        content: contentToText(event.retry_input),
        timestamp: Date.now(),
      })
      const assistant: Message = {
        id: uid(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      }
      next.messages.push(assistant)
      assistantMessageId.value = assistant.id
      isRunning.value = true
    }
    return
  }

  if (event.message) appendCommandMessage(event.message)
  if (event.error) {
    appendCommandMessage(event.error)
    message.error(event.error)
  }
}

async function buildCliInput(
  text: string,
  attachments?: Attachment[],
): Promise<string | ContentBlock[]> {
  if (!attachments?.length) return text.trim()

  const uploaded = await uploadFiles(attachments)
  const token = getApiKey()
  const urlMap = new Map(uploaded.map((file) => {
    const base = `/api/hermes/download?path=${encodeURIComponent(file.path)}&name=${encodeURIComponent(file.name)}`
    return [file.name, token ? `${base}&token=${encodeURIComponent(token)}` : base]
  }))

  const userMessage = chatStore.activeSession?.messages.findLast(
    (item) => item.role === 'user',
  )
  if (userMessage?.attachments) {
    userMessage.attachments = userMessage.attachments.map((attachment) => {
      const url = urlMap.get(attachment.name)
      return url ? { ...attachment, url } : attachment
    })
  }

  return buildContentBlocks(text, attachments, uploaded)
}

function createHandlers() {
  return {
    onStarted: () => {
      isRunning.value = true
      ensureStreamingAssistant()
    },
    onDelta: handleRunEvent,
    onCompleted: handleRunCompleted,
    onFailed: handleRunFailed,
    onAbortStarted: () => {
      isAborting.value = true
    },
    onAbortCompleted: () => {
      isAborting.value = false
    },
    onCommandCompleted: handleCommandCompleted,
  }
}

function attachToActiveSession() {
  activeHandle?.cleanup()
  activeHandle = null
  assistantMessageId.value = null
  isRunning.value = false
  isAborting.value = false

  const sessionId = activeCliSessionId.value
  if (!sessionId) return

  activeHandle = watchCliSession(sessionId, createHandlers())
  resumeCliSession(sessionId, (event) => {
    if (activeCliSessionId.value !== sessionId) return
    if (event.isWorking) {
      isRunning.value = true
      isAborting.value = Boolean(event.isAborting)
      const msg = ensureStreamingAssistant()
      if (msg && event.output && !msg.content) msg.content = event.output
    }
  })
}

async function handleSend(text: string, attachments?: Attachment[]) {
  const session = chatStore.activeSession
  if ((!text.trim() && !attachments?.length) || !session || session.source !== 'cli' || isRunning.value) return

  if (text.trim().startsWith('/') && !attachments?.length) {
    if (!activeHandle) activeHandle = watchCliSession(session.id, createHandlers())
    clearPendingCommandMessage()
    pendingCommandMessageId.value = appendCommandMessage(`Running ${text.trim()}...`) || null
    activeHandle?.command(text.trim())
    return
  }

  session.messages.push({
    id: uid(),
    role: 'user',
    content: text.trim(),
    timestamp: Date.now(),
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
  })

  const assistant: Message = {
    id: uid(),
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
  }
  session.messages.push(assistant)
  assistantMessageId.value = assistant.id
  session.updatedAt = Date.now()

  isRunning.value = true
  try {
    const input = await buildCliInput(text, attachments)
    activeHandle?.cleanup()
    activeHandle = startCliRun(session.id, input, createHandlers())
  } catch (err) {
    handleRunFailed({
      event: 'run.failed',
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function handleStop() {
  if (!isRunning.value || isAborting.value) return
  isAborting.value = true
  activeHandle?.abort()
}

onMounted(attachToActiveSession)

watch(activeCliSessionId, attachToActiveSession)

onUnmounted(() => {
  activeHandle?.cleanup()
  activeHandle = null
})
</script>

<template>
  <div class="cli-chat-panel">
    <MessageList
      :run-active="isRunning"
      :abort-state="isAborting ? { aborting: true, synced: null } : null"
    />
    <ChatInput
      :send-handler="handleSend"
      :stop-handler="handleStop"
      :streaming="isRunning"
      :aborting="isAborting"
    />
  </div>
</template>

<style scoped lang="scss">
@use '@/styles/variables' as *;

.cli-chat-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
