import type { Server, Socket } from 'socket.io'
import { AgentBridgeClient, type AgentBridgeMessage, type AgentBridgeOutput } from './agent-bridge'
import { logger } from '../logger'

interface CliSessionState {
  sessionId: string
  isWorking: boolean
  isAborting: boolean
  runId?: string
  output: string
  events: Array<{ event: string; data: any }>
  updatedAt: number
}

/**
 * Socket.IO bridge for CLI-style Hermes Agent conversations.
 *
 * This namespace talks to the Python in-process AIAgent bridge instead of the
 * API Server /v1/responses path used by ChatRunSocket.
 */
export class CliChatRunSocket {
  private nsp: ReturnType<Server['of']>
  private bridge: AgentBridgeClient
  private sessions = new Map<string, CliSessionState>()
  private closed = false

  constructor(io: Server, bridge = new AgentBridgeClient()) {
    this.nsp = io.of('/cli-chat-run')
    this.bridge = bridge
  }

  init() {
    this.nsp.use(this.authMiddleware.bind(this))
    this.nsp.on('connection', this.onConnection.bind(this))
    logger.info('[cli-chat-run-socket] Socket.IO ready at /cli-chat-run')
  }

  private async authMiddleware(socket: Socket, next: (err?: Error) => void) {
    const token = socket.handshake.auth?.token as string | undefined
    if (!process.env.AUTH_DISABLED && process.env.AUTH_DISABLED !== '1') {
      const { getToken } = await import('../auth')
      const serverToken = await getToken()
      if (serverToken && token !== serverToken) {
        return next(new Error('Authentication failed'))
      }
    }
    next()
  }

  private onConnection(socket: Socket) {
    socket.on('resume', async (data: { session_id?: string }) => {
      if (!data.session_id) return
      const sid = data.session_id
      socket.join(this.room(sid))
      const state = this.getOrCreateSession(sid)
      socket.emit('resumed', {
        session_id: sid,
        isWorking: state.isWorking,
        isAborting: state.isAborting,
        run_id: state.runId,
        output: state.output,
        events: state.isWorking ? state.events : [],
      })
      logger.info('[cli-chat-run-socket] socket %s resumed session %s (working: %s)', socket.id, sid, state.isWorking)
    })

    socket.on('run', async (data: { input?: unknown; session_id?: string }) => {
      const input = data.input
      const sid = data.session_id?.trim()
      if (!sid || !this.hasInput(input)) {
        socket.emit('run.failed', {
          event: 'run.failed',
          session_id: sid,
          error: 'session_id and input are required',
        })
        return
      }
      socket.join(this.room(sid))
      if (typeof input === 'string' && input.trim().startsWith('/')) {
        void this.handleCommand(sid, input.trim())
        return
      }
      void this.handleRun(sid, input as AgentBridgeMessage)
    })

    socket.on('command', async (data: { command?: string; session_id?: string }) => {
      const command = typeof data.command === 'string' ? data.command.trim() : ''
      const sid = data.session_id?.trim()
      if (!sid || !command) {
        socket.emit('command.completed', {
          event: 'command.completed',
          session_id: sid,
          handled: false,
          error: 'session_id and command are required',
        })
        return
      }
      socket.join(this.room(sid))
      void this.handleCommand(sid, command)
    })

    socket.on('abort', (data: { session_id?: string; message?: string }) => {
      if (data.session_id) void this.handleAbort(data.session_id, data.message)
    })

    socket.on('steer', (data: { session_id?: string; text?: string; message?: string }) => {
      if (data.session_id) void this.handleSteer(data.session_id, data.text || data.message || '')
    })
  }

  private hasInput(input: unknown): boolean {
    if (typeof input === 'string') return Boolean(input.trim())
    return Array.isArray(input) && input.length > 0
  }

