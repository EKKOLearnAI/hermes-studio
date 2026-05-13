import { io, type Socket } from 'socket.io-client'
import { getApiKey, getBaseUrlValue } from '../client'
import type { ContentBlock } from './chat'

export interface CliRunEvent {
  event: string
  session_id?: string
  run_id?: string
  delta?: string
  output?: string
  result?: unknown
  error?: string
  synced?: boolean
  accepted?: boolean
  isWorking?: boolean
  isAborting?: boolean
  events?: Array<{ event: string; data: CliRunEvent }>
  handled?: boolean
  command?: string
  message?: string
  new_session_id?: string
  history?: unknown[]
  retry?: boolean
  retry_input?: string | ContentBlock[]
  title?: string
}

export interface CliRunHandlers {
  onStarted?: (event: CliRunEvent) => void
  onDelta?: (event: CliRunEvent) => void
  onCompleted?: (event: CliRunEvent) => void
  onFailed?: (event: CliRunEvent) => void
  onAbortStarted?: (event: CliRunEvent) => void
  onAbortCompleted?: (event: CliRunEvent) => void
  onSteerCompleted?: (event: CliRunEvent) => void
  onCommandCompleted?: (event: CliRunEvent) => void
}

let cliChatSocket: Socket | null = null

export function connectCliChatRun(): Socket {
  if (cliChatSocket?.connected) return cliChatSocket

  if (cliChatSocket) {
    cliChatSocket.removeAllListeners()
    cliChatSocket.disconnect()
  }

  cliChatSocket = io(`${getBaseUrlValue()}/cli-chat-run`, {
    auth: { token: getApiKey() },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  })

  return cliChatSocket
}

export function disconnectCliChatRun(): void {
  if (!cliChatSocket) return
  cliChatSocket.removeAllListeners()
  cliChatSocket.disconnect()
  cliChatSocket = null
}

export function resumeCliSession(
  sessionId: string,
  onResumed: (event: CliRunEvent) => void,
): Socket {
  const socket = connectCliChatRun()
  const handler = (event: CliRunEvent) => {
    if (event.session_id !== sessionId) return
    socket.off('resumed', handler)
    onResumed(event)
  }
  socket.on('resumed', handler)
  socket.emit('resume', { session_id: sessionId })
  return socket
}

export function startCliRun(
  sessionId: string,
  input: string | ContentBlock[],
  handlers: CliRunHandlers = {},
): { abort: () => void; steer: (text: string) => void; command: (command: string) => void; cleanup: () => void } {
  const handle = watchCliSession(sessionId, handlers)
  handle.socket.emit('run', { session_id: sessionId, input })

  return {
    abort: handle.abort,
    steer: handle.steer,
    command: handle.command,
    cleanup: handle.cleanup,
  }
}

export function watchCliSession(
  sessionId: string,
  handlers: CliRunHandlers = {},
): { socket: Socket; abort: () => void; steer: (text: string) => void; command: (command: string) => void; cleanup: () => void } {
  const socket = connectCliChatRun()
  let closed = false

  const forSession = (event: CliRunEvent) => event.session_id === sessionId

  const onStarted = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onStarted?.(event)
  }
  const onDelta = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onDelta?.(event)
  }
  const onCompleted = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onCompleted?.(event)
    cleanup()
  }
  const onFailed = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onFailed?.(event)
    cleanup()
  }
  const onAbortStarted = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onAbortStarted?.(event)
  }
  const onAbortCompleted = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onAbortCompleted?.(event)
  }
  const onSteerCompleted = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onSteerCompleted?.(event)
  }
  const onCommandCompleted = (event: CliRunEvent) => {
    if (closed || !forSession(event)) return
    handlers.onCommandCompleted?.(event)
  }

  function cleanup() {
    if (closed) return
    closed = true
    socket.off('run.started', onStarted)
    socket.off('message.delta', onDelta)
    socket.off('run.completed', onCompleted)
    socket.off('run.failed', onFailed)
    socket.off('abort.started', onAbortStarted)
    socket.off('abort.completed', onAbortCompleted)
    socket.off('steer.completed', onSteerCompleted)
    socket.off('command.completed', onCommandCompleted)
  }

  socket.on('run.started', onStarted)
  socket.on('message.delta', onDelta)
  socket.on('run.completed', onCompleted)
  socket.on('run.failed', onFailed)
  socket.on('abort.started', onAbortStarted)
  socket.on('abort.completed', onAbortCompleted)
  socket.on('steer.completed', onSteerCompleted)
  socket.on('command.completed', onCommandCompleted)

  return {
    socket,
    abort: () => {
      if (!closed) socket.emit('abort', { session_id: sessionId })
    },
    steer: (text: string) => {
      if (!closed) socket.emit('steer', { session_id: sessionId, text })
    },
    command: (command: string) => {
      if (!closed) socket.emit('command', { session_id: sessionId, command })
    },
    cleanup,
  }
}
