import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import type { ChatRunSocket } from '../services/hermes/run-chat'

type ChatRunPayload = Record<string, unknown> & {
  input?: unknown
  session_id?: unknown
  profile?: unknown
  timeout_ms?: unknown
  include_events?: unknown
}

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MAX_RECORDED_EVENTS = 1000

function requestTimeoutMs(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(numeric), MAX_TIMEOUT_MS)
}

function profileFrom(ctx: Context, body: ChatRunPayload): string {
  return String(body.profile || ctx.state.profile?.name || 'default').trim() || 'default'
}

function userBody(body: ChatRunPayload): Record<string, unknown> {
  const {
    timeout_ms: _timeoutMs,
    include_events: _includeEvents,
    invocation_id: _invocationId,
    ...payload
  } = body
  return payload
}

async function currentChatRunServer(): Promise<ChatRunSocket | null> {
  // Dynamic import avoids a controller/route initialization cycle.
  const routes = await import('../routes/hermes/chat-run')
  return routes.getChatRunServer?.() || null
}

export async function runOnce(ctx: Context) {
  const body = (ctx.request.body || {}) as ChatRunPayload
  if (body.input == null) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'input is required' }
    return
  }

  const chatRun = await currentChatRunServer()
  if (!chatRun?.runAndWait) {
    ctx.status = 503
    ctx.body = { ok: false, status: 'unavailable', error: 'chat-run server is not available' }
    return
  }

  const profile = profileFrom(ctx, body)
  const payload: Record<string, unknown> = { ...userBody(body), profile }
  const sessionId = String(payload.session_id || '').trim() || randomUUID()
  payload.session_id = sessionId
  const includeEvents = body.include_events === true
  const events: Array<Record<string, unknown>> = []
  const record = (event: string, data: Record<string, unknown> = {}) => {
    if (!includeEvents) return
    if (events.length >= MAX_RECORDED_EVENTS) events.shift()
    const { invocation_id: _invocationId, ...publicData } = data
    events.push({ ...publicData, event: typeof publicData.event === 'string' ? publicData.event : event })
  }

  try {
    const result = await chatRun.runAndWait(payload as any, {
      profile,
      user: ctx.state.user,
      attachmentTimeoutMs: requestTimeoutMs(body.timeout_ms),
      detachOnAction: true,
      onEvent: record,
    })
    const common = {
      session_id: sessionId,
      run_id: result.run_id || undefined,
      output: result.output || '',
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      ...(includeEvents ? { events } : {}),
    }
    if (result.event === 'run.completed' && result.ok) {
      ctx.status = 200
      ctx.body = { ok: true, status: 'completed', event: result.event, ...common }
      return
    }
    if (result.event === 'action.required') {
      ctx.status = 409
      ctx.body = {
        ok: false,
        status: 'requires_action',
        event: typeof result.action?.event === 'string' ? result.action.event : 'action.required',
        action: result.action,
        ...common,
      }
      return
    }
    if (result.event === 'wait.timed_out') {
      ctx.status = 504
      ctx.body = { ok: false, status: 'timeout', event: result.event, error: result.error, ...common }
      return
    }
    ctx.status = 500
    ctx.body = { ok: false, status: 'failed', event: result.event, error: result.error || 'chat-run failed', ...common }
  } catch (err) {
    ctx.status = 500
    ctx.body = {
      ok: false,
      status: 'failed',
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
      ...(includeEvents ? { events } : {}),
    }
  }
}
