import type { Server, Socket } from 'socket.io'
import { codingAgentRunManager } from '../../agent-runner/coding-agent-run-manager'
import {
  sendCodingAgentRunInput,
  startCodingAgentRun,
  type CodingAgentId,
} from '../../coding-agents'
import { getOrCreateSession } from './compression'
import { contentBlocksToString } from './content-blocks'
import type { ContentBlock, SessionState } from './types'
import { writeModelRunProfileToken } from './model-run-prompt'
import type { AuthenticatedUser } from '../../../middleware/user-auth'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getSession } from '../../../db/hermes/session-store'

export interface CodingAgentRunSocketData {
  input: string | ContentBlock[]
  session_id?: string
  profile?: string
  provider?: string
  model?: string
  coding_agent_id?: CodingAgentId
  agent_id?: CodingAgentId
  mode?: 'scoped' | 'global'
  workspace?: string | null
  source?: string
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: any
  api_mode?: any
  session_source?: 'global_agent' | 'workflow'
}

function codingAgentId(data: CodingAgentRunSocketData): CodingAgentId {
  const value = data.coding_agent_id || data.agent_id || 'claude-code'
  return value === 'codex' ? 'codex' : 'claude-code'
}

export async function handleCodingAgentRun(
  nsp: ReturnType<Server['of']>,
  socket: Socket,
  data: CodingAgentRunSocketData,
  profile: string,
  sessionMap: Map<string, SessionState>,
) {
  const sessionId = String(data.session_id || '').trim()
  if (!sessionId) {
    socket.emit('run.failed', { event: 'run.failed', error: 'session_id is required for coding agent runs' })
    return
  }

  socket.join(`session:${sessionId}`)
  const agentId = codingAgentId(data)
  const state = getOrCreateSession(sessionMap, sessionId)
  state.profile = profile
  state.source = data.session_source === 'workflow' || data.source === 'workflow' ? 'workflow' : 'coding_agent'

  let runId = codingAgentRunManager.runIdForSession(sessionId)
  const mode = data.mode === 'global' ? 'global' : 'scoped'
  const storedSession = getSession(sessionId)
  const launchProvider = data.provider || (mode === 'scoped' ? storedSession?.provider || undefined : undefined)
  const launchModel = data.model || (mode === 'scoped' ? storedSession?.model || undefined : undefined)
  if (runId && !codingAgentRunManager.isSessionLaunchCompatible(sessionId, {
    agentId,
    mode,
    provider: launchProvider,
    model: launchModel,
  })) {
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
    runId = undefined
  }
  if (!runId) {
    const started = await startCodingAgentRun(agentId, {
      sessionId,
      mode,
      profile,
      provider: launchProvider,
      model: launchModel,
      workspace: data.workspace,
      baseUrl: data.baseUrl || data.base_url,
      apiKey: data.apiKey || data.api_key,
      apiMode: data.apiMode || data.api_mode,
      sessionSource: data.session_source,
    }, state)
    runId = started.agentSessionId
  }

  state.isWorking = true
  state.runId = runId

  try {
    const inputText = contentBlocksToString(data.input)
    const socketUser = socket.data?.user as AuthenticatedUser | undefined
    await writeModelRunProfileToken(socketUser, profile)
    const includeBaseSystemPrompt = agentId === 'claude-code' || agentId === 'codex'
    const runPrompt = [
      includeBaseSystemPrompt ? getSystemPrompt(undefined, { source: data.session_source || data.source }) : '',
    ].filter(Boolean).join('\n')
    await sendCodingAgentRunInput(sessionId, inputText, runPrompt)
  } catch (err) {
    if (!codingAgentRunManager.isSessionProcessing(sessionId)) {
      state.isWorking = false
      state.isAborting = false
      state.runId = undefined
      state.abortController = undefined
      state.activeRunMarker = undefined
      state.events = []
      state.responseRun = undefined
    }
    throw err
  }
}
