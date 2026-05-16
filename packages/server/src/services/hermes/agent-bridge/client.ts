import { setTimeout as delay } from 'timers/promises'
import { createConnection, type Socket } from 'net'
import { URL } from 'url'
import { join } from 'path'
import { bridgeLogger } from '../../logger'
import { getActiveProfileName, getProfileDir } from '../hermes-profile'

export const DEFAULT_AGENT_BRIDGE_ENDPOINT = process.platform === 'win32'
  ? 'tcp://127.0.0.1:18765'
  : 'ipc:///tmp/hermes-agent-bridge.sock'
export const DEFAULT_AGENT_BRIDGE_TIMEOUT_MS = 120000

function envPositiveInt(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

export type AgentBridgeStatus = 'running' | 'complete' | 'interrupted' | 'error'

export interface AgentBridgeOptions {
  endpoint?: string
  timeoutMs?: number
}

export interface AgentBridgeRequestOptions {
  timeoutMs?: number
}

export type AgentBridgeMessage =
  | string
  | Array<Record<string, unknown>>

export interface AgentBridgeResponse {
  ok: true
  [key: string]: unknown
}

export interface AgentBridgeChatStarted extends AgentBridgeResponse {
  run_id: string
  session_id: string
  status: AgentBridgeStatus
}

export interface AgentBridgeOutput extends AgentBridgeResponse {
  run_id: string
  session_id: string
  status: AgentBridgeStatus
  delta: string
  cursor: number
  output: string
  done: boolean
  result?: unknown
  error?: string | null
  events: Array<Record<string, unknown>>
  event_cursor: number
}

export interface AgentBridgeRunResult extends AgentBridgeResponse {
  run_id: string
  session_id: string
  status: AgentBridgeStatus
  output: string
  deltas: string[]
  events: unknown[]
  result?: unknown
  error?: string | null
}

export interface AgentBridgeCommandResult extends AgentBridgeResponse {
  session_id: string
  command: string
  handled: boolean
  message?: string
  new_session_id?: string
  history?: unknown[]
  retry?: boolean
  retry_input?: AgentBridgeMessage
  title?: string
}

export class AgentBridgeError extends Error {
  response?: unknown
}

export class AgentBridgeClient {
  readonly endpoint: string
  readonly timeoutMs: number
  private lock: Promise<unknown> = Promise.resolve()

  constructor(options: AgentBridgeOptions = {}) {
    this.endpoint = options.endpoint || process.env.HERMES_AGENT_BRIDGE_ENDPOINT || DEFAULT_AGENT_BRIDGE_ENDPOINT
    this.timeoutMs = options.timeoutMs ?? envPositiveInt('HERMES_AGENT_BRIDGE_TIMEOUT_MS') ?? DEFAULT_AGENT_BRIDGE_TIMEOUT_MS
  }

  private summarizePayload(payload: Record<string, unknown>): Record<string, unknown> {
    const action = String(payload.action || '')
    const summary: Record<string, unknown> = { action }
    for (const key of ['session_id', 'run_id', 'request_id', 'approval_id', 'profile']) {
      if (payload[key] != null) summary[key] = payload[key]
    }
    if (Array.isArray(payload.conversation_history)) summary.conversation_history_count = payload.conversation_history.length
    if (Array.isArray(payload.messages)) summary.messages_count = payload.messages.length
    if (typeof payload.message === 'string') summary.message_chars = payload.message.length
    else if (Array.isArray(payload.message)) summary.message_parts = payload.message.length
    if (typeof payload.command === 'string') summary.command = payload.command
    if (typeof payload.text === 'string') summary.text_chars = payload.text.length
    if (typeof payload.error === 'string') summary.error = payload.error
    if (payload.force_compress === true) summary.force_compress = true
    return summary
  }

  private summarizeResponse(response: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = { ok: response.ok === true }
    for (const key of ['session_id', 'run_id', 'request_id', 'status', 'cursor', 'event_cursor']) {
      if (response[key] != null) summary[key] = response[key]
    }
    if (typeof response.delta === 'string') summary.delta_chars = response.delta.length
    if (typeof response.output === 'string') summary.output_chars = response.output.length
    if (Array.isArray(response.events)) summary.events_count = response.events.length
    if (typeof response.error === 'string') summary.error = response.error
    if (Array.isArray(response.history)) summary.history_count = response.history.length
    return summary
  }

  private runtimeContext(payload: Record<string, unknown>): Record<string, unknown> {
    const requestedProfile = typeof payload.profile === 'string' ? payload.profile.trim() : ''
    let profile = requestedProfile || 'default'
    try {
      if (!requestedProfile) profile = getActiveProfileName()
    } catch {}

    const context: Record<string, unknown> = {
      profile,
      cwd: process.cwd(),
    }
    try {
      const profileDir = getProfileDir(profile)
      context.profile_dir = profileDir
      context.config_path = join(profileDir, 'config.yaml')
    } catch {}
    return context
  }

  async connect(): Promise<this> {
    return this
  }

  async close(): Promise<void> {
    return undefined
  }

  private connectSocket(): Promise<Socket> {
    return new Promise((resolveConnect, rejectConnect) => {
      const endpoint = this.endpoint
      let socket: Socket
      if (endpoint.startsWith('ipc://')) {
        socket = createConnection(endpoint.slice('ipc://'.length))
      } else if (endpoint.startsWith('tcp://')) {
        const url = new URL(endpoint)
        socket = createConnection({
          host: url.hostname || '127.0.0.1',
          port: Number(url.port),
        })
      } else {
        rejectConnect(new Error(`unsupported agent bridge endpoint: ${endpoint}`))
        return
      }

      const cleanup = () => {
        socket.off('connect', onConnect)
        socket.off('error', onError)
      }
      const onConnect = () => {
        cleanup()
        resolveConnect(socket)
      }
      const onError = (err: Error) => {
        cleanup()
        socket.destroy()
        rejectConnect(err)
      }
      socket.once('connect', onConnect)
      socket.once('error', onError)
    })
  }

  private readResponse(socket: Socket, timeoutMs: number): Promise<string> {
    return new Promise((resolveRead, rejectRead) => {
      let buffer = ''
      const timeout = timeoutMs > 0
        ? setTimeout(() => {
            cleanup()
            socket.destroy()
            rejectRead(new Error(`Agent bridge request timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        : null

      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        socket.off('data', onData)
        socket.off('error', onError)
        socket.off('end', onEnd)
        socket.off('close', onClose)
      }
      const finish = (line: string) => {
        cleanup()
        socket.end()
        resolveRead(line)
      }
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const idx = buffer.indexOf('\n')
        if (idx >= 0) finish(buffer.slice(0, idx))
      }
      const onError = (err: Error) => {
        cleanup()
        socket.destroy()
        rejectRead(err)
      }
      const onEnd = () => {
        const line = buffer.trim()
        if (line) finish(line)
      }
      const onClose = () => {
        if (!buffer.trim()) {
          cleanup()
          rejectRead(new Error('Agent bridge socket closed without a response'))
        }
      }

      socket.on('data', onData)
      socket.once('error', onError)
      socket.once('end', onEnd)
      socket.once('close', onClose)
    })
  }

  async request<T extends AgentBridgeResponse = AgentBridgeResponse>(
    payload: Record<string, unknown>,
    options: AgentBridgeRequestOptions = {},
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const timeoutMs = options.timeoutMs || this.timeoutMs
      const startedAt = Date.now()
      const action = String(payload.action || '')
      const shouldLogRequest = action !== 'get_output'
      const runtimeContext = shouldLogRequest ? this.runtimeContext(payload) : undefined
      if (shouldLogRequest) {
        bridgeLogger.info({
          endpoint: this.endpoint,
          timeoutMs,
          runtime: runtimeContext,
          request: this.summarizePayload(payload),
        }, '[agent-bridge-client] request')
      }
      try {
        const socket = await this.connectSocket()
        socket.write(`${JSON.stringify(payload)}\n`)
        const raw = await this.readResponse(socket, timeoutMs)
        const response = JSON.parse(raw) as { ok?: boolean; error?: string }
        if (!response.ok) {
          const error = new AgentBridgeError(response.error || 'Agent bridge request failed')
          error.response = response
          bridgeLogger.warn({
            durationMs: Date.now() - startedAt,
            runtime: runtimeContext,
            response: this.summarizeResponse(response as Record<string, unknown>),
          }, '[agent-bridge-client] request rejected')
          throw error
        }
        if (shouldLogRequest) {
          bridgeLogger.info({
            durationMs: Date.now() - startedAt,
            runtime: runtimeContext,
            response: this.summarizeResponse(response as Record<string, unknown>),
          }, '[agent-bridge-client] response')
        }
        return response as T
      } catch (err: any) {
        if (!(err instanceof AgentBridgeError)) {
          bridgeLogger.error({
            durationMs: Date.now() - startedAt,
            err: { message: err?.message, name: err?.name },
            runtime: runtimeContext,
            request: this.summarizePayload(payload),
          }, '[agent-bridge-client] request failed')
        }
        throw err
      }
    }

    const next = this.lock.then(run, run)
    this.lock = next.catch(() => undefined)
    return next
  }

  ping(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'ping' })
  }

  chat(
    sessionId: string,
    message: AgentBridgeMessage,
    conversationHistory?: unknown[],
    instructions?: string,
    profile?: string,
    options: { force_compress?: boolean; storage_message?: AgentBridgeMessage } = {},
  ): Promise<AgentBridgeChatStarted> {
    return this.request<AgentBridgeChatStarted>({
      action: 'chat',
      session_id: sessionId,
      message,
      ...(options.storage_message !== undefined ? { storage_message: options.storage_message } : {}),
      ...(conversationHistory ? { conversation_history: conversationHistory } : {}),
      ...(instructions ? { instructions } : {}),
      ...(profile ? { profile } : {}),
      ...(options.force_compress ? { force_compress: true } : {}),
    })
  }

  command(sessionId: string, command: string): Promise<AgentBridgeCommandResult> {
    return this.request<AgentBridgeCommandResult>({
      action: 'command',
      session_id: sessionId,
      command,
    })
  }

  getOutput(runId: string, cursor = 0, eventCursor = 0, options: AgentBridgeRequestOptions = {}): Promise<AgentBridgeOutput> {
    return this.request<AgentBridgeOutput>({
      action: 'get_output',
      run_id: runId,
      cursor,
      event_cursor: eventCursor,
    }, options)
  }

  async *streamOutput(
    runId: string,
    options: AgentBridgeRequestOptions & { intervalMs?: number } = {},
  ): AsyncGenerator<AgentBridgeOutput> {
    const intervalMs = options.intervalMs || 100
    let cursor = 0
    let eventCursor = 0
    for (;;) {
      const chunk = await this.getOutput(runId, cursor, eventCursor, options)
      cursor = chunk.cursor
      eventCursor = chunk.event_cursor
      if (chunk.delta || chunk.done || (chunk.events && chunk.events.length > 0)) yield chunk
      if (chunk.done) return
      await delay(intervalMs)
    }
  }

  async chatStream(
    sessionId: string,
    message: AgentBridgeMessage,
    onDelta: (delta: string, chunk: AgentBridgeOutput) => void | Promise<void>,
    options: AgentBridgeRequestOptions & { intervalMs?: number } = {},
  ): Promise<AgentBridgeOutput> {
    const started = await this.chat(sessionId, message)
    let last: AgentBridgeOutput | null = null
    for await (const chunk of this.streamOutput(started.run_id, options)) {
      last = chunk
      if (chunk.delta) await onDelta(chunk.delta, chunk)
    }
    if (!last) throw new Error(`Agent bridge run ${started.run_id} produced no output state`)
    return last
  }

  getResult(runId: string, options: AgentBridgeRequestOptions = {}): Promise<AgentBridgeRunResult> {
    return this.request<AgentBridgeRunResult>({ action: 'get_result', run_id: runId }, options)
  }

  interrupt(sessionId: string, message?: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'interrupt', session_id: sessionId, message })
  }

  steer(sessionId: string, text: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'steer', session_id: sessionId, text })
  }

  approvalRespond(approvalId: string, choice: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'approval_respond', approval_id: approvalId, choice })
  }

  compressionRespond(
    requestId: string,
    payload: { messages?: unknown[]; system_message?: string; error?: string },
  ): Promise<AgentBridgeResponse> {
    return this.request({
      action: 'compression_respond',
      request_id: requestId,
      ...payload,
    }, { timeoutMs: this.timeoutMs })
  }

  destroyAll(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'destroy_all' })
  }

  getHistory(sessionId: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'get_history', session_id: sessionId })
  }

  destroy(sessionId: string): Promise<AgentBridgeResponse> {
    return this.request({ action: 'destroy', session_id: sessionId })
  }

  list(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'list' })
  }

  shutdown(): Promise<AgentBridgeResponse> {
    return this.request({ action: 'shutdown' })
  }
}

export default AgentBridgeClient
