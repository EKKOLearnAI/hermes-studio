import type { Server, Socket } from 'socket.io'
import { addMessage, clearSessionMessages, createSession, getSession, renameSession, updateSessionStats } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import type { AgentBridgeClient } from '../agent-bridge'
import { flushBridgePendingToDb } from './bridge-message'
import { buildDbHistory, estimateSnapshotAwareHistoryUsage, forceCompressBridgeHistory, getOrCreateSession, replaceState } from './compression'
import { handleAbort } from './abort'
import { calcAndUpdateUsage } from './usage'
import type { ContentBlock, QueuedRun, SessionState } from './types'

type CommandName =
  | 'usage'
  | 'status'
  | 'abort'
  | 'queue'
  | 'clear'
  | 'title'
  | 'compress'
  | 'steer'
  | 'destroy'

interface ParsedSessionCommand {
  name: CommandName
  rawName: string
  args: string
}

interface SessionCommandContext {
  nsp: ReturnType<Server['of']>
  socket: Socket
  sessionMap: Map<string, SessionState>
  bridge: AgentBridgeClient
  gatewayManager: any
  profile: string
  model?: string
  instructions?: string
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void
}

const COMMAND_ALIASES: Record<string, CommandName> = {
  usage: 'usage',
  status: 'status',
  abort: 'abort',
  queue: 'queue',
  clear: 'clear',
  title: 'title',
  compress: 'compress',
  steer: 'steer',
  destroy: 'destroy',
  destory: 'destroy',
}

export function parseSessionCommand(input: string | ContentBlock[]): ParsedSessionCommand | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const name = COMMAND_ALIASES[rawName]
  if (!name) return { name: 'status', rawName, args: match[2]?.trim() || '' }
  return { name, rawName, args: match[2]?.trim() || '' }
}

export function isSessionCommand(input: string | ContentBlock[]): boolean {
  return parseSessionCommand(input) !== null
}

