/**
 * Abort handler — cancels in-progress runs (both API server and CLI bridge).
 */

import type { Server, Socket } from 'socket.io'
import { updateSessionStats } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import { codingAgentRunManager } from '../../agent-runner/coding-agent-run-manager'
import { flushBridgePendingToDb } from './bridge-message'
import { flushResponseRunToDb } from './response-stream'
import { replaceState } from './compression'
import { calcAndUpdateUsage } from './usage'
import type { QueuedRun, SessionState } from './types'

const ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE = 'Hermes Agent did not confirm stop before timeout. Local run state was released so you can continue.'

function isBridgeRunSource(source?: string): boolean {
  return source === 'cli' || source === 'global_agent'
}

export async function handleAbort(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  sessionMap: Map<string, SessionState>,
  bridge: any,
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void,
) {
  let state = sessionMap.get(sessionId)
  const hasCodingAgentRun = codingAgentRunManager.hasSession(sessionId)
  if (!state && hasCodingAgentRun) {
    state = { messages: [], isWorking: true, events: [], queue: [], source: 'coding_agent' }
    sessionMap.set(sessionId, state)
  }
  const isCodingAgentRun = state?.source === 'coding_agent' || hasCodingAgentRun
  if ((!state?.isWorking && !hasCodingAgentRun) || (state && !isCodingAgentRun && !state.runId && !state.abortController)) {
    logger.info({ sessionId }, '[chat-run-socket][abort] ignored: no active run')
    if (state) {
      state.isWorking = false
      state.isAborting = false
      state.abortController = undefined
      state.runId = undefined
      state.events = []
    }
    emitToSession(nsp, socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      synced: false,
      ignored: true,
    })
    return
  }

  const activeState = state
  if (!activeState) return

  const runId = activeState.runId
  activeState.isAborting = true
  replaceState(sessionMap, sessionId, 'abort.started', {
    event: 'abort.started',
    run_id: runId,
    graceMs: 5000,
  })
  emitToSession(nsp, socket, sessionId, 'abort.started', {
    event: 'abort.started',
    run_id: runId,
    graceMs: 5000,
  })
  logger.info({ sessionId, runId }, '[chat-run-socket][abort] started')

  // Flush in-memory assistant text to DB before aborting the stream.
  if (isBridgeRunSource(activeState.source)) {
    flushBridgePendingToDb(activeState, sessionId)
  } else {
    flushResponseRunToDb(activeState, sessionId)
  }

  if (isBridgeRunSource(activeState.source)) {
    let interruptResult: any = null
    try {
      interruptResult = await bridge.interrupt(sessionId, 'Aborted by user', activeState.profile)
    } catch (err) {
      logger.warn(err, '[chat-run-socket][abort] failed to interrupt CLI bridge for session %s', sessionId)
    }
    try {
      await bridge.goalPause?.(sessionId, 'user-interrupted', activeState.profile)
      activeState.queue = activeState.queue.filter(item => !item.goalContinuation)
    } catch (err) {
      logger.debug(err, '[chat-run-socket][abort] goal pause-on-interrupt skipped for session %s', sessionId)
    }
    if (interruptResult?.synced === false) {
      replaceState(sessionMap, sessionId, 'abort.timeout', {
        event: 'abort.timeout',
        run_id: runId,
        synced: false,
        message: ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE,
      })
      emitToSession(nsp, socket, sessionId, 'abort.timeout', {
        event: 'abort.timeout',
        run_id: runId,
        synced: false,
        message: ABORT_BRIDGE_SYNC_TIMEOUT_MESSAGE,
      })
      logger.warn({ sessionId, runId }, '[chat-run-socket][abort] CLI bridge interrupt did not sync before timeout')
      try {
        await bridge.destroy?.(sessionId, activeState.profile)
      } catch (err) {
        logger.warn(err, '[chat-run-socket][abort] failed to destroy timed-out CLI bridge session %s', sessionId)
      }
      await markAbortCompleted(nsp, socket, sessionId, runId || 'bridge_abort_timeout', sessionMap, runQueuedItem, false)
      return
    }
  } else if (activeState.source === 'coding_agent') {
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
  } else if (activeState.abortController) {
    activeState.abortController.abort()
  }

  await markAbortCompleted(nsp, socket, sessionId, runId || 'response_stream', sessionMap, runQueuedItem)
}

export async function markAbortCompleted(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  runId: string,
  sessionMap: Map<string, SessionState>,
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void,
  synced = true,
) {
  const state = sessionMap.get(sessionId)
  if (!state) return

  const profile = state.profile
  updateSessionStats(sessionId)
  const emit = (event: string, payload: any) => {
    nsp.to(`session:${sessionId}`).emit(event, { ...payload, session_id: sessionId })
  }
  await calcAndUpdateUsage(sessionId, state, emit)

  state.isWorking = false
  state.isAborting = false
  state.profile = undefined
  state.abortController = undefined
  state.runId = undefined
  state.responseRun = undefined
  state.activeRunMarker = undefined

  // Process queued messages after abort completes
  if (state.queue.length > 0) {
    const next = state.queue.shift()!
    state.isWorking = true
    state.isAborting = false
    state.profile = next.profile || profile
    state.source = next.source
    logger.info('[chat-run-socket][abort] dequeuing queued run for session %s (remaining: %d)', sessionId, state.queue.length)
    replaceState(sessionMap, sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced,
      queue_length: state.queue.length + 1,
    })
    emitToSession(nsp, socket, sessionId, 'abort.completed', {
      event: 'abort.completed',
      run_id: runId,
      synced,
      queue_length: state.queue.length + 1,
    })
    emitToSession(nsp, socket, sessionId, 'run.queued', {
      event: 'run.queued',
      queue_length: state.queue.length,
    })
    state.events = []
    runQueuedItem(socket, sessionId, next, profile || 'default')
    return
  }

  state.events = []
  emitToSession(nsp, socket, sessionId, 'abort.completed', {
    event: 'abort.completed',
    run_id: runId,
    synced,
  })
  logger.info({ sessionId, runId, synced }, '[chat-run-socket][abort] completed')
}

function emitToSession(nsp: ReturnType<Server['of']>, socket: Socket, sessionId: string, event: string, payload: any) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}
