import type { Server, Socket } from 'socket.io'
import { addMessage, getSession, updateSessionStats } from '../../db/hermes/session-store'
import { getModelContextLength } from '../hermes/model-context'
import { forceCompressBridgeHistory, getOrCreateSession } from '../hermes/run-chat/compression'
import { calcAndUpdateUsage } from '../hermes/run-chat/usage'
import type { SessionState } from '../hermes/run-chat/types'
import { codingAgentRunManager } from './runtime/run-manager'

export type CodingAgentCommandName = 'context' | 'compact' | 'usage' | 'status'

export interface ParsedCodingAgentCommand {
  name: CodingAgentCommandName
  rawName: string
  args: string
}

const CODING_AGENT_COMMAND_ALIASES: Record<string, CodingAgentCommandName> = {
  context: 'context',
  compact: 'compact',
  usage: 'usage',
  status: 'status',
}

export function parseCodingAgentSessionCommand(input: string): ParsedCodingAgentCommand | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const match = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const rawName = match[1].toLowerCase()
  const name = CODING_AGENT_COMMAND_ALIASES[rawName]
  if (!name) return null
  return { name, rawName, args: match[2]?.trim() || '' }
}

export function isCodingAgentSessionCommand(input: string): boolean {
  return parseCodingAgentSessionCommand(input) !== null
}

export interface CodingAgentSessionCommandData {
  session_id?: string
  model?: string
  provider?: string
  mode?: 'scoped' | 'global'
}

export async function handleCodingAgentSessionCommand(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: CodingAgentSessionCommandData,
  command: ParsedCodingAgentCommand,
  profile: string,
  sessionMap: Map<string, SessionState>,
): Promise<void> {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) return
  socket.join(`session:${sessionId}`)
  const state = getOrCreateSession(sessionMap, sessionId)
  const displayCommand = `/${command.rawName}${command.args ? ` ${command.args}` : ''}`
  persistCommandMessage(sessionId, state, displayCommand)

  const emit = (event: string, payload: Record<string, unknown>) => {
    emitToSession(nsp, socket, sessionId, event, { ...payload })
  }

  const emitCommand = (payload: Record<string, unknown>) => {
    emitToSession(nsp, socket, sessionId, 'session.command', {
      event: 'session.command',
      session_id: sessionId,
      command: command.rawName,
      ok: true,
      ...payload,
    })
  }

  if (command.name === 'context' || command.name === 'usage') {
    try {
      const usage = await calcAndUpdateUsage(sessionId, state, (event, payload) => {
        emit(event, payload)
      }, { nativeSource: 'coding_agent' })
      const row = getSession(sessionId)
      const contextWindow = getModelContextLength({
        profile,
        model: data.model || row?.model || undefined,
        provider: data.provider || row?.provider || undefined,
      })
      const totalTokens = usage.inputTokens + usage.outputTokens
      const percent = contextWindow > 0 ? Math.round((totalTokens / contextWindow) * 1000) / 10 : 0
      emitCommand({
        action: command.name,
        terminal: !state.isWorking,
        message: command.name === 'context'
          ? `Context: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${totalTokens} / ${contextWindow} tokens (${percent}%).`
          : `Usage: input ${usage.inputTokens}, output ${usage.outputTokens}, total ${totalTokens} tokens.`,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens,
        contextWindow,
        contextPercent: percent,
      })
    } catch (err) {
      emitCommand({
        ok: false,
        action: command.name,
        terminal: !state.isWorking,
        message: `${command.name === 'context' ? 'Context' : 'Usage'} lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
    return
  }

  if (command.name === 'status') {
    const row = getSession(sessionId)
    const info = codingAgentRunManager.getRunInfo(sessionId)
    const running = Boolean(info?.running)
    const agent = row?.agent || info?.agentId || '-'
    const model = row?.model || info?.model || data.model || '-'
    const provider = row?.provider || info?.provider || data.provider || '-'
    emitCommand({
      action: 'status',
      terminal: !running,
      message: [
        `Status: ${running ? 'running' : 'idle'}`,
        `agent: ${agent}`,
        `provider: ${provider}`,
        `model: ${model}`,
        `native session: ${info?.nativeSessionId || row?.agent_native_session_id || '-'}`,
      ].join(', '),
      isWorking: running,
      agent,
      model,
      provider,
      nativeSessionId: info?.nativeSessionId || row?.agent_native_session_id || null,
    })
    return
  }

  if (command.name === 'compact') {
    try {
      const result = await codingAgentRunManager.compact(sessionId, command.args)
      if ('started' in result) {
        emitCommand({
          action: 'compact',
          terminal: false,
          started: true,
          message: 'Native /compact sent to Claude Code.',
        })
        return
      }
      emitCommand({
        action: 'compact',
        terminal: true,
        message: result.compacted
          ? `Compaction completed.${result.summary ? `\n\n${result.summary}` : ''}`
          : 'Compaction completed without changes.',
        compacted: result.compacted,
      })
    } catch (err) {
      try {
        const fallback = await compressStudioTranscript(sessionId, profile)
        emitCommand({
          action: 'compact',
          terminal: true,
          message: `Native compact unavailable (${err instanceof Error ? err.message : String(err)}); Studio compressed its transcript: ${fallback.beforeMessages} -> ${fallback.resultMessages} messages, ${fallback.beforeTokens} -> ${fallback.afterTokens} tokens.`,
          compacted: fallback.compressed,
          nativeCompactError: err instanceof Error ? err.message : String(err),
          beforeMessages: fallback.beforeMessages,
          resultMessages: fallback.resultMessages,
          beforeTokens: fallback.beforeTokens,
          afterTokens: fallback.afterTokens,
        })
      } catch (fallbackErr) {
        emitCommand({
          ok: false,
          action: 'compact',
          terminal: true,
          message: `Compaction failed: ${err instanceof Error ? err.message : String(err)}; Studio fallback also failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
        })
      }
    }
    return
  }
}

async function compressStudioTranscript(
  sessionId: string,
  profile: string,
): Promise<{
  beforeMessages: number
  resultMessages: number
  beforeTokens: number
  afterTokens: number
  compressed: boolean
}> {
  const result = await forceCompressBridgeHistory(sessionId, profile, [])
  return {
    beforeMessages: result.beforeMessages,
    resultMessages: result.resultMessages,
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    compressed: result.compressed,
  }
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

function emitToSession(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  sessionId: string,
  event: string,
  payload: Record<string, unknown>,
) {
  const tagged = { ...payload, session_id: sessionId }
  nsp.to(`session:${sessionId}`).emit(event, tagged)
  if (!nsp.adapter.rooms.get(`session:${sessionId}`)?.size && socket.connected) {
    socket.emit(event, tagged)
  }
}