export async function handleSessionCommand(
  sessionId: string,
  command: ParsedSessionCommand,
  ctx: SessionCommandContext,
): Promise<void> {
  const state = getOrCreateSession(ctx.sessionMap, sessionId)
  ctx.socket.join(`session:${sessionId}`)
  ensureCommandSession(sessionId, ctx)
  persistCommandMessage(sessionId, state, `/${command.rawName}${command.args ? ` ${command.args}` : ''}`)

  const emitCommand = (payload: Record<string, unknown>) => {
    const message = typeof payload.message === 'string' ? payload.message : ''
    if (message) persistCommandMessage(sessionId, state, message)
    emitToSession(ctx.nsp, ctx.socket, sessionId, 'session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: command.rawName,
      ok: true,
      ...payload,
    })
  }

  if (!COMMAND_ALIASES[command.rawName]) {
    emitCommand({
      ok: false,
      action: 'error',
      terminal: !state.isWorking,
      message: `Unknown bridge command: /${command.rawName}`,
    })
    return
  }

  switch (command.name) {
    case 'usage': {
      const usage = await calcAndUpdateUsage(sessionId, state, (event, payload) => {
        emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
      })
      emitCommand({
        action: 'usage',
        terminal: !state.isWorking,
        message: `Usage: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${usage.inputTokens + usage.outputTokens} tokens.`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      })
      return
    }

    case 'status': {
      const row = getSession(sessionId)
      emitCommand({
        action: 'status',
        terminal: !state.isWorking,
        message: [
          `Status: ${state.isWorking ? 'running' : 'idle'}`,
          `source: ${state.source || row?.source || 'cli'}`,
          `profile: ${state.profile || ctx.profile || row?.profile || 'default'}`,
          `model: ${ctx.model || row?.model || '-'}`,
          `queue: ${state.queue.length}`,
          `run: ${state.runId || state.activeRunMarker || '-'}`,
        ].join(', '),
        isWorking: state.isWorking,
        isAborting: Boolean(state.isAborting),
        queueLength: state.queue.length,
        source: state.source || row?.source || 'cli',
        profile: state.profile || ctx.profile || row?.profile || 'default',
        model: ctx.model || row?.model || null,
        runId: state.runId || state.activeRunMarker || null,
      })
      return
    }

    case 'abort':
      await handleAbort(ctx.nsp, ctx.socket, sessionId, ctx.sessionMap, ctx.bridge, ctx.runQueuedItem)
      emitCommand({ action: 'abort', message: 'Abort requested.' })
      return

    case 'queue': {
      if (!command.args) {
        emitCommand({ ok: false, action: 'queue', terminal: !state.isWorking, message: 'Usage: /queue <message>' })
        return
      }
      if (!state.isWorking) {
        emitCommand({ ok: false, action: 'queue', message: 'Session is idle. Send the message normally instead.' })
        return
      }
      state.queue.push({
        queue_id: `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        input: command.args,
        model: ctx.model,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
      })
      emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
        event: 'run.queued',
        session_id: sessionId,
        queue_length: state.queue.length,
      })
      emitCommand({
        action: 'queue',
        terminal: false,
        message: `Queued message. Queue length: ${state.queue.length}.`,
        queueLength: state.queue.length,
      })
      return
    }

    case 'clear': {
      if (command.args === '--history') {
        if (state.isWorking) {
          emitCommand({
            ok: false,
            action: 'clear',
            terminal: false,
            message: 'Cannot clear history while the bridge run is active. Abort or destroy it first.',
          })
          return
        }
        const deleted = clearSessionMessages(sessionId)
        state.messages = []
        clearTransientRunState(state)
        await calcAndUpdateUsage(sessionId, state, (event, payload) => {
          emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
        })
        emitCommand({
          action: 'clear',
          clearHistory: true,
          message: `Cleared ${deleted} history messages from the database.`,
        })
        return
      }
      emitCommand({
        action: 'clear',
        message: 'Cleared the current display. History in the database was not deleted.',
      })
      return
    }

    case 'title': {
      if (!command.args) {
        emitCommand({ ok: false, action: 'title', terminal: !state.isWorking, message: 'Usage: /title <new title>' })
        return
      }
      const title = command.args.slice(0, 120)
      if (!getSession(sessionId)) {
        createSession({ id: sessionId, profile: ctx.profile, source: 'cli', model: ctx.model, title })
      }
      const updated = renameSession(sessionId, title)
      emitCommand({
        ok: updated,
        action: 'title',
        title,
        message: updated ? `Title updated: ${title}` : 'Session was not found in the database.',
      })
      return
    }

    case 'compress': {
      if (state.isWorking) {
        emitCommand({ ok: false, action: 'compress', terminal: false, message: 'Compression can only run while the session is idle.' })
        return
      }
      clearTransientRunState(state)
      const emit = (event: string, payload: any) => emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
      try {
        const history = await buildDbHistory(sessionId, { excludeLastUser: true })
        const usageEstimate = estimateSnapshotAwareHistoryUsage(sessionId, history)
        emit('compression.started', {
          event: 'compression.started',
          message_count: usageEstimate.messageCount,
          token_count: usageEstimate.tokenCount,
          source: 'command',
        })
        const result = await forceCompressBridgeHistory(
          sessionId,
          ctx.profile,
          [],
          (profile: string) => ctx.gatewayManager.getUpstream(profile),
          (profile: string) => ctx.gatewayManager.getApiKey(profile),
        )
        state.bridgeCompressionResults = state.bridgeCompressionResults || {}
        await calcAndUpdateUsage(sessionId, state, emit)
        emit('compression.completed', {
          event: 'compression.completed',
          compressed: result.compressed,
          llmCompressed: result.llmCompressed,
          totalMessages: result.beforeMessages,
          resultMessages: result.resultMessages,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          summaryTokens: result.summaryTokens,
          verbatimCount: result.verbatimCount,
          compressedStartIndex: result.compressedStartIndex,
          source: 'command',
        })
        emitCommand({
          action: 'compress',
          message: `Compression completed: ${result.beforeMessages} -> ${result.resultMessages} messages, ${result.beforeTokens} -> ${result.afterTokens} tokens.`,
          beforeMessages: result.beforeMessages,
          resultMessages: result.resultMessages,
          beforeTokens: result.beforeTokens,
          afterTokens: result.afterTokens,
          compressed: result.compressed,
        })
      } catch (err) {
        logger.warn(err, '[chat-run-socket] /compress failed for session %s', sessionId)
        emit('compression.completed', {
          event: 'compression.completed',
          compressed: false,
          totalMessages: 0,
          resultMessages: 0,
          beforeTokens: 0,
          afterTokens: 0,
          error: err instanceof Error ? err.message : String(err),
          source: 'command',
        })
        emitCommand({
          ok: false,
          action: 'compress',
          message: `Compression failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }

    case 'steer': {
      if (!command.args) {
        emitCommand({ ok: false, action: 'steer', terminal: !state.isWorking, message: 'Usage: /steer <instruction>' })
        return
      }
      if (!state.isWorking) {
        emitCommand({ ok: false, action: 'steer', message: 'No active bridge run to steer.' })
        return
      }
      await ctx.bridge.steer(sessionId, command.args)
      emitCommand({ action: 'steer', terminal: false, message: 'Steer instruction sent.' })
      return
    }

    case 'destroy': {
      const wasWorking = state.isWorking
      let bridgeReachable = true
      let bridgeError: string | null = null
      try {
        if (wasWorking) {
          flushBridgePendingToDb(state, sessionId)
          await ctx.bridge.interrupt(sessionId, 'Destroyed by user').catch((err) => {
            logger.warn(err, '[chat-run-socket] /destroy interrupt failed for session %s', sessionId)
          })
        }
        await ctx.bridge.destroy(sessionId).catch((err) => {
          bridgeReachable = false
          bridgeError = err instanceof Error ? err.message : String(err)
          logger.warn(err, '[chat-run-socket] /destroy bridge unavailable for session %s', sessionId)
        })
      } finally {
        updateSessionStats(sessionId)
        await calcAndUpdateUsage(sessionId, state, (event, payload) => {
          emitToSession(ctx.nsp, ctx.socket, sessionId, event, payload)
        })
        state.isWorking = false
        state.isAborting = false
        state.profile = undefined
        state.abortController = undefined
        state.runId = undefined
        state.responseRun = undefined
        state.activeRunMarker = undefined
        state.events = []
        state.queue = []
        state.bridgePendingAssistantContent = undefined
        state.bridgePendingReasoningContent = undefined
        state.bridgeOutput = undefined
        state.bridgePendingTools = undefined
        state.bridgeCompressionResults = undefined
        replaceState(ctx.sessionMap, sessionId, 'session.command', {
          event: 'session.command',
          action: 'destroy',
        })
      }
      emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
        event: 'run.queued',
        session_id: sessionId,
        queue_length: 0,
      })
      emitCommand({
        action: 'destroy',
        message: bridgeReachable
          ? (wasWorking ? 'Destroyed bridge agent and stopped the active run.' : 'Destroyed bridge agent.')
          : `Bridge agent was not reachable; cleared local session state.${bridgeError ? ` (${bridgeError})` : ''}`,
        destroyed: true,
        bridgeReachable,
      })
      return
    }
  }
}

function clearTransientRunState(state: SessionState) {
  state.events = []
  state.bridgePendingTools = undefined
  state.bridgeCompressionResults = undefined
  state.responseRun = undefined
  state.activeRunMarker = undefined
  state.runId = undefined
  state.abortController = undefined
  state.isAborting = false
}

function ensureCommandSession(sessionId: string, ctx: SessionCommandContext) {
  if (getSession(sessionId)) return
  createSession({
    id: sessionId,
    profile: ctx.profile,
    source: 'cli',
    model: ctx.model,
    title: 'Bridge command',
  })
}

function persistCommandMessage(sessionId: string, state: SessionState, content: string) {
  const now = Math.floor(Date.now() / 1000)
  const id = addMessage({
    session_id: sessionId,
    role: 'command',
    content,
    timestamp: now,
  })
  state.messages.push({
    id: id || `command_${now}_${state.messages.length}`,
    session_id: sessionId,
    role: 'command',
    content,
    timestamp: now,
  })
  updateSessionStats(sessionId)
}

function emitToSession(nsp: ReturnType<Server['of']>, socket: Socket, sessionId: string, event: string, payload: any) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}
