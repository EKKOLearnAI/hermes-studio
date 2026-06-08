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
  baseUrl?: string
  base_url?: string
  apiKey?: string
  api_key?: string
  apiMode?: any
  api_mode?: any
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
  state.source = 'coding_agent'

  let runId = codingAgentRunManager.runIdForSession(sessionId)
  const mode = data.mode === 'global' ? 'global' : 'scoped'
  if (runId && !codingAgentRunManager.isSessionLaunchCompatible(sessionId, {
    agentId,
    mode,
    provider: data.provider,
    model: data.model,
  })) {
    codingAgentRunManager.stop(sessionId, { reportClosed: false })
    runId = undefined
  }
  if (!runId) {
    const started = await startCodingAgentRun(agentId, {
      sessionId,
      mode,
      profile,
      provider: data.provider,
      model: data.model,
      workspace: data.workspace,
      baseUrl: data.baseUrl || data.base_url,
      apiKey: data.apiKey || data.api_key,
      apiMode: data.apiMode || data.api_mode,
    }, state)
    runId = started.agentSessionId
  }

  state.isWorking = true
  state.runId = runId

  try {
    await sendCodingAgentRunInput(sessionId, contentBlocksToString(data.input))
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
