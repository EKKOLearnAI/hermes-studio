import { createHash } from 'crypto'
import type { ChatWebhookEventType } from '../../../db/hermes/chat-webhook-store'

export const CHAT_WEBHOOK_SCHEMA_VERSION = 1
export const MAX_WEBHOOK_CONTENT_BYTES = 64 * 1024

export type ChatRunWebhookSource = 'chat' | 'api_server' | 'cli' | 'coding_agent' | 'global_agent' | 'workflow' | 'group_chat'
export type ChatRunWebhookAgent = 'bridge' | 'ekko' | 'claude-code' | 'codex' | 'pi'
export type ChatWebhookLifecycleStatus = 'created' | 'queued' | 'started' | 'requested' | 'resolved' | 'completed' | 'failed'
export type ChatWebhookMessageRole = 'user' | 'command' | 'assistant'

export interface ChatRunWebhookEvent {
  id: string
  type: ChatWebhookEventType
  occurred_at: string
  profile: string
  source: ChatRunWebhookSource
  agent: ChatRunWebhookAgent
  subject: {
    session_id: string
    run_id?: string
    queue_id?: string
    message_id?: string
    tool_call_id?: string
    approval_id?: string
    clarification_id?: string
    room_id?: string
    workflow_id?: string
    workflow_node_id?: string
  }
  summary: {
    status: ChatWebhookLifecycleStatus
    role?: ChatWebhookMessageRole
    tool_name?: string
    queue_length?: number
    choice?: string
    choices?: string[]
    resolved?: boolean
    allow_permanent?: boolean
    input_tokens?: number
    output_tokens?: number
    error_kind?: string
  }
  content?: string
  content_truncated?: boolean
  content_role?: ChatWebhookMessageRole
}

export interface ChatRunWebhookEnvelope extends Omit<ChatRunWebhookEvent, 'content' | 'content_truncated' | 'content_role'> {
  schema_version: number
  message?: {
    id?: string
    role: ChatWebhookMessageRole
    text: string
    truncated: boolean
  }
}

export function stableChatWebhookEventId(dedupeKey: string): string {
  return createHash('sha256').update(dedupeKey).digest('hex').slice(0, 32)
}

export function truncateChatWebhookContent(
  value: string,
  maxBytes = MAX_WEBHOOK_CONTENT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.length <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

export function buildChatWebhookEnvelope(
  event: ChatRunWebhookEvent,
  includeAssistantContent: boolean,
  includeUserContent = false,
): ChatRunWebhookEnvelope {
  const { content, content_truncated: contentTruncated, content_role: contentRole, ...metadata } = event
  const envelope: ChatRunWebhookEnvelope = {
    schema_version: CHAT_WEBHOOK_SCHEMA_VERSION,
    ...metadata,
  }
  const shouldIncludeContent = (
    (includeAssistantContent && event.type === 'chat.run.completed')
    || (includeUserContent && event.type === 'chat.message.created')
  )
  if (shouldIncludeContent && content) {
    const value = truncateChatWebhookContent(content)
    envelope.message = {
      id: event.subject.message_id,
      role: contentRole || (event.type === 'chat.message.created' ? 'user' : 'assistant'),
      text: value.text,
      truncated: contentTruncated === true || value.truncated,
    }
  }
  return envelope
}