  private async handleRun(sessionId: string, input: AgentBridgeMessage) {
    const state = this.getOrCreateSession(sessionId)
    if (state.isWorking) {
      this.emit(sessionId, 'run.failed', {
        event: 'run.failed',
        error: 'session busy',
      })
      return
    }

    state.isWorking = true
    state.isAborting = false
    state.output = ''
    state.events = []
    state.updatedAt = Date.now()

    try {
      logger.info('[cli-chat-run-socket] starting CLI bridge run for session %s', sessionId)
      const started = await this.bridge.chat(sessionId, input)
      state.runId = started.run_id
      this.pushState(sessionId, 'run.started', {
        event: 'run.started',
        run_id: started.run_id,
      })
      this.emit(sessionId, 'run.started', {
        event: 'run.started',
        run_id: started.run_id,
      })

      for await (const chunk of this.bridge.streamOutput(started.run_id)) {
        if (this.closed) return
        this.applyChunk(sessionId, chunk)
        if (chunk.done) break
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      state.isWorking = false
      state.isAborting = false
      state.updatedAt = Date.now()
      this.replaceState(sessionId, 'run.failed', {
        event: 'run.failed',
        run_id: state.runId,
        error: message,
      })
      this.emit(sessionId, 'run.failed', {
        event: 'run.failed',
        run_id: state.runId,
        error: message,
      })
      logger.warn(err, '[cli-chat-run-socket] run failed for session %s', sessionId)
    }
  }

  private async handleCommand(sessionId: string, command: string) {
    try {
      logger.info('[cli-chat-run-socket] command %s for session %s', command, sessionId)
      this.emit(sessionId, 'command.started', {
        event: 'command.started',
        command,
      })
      const result = await this.bridge.command(sessionId, command)
      this.emit(sessionId, 'command.completed', {
        event: 'command.completed',
        ...result,
      })

      if (result.retry && result.retry_input) {
        const nextSessionId = result.new_session_id || sessionId
        void this.handleRun(nextSessionId, result.retry_input)
      }
    } catch (err) {
      this.emit(sessionId, 'command.completed', {
        event: 'command.completed',
        command,
        handled: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private applyChunk(sessionId: string, chunk: AgentBridgeOutput) {
    const state = this.getOrCreateSession(sessionId)
    state.updatedAt = Date.now()
    state.runId = chunk.run_id

    if (chunk.delta) {
      state.output += chunk.delta
      this.emit(sessionId, 'message.delta', {
        event: 'message.delta',
        run_id: chunk.run_id,
        delta: chunk.delta,
        output: state.output,
      })
    }

    if (!chunk.done) return

    state.isWorking = false
    state.isAborting = false
    const eventName = chunk.status === 'error' ? 'run.failed' : 'run.completed'
    const payload = {
      event: eventName,
      run_id: chunk.run_id,
      output: chunk.output || state.output,
      result: chunk.result,
      error: chunk.error,
    }
    this.replaceState(sessionId, eventName, payload)
    this.emit(sessionId, eventName, payload)
  }

  private async handleAbort(sessionId: string, message?: string) {
    const state = this.getOrCreateSession(sessionId)
    if (!state.isWorking) {
      this.emit(sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: state.runId,
        synced: false,
      })
      return
    }

    state.isAborting = true
    this.replaceState(sessionId, 'abort.started', {
      event: 'abort.started',
      run_id: state.runId,
    })
    this.emit(sessionId, 'abort.started', {
      event: 'abort.started',
      run_id: state.runId,
    })

    try {
      await this.bridge.interrupt(sessionId, message)
      this.replaceState(sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: state.runId,
        synced: true,
      })
      this.emit(sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: state.runId,
        synced: true,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.emit(sessionId, 'abort.completed', {
        event: 'abort.completed',
        run_id: state.runId,
        synced: false,
        error,
      })
    }
  }

  private async handleSteer(sessionId: string, text: string) {
    const cleaned = text.trim()
    if (!cleaned) {
      this.emit(sessionId, 'steer.completed', {
        event: 'steer.completed',
        accepted: false,
        error: 'text is required',
      })
      return
    }
    try {
      const result = await this.bridge.steer(sessionId, cleaned)
      this.emit(sessionId, 'steer.completed', {
        event: 'steer.completed',
        ...result,
      })
    } catch (err) {
      this.emit(sessionId, 'steer.completed', {
        event: 'steer.completed',
        accepted: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private getOrCreateSession(sessionId: string): CliSessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        sessionId,
        isWorking: false,
        isAborting: false,
        output: '',
        events: [],
        updatedAt: Date.now(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private pushState(sessionId: string, event: string, data: any) {
    const state = this.getOrCreateSession(sessionId)
    state.events.push({ event, data: { ...data, session_id: sessionId } })
  }

  private replaceState(sessionId: string, event: string, data: any) {
    const state = this.getOrCreateSession(sessionId)
    const idx = state.events.findIndex(item => item.event === event)
    const next = { event, data: { ...data, session_id: sessionId } }
    if (idx >= 0) state.events[idx] = next
    else state.events.push(next)
  }

  private room(sessionId: string): string {
    return `session:${sessionId}`
  }

  private emit(sessionId: string, event: string, payload: any) {
    this.nsp.to(this.room(sessionId)).emit(event, {
      ...payload,
      session_id: sessionId,
    })
  }

  close() {
    this.closed = true
    for (const [sessionId, state] of this.sessions.entries()) {
      if (state.isWorking) {
        void this.bridge.interrupt(sessionId, 'Server shutting down').catch(() => undefined)
      }
    }
    this.sessions.clear()
    logger.info('[cli-chat-run-socket] closed all sessions')
  }
}
