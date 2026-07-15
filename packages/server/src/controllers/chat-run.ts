import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import { io, type Socket } from 'socket.io-client'
import { config } from '../config'

type ChatRunPayload = Record<string, unknown> & {
  input?: unknown
  session_id?: unknown
  profile?: unknown
  timeout_ms?: unknown
  include_events?: unknown
}

type ChatRunEvent = Record<string, unknown> & {
  event?: string
  session_id?: string
  run_id?: string
  delta?: string
  text?: string
  output?: string | null
  reasoning?: string | null
  error?: unknown
}

const CHAT_RUN_EVENTS = [
  'run.started',
  'message.delta',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'workspace.diff.completed',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'peer.user.message',
]

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 1_800_000
const MAX_RECORDED_EVENTS = 1000

function bearerToken(ctx: Context): string {
  const match = ctx.get('authorization').match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

function requestTimeoutMs(value: unknown): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.floor(numeric), MAX_TIMEOUT_MS)
}

function chatRunBaseUrl(): string {
  return (process.env.HERMES_WEB_UI_URL || `http://127.0.0.1:${config.port}`).replace(/\/$/, '')
}

function profileFrom(ctx: Context, body: ChatRunPayload): string {
  return String(body.profile || ctx.state.profile?.name || 'default').trim() || 'default'
}

function userBody(body: ChatRunPayload): Record<string, unknown> {
  const { timeout_ms: _timeoutMs, include_events: _includeEvents, ...payload } = body
  return payload
}

function generatedSessionId(): string {
  return randomUUID()
}

function needsGeneratedSessionId(payload: Record<string, unknown>): boolean {
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : ''
  return !sessionId
}

export async function runOnce(ctx: Context) {
  const body = (ctx.request.body || {}) as ChatRunPayload
  if (body.input == null) {
    ctx.status = 400
    ctx.body = { ok: false, error: 'input is required' }
    return
  }

  const timeoutMs = requestTimeoutMs(body.timeout_ms)
  const includeEvents = body.include_events === true
  const token = bearerToken(ctx)
  const profile = profileFrom(ctx, body)
  const payload: Record<string, unknown> = { ...userBody(body), profile }
  if (needsGeneratedSessionId(payload)) payload.session_id = generatedSessionId()

  ctx.body = await new Promise((resolve) => {
    const events: ChatRunEvent[] = []
    let output = ''
    let reasoning = ''
    let runId = ''
    let settled = false

    const socket: Socket = io(`${chatRunBaseUrl()}/chat-run`, {
      auth: token ? { token } : {},
      query: { profile },
      transports: ['websocket', 'polling'],
      reconnection: false,
      timeout: 30_000,
    })

    const cleanup = () => {
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.disconnect()
    }

    const finish = (status: number, response: Record<string, unknown>) => {
      if (settled) return
      settled = true
      cleanup()
      ctx.status = status
      resolve({
        ...response,
        session_id: typeof payload.session_id === 'string' ? payload.session_id : undefined,
        run_id: runId || undefined,
        output,
        ...(reasoning ? { reasoning } : {}),
        ...(includeEvents ? { events } : {}),
      })
    }

    const record = (event: ChatRunEvent) => {
      if (!includeEvents) return
      if (events.length >= MAX_RECORDED_EVENTS) events.shift()
      events.push(event)
    }

    const timer = setTimeout(() => {
      finish(504, {
        ok: false,
        status: 'timeout',
        error: `chat-run timed out after ${timeoutMs}ms`,
      })
    }, timeoutMs)

    socket.on('connect_error', (err: Error) => {
      finish(503, {
        ok: false,
        status: 'connect_error',
        error: err.message,
      })
    })

    socket.on('connect', () => {
      socket.emit('run', payload)
    })

    for (const eventName of CHAT_RUN_EVENTS) {
      socket.on(eventName, (event: ChatRunEvent = {}) => {
        const tagged = { ...event, event: event.event || eventName }
        record(tagged)
        if (typeof tagged.run_id === 'string' && tagged.run_id) runId = tagged.run_id
        if (eventName === 'message.delta' && typeof tagged.delta === 'string') output += tagged.delta
        if ((eventName === 'reasoning.delta' || eventName === 'thinking.delta') && typeof tagged.delta === 'string') reasoning += tagged.delta
        if (eventName === 'run.completed') {
          if (typeof tagged.output === 'string' && tagged.output) output = tagged.output
          if (typeof tagged.reasoning === 'string' && tagged.reasoning) reasoning = tagged.reasoning
          finish(200, { ok: true, status: 'completed', event: eventName })
          return
        }
        if (eventName === 'run.failed') {
          finish(500, {
            ok: false,
            status: 'failed',
            event: eventName,
            error: tagged.error || 'chat-run failed',
          })
          return
        }
        if (eventName === 'approval.requested' || eventName === 'clarify.requested') {
          finish(409, {
            ok: false,
            status: 'requires_action',
            event: eventName,
            action: tagged,
          })
        }
      })
    }
  })
}
