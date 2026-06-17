import type { Server, Socket } from 'socket.io'
import { addMessage, clearSessionMessages, createSession, getSession, renameSession, updateSessionStats } from '../../../db/hermes/session-store'
import { logger } from '../../logger'
import type { AgentBridgeClient } from '../agent-bridge'
import { flushBridgePendingToDb } from './bridge-message'
import { buildDbHistory, estimateSnapshotAwareHistoryUsage, forceCompressBridgeHistory, getOrCreateSession, replaceState } from './compression'
import { handleAbort } from './abort'
import { calcAndUpdateUsage, contextTokensWithCachedOverhead, updateMessageContextTokenUsage } from './usage'
import { contentBlocksToString } from './content-blocks'
import type { ContentBlock, QueuedRun, SessionState } from './types'

type CommandName =
  | 'usage'
  | 'status'
  | 'abort'
  | 'queue'
  | 'skill'
  | 'plan'
  | 'goal'
  | 'subgoal'
  | 'clear'
  | 'title'
  | 'compress'
  | 'steer'
  | 'destroy'
  | 'reload-mcp'
  | 'reload-skills'

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
  profile: string
  model?: string
  provider?: string
  model_groups?: Array<{ provider: string; models: string[] }>
  instructions?: string
  queueId?: string
  runQueuedItem: (socket: Socket, sessionId: string, next: QueuedRun, fallbackProfile?: string) => void
}

const COMMAND_ALIASES: Record<string, CommandName> = {
  usage: 'usage',
  status: 'status',
  abort: 'abort',
  queue: 'queue',
  skill: 'skill',
  plan: 'plan',
  goal: 'goal',
  subgoal: 'subgoal',
  clear: 'clear',
  title: 'title',
  compress: 'compress',
  steer: 'steer',
  destroy: 'destroy',
  'reload-mcp': 'reload-mcp',
  'reload-skills': 'reload-skills',
  reload_skills: 'reload-skills',
}

