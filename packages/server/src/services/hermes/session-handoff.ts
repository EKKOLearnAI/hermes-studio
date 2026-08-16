import {
  createHandoffSession,
  getSession,
  getSessionDetail,
  type HermesMessageRow,
  type HermesSessionRow,
} from '../../db/hermes/session-store'
import { codingAgentRunManager } from '../coding-agents/runtime/run-manager'

export interface HandoffMessageInput {
  role: string
  content: string
  display_role?: string | null
  display_content?: string | null
  timestamp?: number
  token_count?: number | null
  finish_reason?: string | null
  reasoning?: string | null
  reasoning_details?: string | null
  reasoning_content?: string | null
}

export type HandoffResult =
  | { ok: true; session: HermesSessionRow }
  | { ok: false; status: number; error: string }

export function isHandoffSourceSession(session: HermesSessionRow | null | undefined): boolean {
  return (session?.agent === 'codex' || session?.agent === 'claude') && session.source === 'coding_agent'
}

export function normalizeHandoffMessages(messages: HermesMessageRow[]): HandoffMessageInput[] {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .map(message => ({
      role: message.role,
      content: message.content,
      display_role: message.display_role ?? null,
      display_content: message.display_content ?? null,
      timestamp: message.timestamp,
      token_count: message.token_count ?? null,
      finish_reason: message.finish_reason ?? null,
      reasoning: message.reasoning ?? null,
      reasoning_details: message.reasoning_details ?? null,
      reasoning_content: message.reasoning_content ?? null,
    }))
}

function handoffSessionId(): string {
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
  return `${ts}_${Math.random().toString(16).slice(2, 8)}`
}

export function createHermesHandoffSession(
  sourceSessionId: string,
  options: { profile?: string } = {},
): HandoffResult {
  const source = getSession(sourceSessionId)
  if (!source || !isHandoffSourceSession(source)) {
    return { ok: false, status: 404, error: 'Source session not found or is not a Codex/Claude Code session' }
  }
  if (source.ended_at == null && Number(source.message_count || 0) > 0 && codingAgentRunManager.isSessionProcessing(sourceSessionId)) {
    return { ok: false, status: 409, error: 'Cannot hand off a session that is still running' }
  }

  const detail = getSessionDetail(sourceSessionId)
  const messages = normalizeHandoffMessages(detail?.messages || [])
  const sourceTitle = source.title || source.preview || 'session'
  const session = createHandoffSession({
    id: handoffSessionId(),
    parent_session_id: source.id,
    profile: options.profile || source.profile || 'default',
    source: 'cli',
    agent: 'hermes',
    title: `handoff: ${sourceTitle}`.slice(0, 120),
    workspace: source.workspace,
    category_id: source.category_id,
    messages,
  })
  if (!session) return { ok: false, status: 500, error: 'Failed to create handoff session' }
  return { ok: true, session }
}
