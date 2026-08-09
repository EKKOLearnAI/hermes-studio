/**
 * The wire format for outbound operational events.
 *
 * The envelope is deliberately small: identifiers plus a privacy-safe summary,
 * never conversation content. A receiver that needs the text of a run has to
 * ask the API for it with its own credentials, so a webhook URL leaking never
 * leaks what people said.
 */

export const EVENT_SCHEMA_VERSION = 1

export const EVENT_TYPES = [
  'chat.run.completed',
  'chat.run.failed',
  'chat.approval.requested',
  'chat.clarification.requested',
  'group.run.completed',
  'group.run.failed',
  'group.message.created',
  'cron.run.completed',
  'cron.run.failed',
  'workflow.run.completed',
  'workflow.run.failed',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && (EVENT_TYPES as readonly string[]).includes(value)
}

/** Identifiers a receiver needs to fetch the full record itself. */
export interface EventSubject {
  session_id?: string
  run_id?: string
  message_id?: string
  room_id?: string
  job_id?: string
  workflow_id?: string
  workflow_run_id?: string
  agent_id?: string
}

/**
 * Counts, durations and status — never message text. `title` is included only
 * where the user already named the thing (a job or workflow name).
 */
export interface EventSummary {
  status?: string
  title?: string
  model?: string
  provider?: string
  duration_ms?: number
  message_count?: number
  tool_call_count?: number
  input_tokens?: number
  output_tokens?: number
  error_kind?: string
  tool_name?: string
}

export interface EventEnvelope {
  schema_version: number
  id: string
  type: EventType
  occurred_at: string
  profile: string
  source: string
  subject: EventSubject
  summary: EventSummary
}

function compact<T extends object>(input: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    out[key] = value
  }
  return out as T
}

export interface EnvelopeInput {
  id: string
  type: EventType
  occurredAt: number
  profile: string
  source: string
  subject: EventSubject
  summary: EventSummary
}

export function buildEnvelope(input: EnvelopeInput): EventEnvelope {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    id: input.id,
    type: input.type,
    occurred_at: new Date(input.occurredAt).toISOString(),
    profile: input.profile || 'default',
    source: input.source || '',
    subject: compact(input.subject),
    summary: compact(input.summary),
  }
}