export function parseSessionCommand(input: string | ContentBlock[]): ParsedSessionCommand | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const name = COMMAND_ALIASES[rawName]
  if (!name) return null
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
  ensureCommandSession(sessionId, command, ctx)
  if (command.name !== 'plan' && command.name !== 'skill') {
    persistCommandMessage(sessionId, state, `/${command.rawName}${command.args ? ` ${command.args}` : ''}`)
  }

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

  if (command.name === 'skill') {
    const displayCommand = `/${command.rawName}${command.args ? ` ${command.args}` : ''}`
    const skillParts = command.args.split(/\s+/, 2)
    const skillName = skillParts[0]?.trim()
    if (!skillName) {
      emitCommand({
        ok: false,
        action: 'skill',
        terminal: !state.isWorking,
        message: 'Usage: /skill <skill-name> [instructions]',
      })
      return
    }
    const rest = command.args.slice(skillName.length).trim()
    const bridgeCommand = `/${skillName}${rest ? ` ${rest}` : ''}`
    let result
    try {
      result = await ctx.bridge.command(sessionId, bridgeCommand, ctx.profile)
    } catch (err) {
      if (state.isWorking) emitQueuedState(ctx, sessionId, state)
      emitCommand({
        ok: false,
        action: 'skill',
        terminal: !state.isWorking,
        message: `Skill command failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }

    const expandedPrompt = typeof result.message === 'string' ? result.message.trim() : ''
    if (result.handled && expandedPrompt && (result.type === 'skill' || result.type === 'bundle')) {
      logger.info(
        '[chat-run-socket] /skill resolved session=%s profile=%s skill=%s bridge_type=%s',
        sessionId,
        ctx.profile,
        skillName,
        result.type,
      )
      logger.info(
        '[chat-run-socket] /skill expanded prompt session=%s profile=%s skill=%s chars=%d expanded_prompt=%s',
        sessionId,
        ctx.profile,
        skillName,
        expandedPrompt.length,
        expandedPrompt,
      )
      const next: QueuedRun = {
        queue_id: ctx.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        input: expandedPrompt,
        displayInput: displayCommand,
        displayRole: 'command',
        storageMessage: expandedPrompt,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      }

      if (state.isWorking) {
        state.queue.push(next)
        emitQueuedState(ctx, sessionId, state)
        return
      }

      emitCommand({
        action: result.type === 'bundle' ? 'bundle' : 'skill',
        terminal: false,
        started: true,
      })
      ctx.runQueuedItem(ctx.socket, sessionId, next, ctx.profile)
      return
    }

    logger.warn(
      '[chat-run-socket] /skill unresolved session=%s profile=%s skill=%s bridge_type=%s message=%s',
      sessionId,
      ctx.profile,
      skillName,
      typeof result.type === 'string' ? result.type : '',
      typeof result.message === 'string' ? result.message : '',
    )
    if (state.isWorking) emitQueuedState(ctx, sessionId, state)
    emitCommand({
      ok: false,
      action: 'error',
      terminal: !state.isWorking,
      message: result?.message || `Unknown bridge command: /${command.rawName}`,
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
      const bridgeStatus = await getBridgeSessionStatus(ctx, sessionId)
      const bridgeRunning = bridgeStatus?.running === true
      const isWorking = state.isWorking || bridgeRunning
      const runId = state.runId || state.activeRunMarker || bridgeStatus?.currentRunId || null
      emitCommand({
        action: 'status',
        terminal: !isWorking,
        message: [
          `Status: ${isWorking ? 'running' : 'idle'}`,
          `source: ${state.source || row?.source || 'cli'}`,
          `profile: ${state.profile || ctx.profile || row?.profile || 'default'}`,
          `model: ${ctx.model || row?.model || '-'}`,
          `queue: ${state.queue.length}`,
          `run: ${runId || '-'}`,
          bridgeStatus ? `bridge: ${bridgeRunning ? 'running' : 'idle'}` : null,
        ].filter(Boolean).join(', '),
        isWorking,
        isAborting: Boolean(state.isAborting),
        queueLength: state.queue.length,
        source: state.source || row?.source || 'cli',
        profile: state.profile || ctx.profile || row?.profile || 'default',
        model: ctx.model || row?.model || null,
        runId,
        bridgeStatus,
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
      const queueId = `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      state.queue.push({
        queue_id: queueId,
        input: command.args,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      })
      emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
        event: 'run.queued',
        session_id: sessionId,
        queue_length: state.queue.length,
        queued_messages: serializeVisibleQueuedMessages(state.queue),
      })
      emitCommand({
        action: 'queue',
        terminal: false,
        message: `Queued message. Queue length: ${state.queue.length}.`,
        queueLength: state.queue.length,
      })
      return
    }

    case 'plan': {
      const bridgeCommand = `plan${command.args ? ` ${command.args}` : ''}`
      let result
      try {
        result = await ctx.bridge.command(sessionId, bridgeCommand, ctx.profile)
      } catch (err) {
        emitCommand({
          ok: false,
          action: 'plan',
          terminal: !state.isWorking,
          message: `Plan command failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      if (!result.handled || !result.message) {
        emitCommand({
          ok: false,
          action: 'plan',
          terminal: !state.isWorking,
          message: result.message || 'Plan command is not available.',
        })
        return
      }

      const queueId = ctx.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
      const displayCommand = `/${bridgeCommand}`
      const next: QueuedRun = {
        queue_id: queueId,
        input: result.message,
        displayInput: displayCommand,
        displayRole: 'command',
        storageMessage: displayCommand,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      }

      if (state.isWorking) {
        state.queue.push(next)
        emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
          event: 'run.queued',
          session_id: sessionId,
          queue_length: state.queue.length,
          queued_messages: serializeVisibleQueuedMessages(state.queue),
        })
        return
      }

      emitCommand({
        action: 'plan',
        terminal: false,
        started: true,
      })
      ctx.runQueuedItem(ctx.socket, sessionId, next, ctx.profile)
      return
    }

    case 'goal':
    case 'subgoal': {
      const isGoalSet = command.name === 'goal'
        && Boolean(command.args)
        && !['status', 'pause', 'resume', 'clear', 'stop', 'done'].includes(command.args.toLowerCase())
      if (state.isWorking && isGoalSet) {
        emitCommand({
          ok: false,
          action: 'goal',
          terminal: false,
          message: 'Agent is running. Use /goal status, /goal pause, or /goal clear mid-run, or /abort before setting a new goal.',
        })
        return
      }

      const bridgeCommand = `${command.name}${command.args ? ` ${command.args}` : ''}`
      let result
      try {
        result = await ctx.bridge.command(sessionId, bridgeCommand, ctx.profile)
      } catch (err) {
        emitCommand({
          ok: false,
          action: command.name,
          terminal: !state.isWorking,
          message: `Goal command failed: ${err instanceof Error ? err.message : String(err)}`,
        })
        return
      }

      if (result.clear_goal_continuations) {
        const removed = removeGoalContinuationRuns(state)
        if (removed > 0) emitQueuedState(ctx, sessionId, state)
      }

      const kickoffPrompt = typeof result.kickoff_prompt === 'string' ? result.kickoff_prompt.trim() : ''

      const bridgeStatus = result.action === 'goal_status' || result.action === 'status'
        ? await getBridgeSessionStatus(ctx, sessionId)
        : null
      const message = formatGoalStatusMessage(String(result.message || ''), bridgeStatus)

      const resultAction = String(result.action || command.name)
      const action = (command.name === 'goal' || command.name === 'subgoal') && resultAction === 'clear'
        ? `${command.name}_clear`
        : resultAction

      emitCommand({
        action,
        terminal: !state.isWorking && !kickoffPrompt,
        started: Boolean(kickoffPrompt),
        message,
        type: result.type || 'goal',
        maxTurns: result.max_turns,
        bridgeStatus,
      })

      if (!kickoffPrompt) return

      const next: QueuedRun = {
        queue_id: ctx.queueId || `queue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        input: kickoffPrompt,
        displayInput: null,
        storageMessage: kickoffPrompt,
        model: ctx.model,
        provider: ctx.provider,
        model_groups: ctx.model_groups,
        instructions: ctx.instructions,
        profile: ctx.profile,
        source: 'cli',
        originSocketId: ctx.socket.id,
      }

      if (state.isWorking) {
        state.queue.push(next)
        emitQueuedState(ctx, sessionId, state)
        return
      }

      ctx.runQueuedItem(ctx.socket, sessionId, next, ctx.profile)
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
        const beforeContextTokens = contextTokensWithCachedOverhead(state, usageEstimate.tokenCount)
        emit('compression.started', {
          event: 'compression.started',
          message_count: usageEstimate.messageCount,
          token_count: beforeContextTokens,
          source: 'command',
        })
        const result = await forceCompressBridgeHistory(
          sessionId,
          ctx.profile,
          [],
        )
        state.bridgeCompressionResults = state.bridgeCompressionResults || {}
        const usage = await calcAndUpdateUsage(sessionId, state, emit)
        const afterContextTokens = contextTokensWithCachedOverhead(state, result.afterTokens)
        emit('compression.completed', {
          event: 'compression.completed',
          compressed: result.compressed,
          llmCompressed: result.llmCompressed,
          totalMessages: result.beforeMessages,
          resultMessages: result.resultMessages,
          beforeTokens: beforeContextTokens,
          afterTokens: result.afterTokens,
          summaryTokens: result.summaryTokens,
          verbatimCount: result.verbatimCount,
          compressedStartIndex: result.compressedStartIndex,
          contextTokens: afterContextTokens,
          source: 'command',
        })
        updateMessageContextTokenUsage(sessionId, state, emit, result.afterTokens, usage)
        emitCommand({
          action: 'compress',
          message: `Compression completed: ${result.beforeMessages} -> ${result.resultMessages} messages, ${beforeContextTokens} -> ${afterContextTokens} tokens.`,
          beforeMessages: result.beforeMessages,
          resultMessages: result.resultMessages,
          beforeTokens: beforeContextTokens,
          afterTokens: afterContextTokens,
          messageBeforeTokens: result.beforeTokens,
          messageAfterTokens: result.afterTokens,
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

    case 'reload-mcp': {
      if (state.isWorking) {
        emitCommand({
          ok: false,
          action: 'reload-mcp',
          terminal: false,
          message: 'MCP reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
        })
        return
      }
      try {
        const server = command.args || undefined
        const result = await ctx.bridge.mcpReload(server, ctx.profile)
        emitCommand({
          action: 'reload-mcp',
          message: `MCP reloaded successfully.${server ? ` Server: ${server}` : ' All servers.'}`,
          result,
        })
      } catch (err) {
        emitCommand({
          ok: false,
          action: 'reload-mcp',
          terminal: !state.isWorking,
          message: `MCP reload failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }

    case 'reload-skills': {
      if (state.isWorking) {
        emitCommand({
          ok: false,
          action: 'reload-skills',
          terminal: false,
          message: 'Skills reload can only run while the session is idle. Wait for the current run to finish or abort it first.',
        })
        return
      }
      try {
        const result = await reloadSkillsThroughBridge(ctx, sessionId)
        emitCommand({
          action: 'reload-skills',
          message: formatReloadSkillsMessage(result),
          result,
        })
      } catch (err) {
        emitCommand({
          ok: false,
          action: 'reload-skills',
          terminal: !state.isWorking,
          message: `Skills reload failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
      return
    }

    case 'destroy': {
      const wasWorking = state.isWorking
      let bridgeReachable = true
      let bridgeError: string | null = null
      try {
        if (wasWorking) {
          flushBridgePendingToDb(state, sessionId)
          await ctx.bridge.interrupt(sessionId, 'Destroyed by user', state.profile).catch((err) => {
            logger.warn(err, '[chat-run-socket] /destroy interrupt failed for session %s', sessionId)
          })
        }
        await ctx.bridge.destroy(sessionId, state.profile).catch((err) => {
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
        state.bridgePendingToolCallMarkup = undefined
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
  state.bridgePendingToolCallMarkup = undefined
  state.bridgeCompressionResults = undefined
  state.responseRun = undefined
  state.activeRunMarker = undefined
  state.runId = undefined
  state.abortController = undefined
  state.isAborting = false
}

function removeGoalContinuationRuns(state: SessionState): number {
  const before = state.queue.length
  state.queue = state.queue.filter(item => !item.goalContinuation)
  return before - state.queue.length
}

function emitQueuedState(ctx: SessionCommandContext, sessionId: string, state: SessionState) {
  emitToSession(ctx.nsp, ctx.socket, sessionId, 'run.queued', {
    event: 'run.queued',
    session_id: sessionId,
    queue_length: state.queue.length,
    queued_messages: serializeVisibleQueuedMessages(state.queue),
  })
}

function serializeVisibleQueuedMessages(queue: QueuedRun[]) {
  return queue.filter(item => item.displayInput !== null).map(item => ({
    id: item.queue_id,
    role: item.displayRole || (typeof item.displayInput === 'string' && item.displayInput.trim().startsWith('/') ? 'command' : 'user'),
    content: contentBlocksToString(item.displayInput ?? item.input),
    timestamp: Math.floor(Date.now() / 1000),
    queued: true,
  }))
}

type BridgeSessionStatus = {
  exists: boolean
  running: boolean
  currentRunId: string | null
  messageCount: number
}

async function getBridgeSessionStatus(ctx: SessionCommandContext, sessionId: string): Promise<BridgeSessionStatus | null> {
  try {
    const raw = await ctx.bridge.status(sessionId, ctx.profile) as Record<string, unknown>
    return {
      exists: raw.exists === true,
      running: raw.running === true,
      currentRunId: typeof raw.current_run_id === 'string' && raw.current_run_id.trim()
        ? raw.current_run_id
        : null,
      messageCount: typeof raw.message_count === 'number' && Number.isFinite(raw.message_count)
        ? raw.message_count
        : 0,
    }
  } catch (err) {
    logger.debug({ err, sessionId }, '[chat-run-socket] bridge status lookup failed')
    return null
  }
}

function formatGoalStatusMessage(message: string, bridgeStatus: BridgeSessionStatus | null): string {
  if (!bridgeStatus) return message
  const lines = [message]
  if (bridgeStatus.running) {
    const progress = parseGoalTurnProgress(message)
    lines.push(progress
      ? `Current turn: ${Math.min(progress.used + 1, progress.max)}/${progress.max} running (completed turns: ${progress.used}/${progress.max}; count updates after the judge).`
      : 'Current turn: running (turn count updates after the judge).')
  }
  lines.push(`Run: ${bridgeStatus.running ? 'running' : 'idle'}${bridgeStatus.currentRunId ? ` (${bridgeStatus.currentRunId})` : ''}`)
  return lines.filter(Boolean).join('\n')
}

function parseGoalTurnProgress(message: string): { used: number; max: number } | null {
  const match = message.match(/\b(\d+)\s*\/\s*(\d+)\s+turns\b/i)
  if (!match) return null
  const used = Number(match[1])
  const max = Number(match[2])
  if (!Number.isFinite(used) || !Number.isFinite(max) || max <= 0) return null
  return { used, max }
}

async function reloadSkillsThroughBridge(
  ctx: SessionCommandContext,
  sessionId: string,
): Promise<Record<string, unknown>> {
  try {
    return await ctx.bridge.reloadSkills(ctx.profile)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes('unknown action: skills_reload')) throw err
  }

  const result = await ctx.bridge.command(sessionId, 'reload-skills', ctx.profile)
  if (result.handled && result.action === 'reload-skills') return result
  throw new Error(
    'The running Agent Bridge does not support /reload-skills yet. Restart the bridge and try again.',
  )
}

function formatReloadSkillsMessage(result: Record<string, unknown>): string {
  const added = Array.isArray(result.added) ? result.added : []
  const removed = Array.isArray(result.removed) ? result.removed : []
  const total = typeof result.total === 'number' && Number.isFinite(result.total)
    ? result.total
    : null
  const lines = ['Skills reloaded successfully.']
  if (!added.length && !removed.length) {
    lines.push(total === null ? 'No skill changes detected.' : `No skill changes detected. Total skills: ${total}.`)
    return lines.join('\n')
  }
  if (added.length) {
    lines.push('Added skills:')
    for (const item of added) lines.push(`- ${formatReloadSkillItem(item)}`)
  }
  if (removed.length) {
    lines.push('Removed skills:')
    for (const item of removed) lines.push(`- ${formatReloadSkillItem(item)}`)
  }
  if (total !== null) lines.push(`Total skills: ${total}.`)
  return lines.join('\n')
}

function formatReloadSkillItem(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item || '')
  const record = item as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const description = typeof record.description === 'string' ? record.description : ''
  return description ? `${name}: ${description}` : name
}

function ensureCommandSession(sessionId: string, command: ParsedSessionCommand, ctx: SessionCommandContext) {
  if (getSession(sessionId)) return
  createSession({
    id: sessionId,
    profile: ctx.profile,
    source: 'cli',
    model: ctx.model,
    title: buildCommandSessionTitle(command),
  })
}

function buildCommandSessionTitle(command: ParsedSessionCommand): string {
  const prefix = `[${command.rawName}]`
  const args = command.args.replace(/\s+/g, ' ').trim()
  return args ? `${prefix} ${args}`.slice(0, 120) : prefix
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
