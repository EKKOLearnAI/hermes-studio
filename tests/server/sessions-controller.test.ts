import { beforeEach, describe, expect, it, vi } from 'vitest'

const listConversationSummariesFromDbMock = vi.fn()
const getConversationDetailFromDbMock = vi.fn()
const listConversationSummariesMock = vi.fn()
const getConversationDetailMock = vi.fn()
const listSessionSummariesMock = vi.fn()
const getSessionDetailFromDbMock = vi.fn()
const getSessionDetailFromDbWithProfileMock = vi.fn()
const getExactSessionDetailFromDbWithProfileMock = vi.fn()
const getUsageStatsFromDbMock = vi.fn()
const getSessionMock = vi.fn()
const deleteHermesSessionForProfileMock = vi.fn()
const localListSessionsMock = vi.fn()
const localGetSessionDetailMock = vi.fn()
const localSearchSessionsMock = vi.fn()
const localDeleteSessionMock = vi.fn()
const localRenameSessionMock = vi.fn()
const localCreateSessionMock = vi.fn()
const localUpdateSessionMock = vi.fn()
const localAddMessagesMock = vi.fn()
const localUpdateSessionStatsMock = vi.fn()
const getGroupChatServerMock = vi.fn()
const getLocalUsageStatsMock = vi.fn()
const getActiveProfileNameMock = vi.fn()
const loggerWarnMock = vi.fn()
const getCompressionSnapshotMock = vi.fn()
const listUserProfilesMock = vi.fn()
const readConfigYamlForProfileMock = vi.fn()
const bridgeSwitchSessionModelMock = vi.fn()
const bridgeGetRuntimeStateMock = vi.fn()
const codingAgentRunManagerMock = vi.hoisted(() => ({
  stop: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/conversations-db', () => ({
  listConversationSummariesFromDb: listConversationSummariesFromDbMock,
  getConversationDetailFromDb: getConversationDetailFromDbMock,
}))

vi.mock('../../packages/server/src/services/hermes/conversations', () => ({
  listConversationSummaries: listConversationSummariesMock,
  getConversationDetail: getConversationDetailMock,
}))

vi.mock('../../packages/server/src/services/logger', () => ({
  logger: {
    warn: loggerWarnMock,
    error: vi.fn(),
  },
}))

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  listSessions: vi.fn(),
  getSession: getSessionMock,
  deleteSession: vi.fn(),
  deleteSessionForProfile: deleteHermesSessionForProfileMock,
  renameSession: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  listSessionSummaries: listSessionSummariesMock,
  searchSessionSummaries: vi.fn(),
  getSessionDetailFromDb: getSessionDetailFromDbMock,
  getSessionDetailFromDbWithProfile: getSessionDetailFromDbWithProfileMock,
  getExactSessionDetailFromDbWithProfile: getExactSessionDetailFromDbWithProfileMock,
  getUsageStatsFromDb: getUsageStatsFromDbMock,
}))

vi.mock('../../packages/server/src/db/hermes/session-store', () => ({
  listSessions: localListSessionsMock,
  searchSessions: localSearchSessionsMock,
  getSessionDetail: localGetSessionDetailMock,
  deleteSession: localDeleteSessionMock,
  renameSession: localRenameSessionMock,
  createSession: localCreateSessionMock,
  addMessages: localAddMessagesMock,
  getSession: getSessionMock,
  updateSession: localUpdateSessionMock,
  updateSessionStats: localUpdateSessionStatsMock,
}))

vi.mock('../../packages/server/src/db/hermes/users-store', () => ({
  listUserProfiles: listUserProfilesMock,
}))

vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
  deleteUsage: vi.fn(),
  getUsage: vi.fn(),
  getUsageBatch: vi.fn(),
  getLocalUsageStats: getLocalUsageStatsMock,
}))

vi.mock('../../packages/server/src/routes/hermes/group-chat', () => ({
  getGroupChatServer: getGroupChatServerMock,
}))

vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
  getModelContextLength: vi.fn(),
}))

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: getActiveProfileNameMock,
  getProfileDir: (name: string) => `/tmp/hermes-test/${name || 'default'}`,
  listProfileNamesFromDisk: () => ['default', 'travel'],
}))

vi.mock('../../packages/server/src/services/hermes/agent-bridge', () => ({
  AgentBridgeClient: vi.fn().mockImplementation(() => ({
    switchSessionModel: bridgeSwitchSessionModelMock,
  })),
  getAgentBridgeManager: vi.fn(() => ({
    getRuntimeState: bridgeGetRuntimeStateMock,
  })),
}))

vi.mock('../../packages/server/src/services/config-helpers', () => ({
  readConfigYamlForProfile: readConfigYamlForProfileMock,
}))

vi.mock('../../packages/server/src/services/agent-runner/coding-agent-run-manager', () => ({
  codingAgentRunManager: codingAgentRunManagerMock,
}))

vi.mock('../../packages/server/src/db/hermes/compression-snapshot', () => ({
  getCompressionSnapshot: getCompressionSnapshotMock,
}))

vi.mock('../../packages/server/src/lib/context-compressor/export-compressor', () => ({
  ExportCompressor: class {
    async compress(messages: any[]) {
      return {
        messages,
        meta: { totalMessages: messages.length, compressed: true, llmCompressed: true, summaryTokenEstimate: 100, verbatimCount: 0, compressedStartIndex: -1 },
      }
    }
  },
}))

describe('session conversations controller', () => {
  beforeEach(() => {
    vi.resetModules()
    listConversationSummariesFromDbMock.mockReset()
    getConversationDetailFromDbMock.mockReset()
    listConversationSummariesMock.mockReset()
    getConversationDetailMock.mockReset()
    listSessionSummariesMock.mockReset()
    getSessionDetailFromDbMock.mockReset()
    getSessionDetailFromDbWithProfileMock.mockReset()
    getExactSessionDetailFromDbWithProfileMock.mockReset()
    getUsageStatsFromDbMock.mockReset()
    getSessionMock.mockReset()
    deleteHermesSessionForProfileMock.mockReset()
    localListSessionsMock.mockReset()
    localGetSessionDetailMock.mockReset()
    localSearchSessionsMock.mockReset()
    localDeleteSessionMock.mockReset()
    localRenameSessionMock.mockReset()
    localCreateSessionMock.mockReset()
    localUpdateSessionMock.mockReset()
    localAddMessagesMock.mockReset()
    localUpdateSessionStatsMock.mockReset()
    getGroupChatServerMock.mockReset()
    getGroupChatServerMock.mockReturnValue(null)
    getLocalUsageStatsMock.mockReset()
    getActiveProfileNameMock.mockReset()
    getActiveProfileNameMock.mockReturnValue('default')
    loggerWarnMock.mockReset()
    getCompressionSnapshotMock.mockReset()
    listUserProfilesMock.mockReset()
    listUserProfilesMock.mockReturnValue([])
    readConfigYamlForProfileMock.mockReset()
    readConfigYamlForProfileMock.mockResolvedValue({ model: { default: 'gpt-default', provider: 'openai' } })
    bridgeSwitchSessionModelMock.mockReset()
    bridgeGetRuntimeStateMock.mockReset()
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: false, running: false, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    codingAgentRunManagerMock.stop.mockReset()
  })

  it('lists conversations from the local session store', async () => {
    localListSessionsMock.mockReturnValue([{
      id: 'local-conversation',
      source: 'cli',
      model: 'gpt-5',
      title: 'Local',
      started_at: 1,
      ended_at: null,
      last_active: Math.floor(Date.now() / 1000),
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'preview',
      workspace: null,
    }])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'true', limit: '5' }, body: null }
    await mod.listConversations(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 5)
    expect(listConversationSummariesMock).not.toHaveBeenCalled()
    expect(ctx.body.sessions[0]).toMatchObject({ id: 'local-conversation', source: 'cli', title: 'Local' })
  })

  it('returns clean session context without tool calls or tool results', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'session-context-1',
      profile: 'default',
      source: 'cli',
      title: 'Context Session',
      messages: [
        { id: 1, role: 'user', content: 'Please inspect the repo', timestamp: 101 },
        {
          id: 2,
          role: 'assistant',
          content: 'I will inspect it.',
          timestamp: 102,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
        },
        { id: 3, role: 'tool', content: '{"file":"secret tool result"}', timestamp: 103, tool_call_id: 'call-1', tool_name: 'read_file' },
        {
          id: 4,
          role: 'assistant',
          content: '',
          timestamp: 104,
          tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
        },
        { id: 5, role: 'assistant', content: 'The repo has a README.', timestamp: 105, reasoning_content: 'Checked files.' },
        { id: 6, role: 'command', content: '/usage', timestamp: 106 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'session-context-1' }, query: {}, body: null }

    await mod.getContext(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('session-context-1')
    expect(ctx.body).toEqual({
      session_id: 'session-context-1',
      profile: 'default',
      source: 'cli',
      title: 'Context Session',
      message_count: 3,
      messages: [
        { id: 1, role: 'user', content: 'Please inspect the repo', timestamp: 101 },
        { id: 2, role: 'assistant', content: 'I will inspect it.', timestamp: 102 },
        { id: 5, role: 'assistant', content: 'The repo has a README.', timestamp: 105, reasoning_content: 'Checked files.' },
      ],
    })
    expect(JSON.stringify(ctx.body)).not.toContain('tool_calls')
    expect(JSON.stringify(ctx.body)).not.toContain('secret tool result')
  })

  it('returns 404 for missing session context', async () => {
    localGetSessionDetailMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'missing-session' }, query: {}, body: null }

    await mod.getContext(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('lists all account-accessible single-chat sessions when only the active profile header is present', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    localListSessionsMock.mockReturnValue([
      {
        id: 'default-session',
        profile: 'default',
        source: 'cli',
        model: 'gpt-5',
        title: 'Default',
        started_at: 1,
        ended_at: null,
        last_active: 3,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
      {
        id: 'travel-session',
        profile: 'travel',
        source: 'cli',
        model: 'gpt-5',
        title: 'Travel',
        started_at: 2,
        ended_at: null,
        last_active: 4,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
      {
        id: 'secret-session',
        profile: 'secret',
        source: 'cli',
        model: 'gpt-5',
        title: 'Secret',
        started_at: 3,
        ended_at: null,
        last_active: 5,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      state: {
        user: { id: 1, role: 'admin' },
        profile: { name: 'travel' },
      },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 2000)
    expect(ctx.body.sessions.map((session: any) => session.id)).toEqual(['default-session', 'travel-session'])
  })

  it('filters the single-chat session list when profile is explicitly provided', async () => {
    localListSessionsMock.mockReturnValue([])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { profile: 'travel' },
      state: { profile: { name: 'default' } },
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000)
  })

  it('lists only global-agent sessions when requested by source', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { source: 'global_agent' },
      state: {},
      body: null,
    }
    await mod.list(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, 'global_agent', 2000)
    expect(ctx.body.sessions).toEqual([expect.objectContaining({ id: 'global-1', source: 'global_agent' })])
  })

  it('hides workflow sessions from the default list but allows explicit workflow filtering', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'workflow-1', profile: 'default', source: 'workflow' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const defaultCtx: any = {
      query: {},
      state: {},
      body: null,
    }
    await mod.list(defaultCtx)
    expect(defaultCtx.body.sessions).toEqual([expect.objectContaining({ id: 'chat-1', source: 'cli' })])

    const workflowCtx: any = {
      query: { source: 'workflow' },
      state: {},
      body: null,
    }
    await mod.list(workflowCtx)

    expect(localListSessionsMock).toHaveBeenLastCalledWith(undefined, 'workflow', 2000)
    expect(workflowCtx.body.sessions).toEqual([expect.objectContaining({ id: 'workflow-1', source: 'workflow' })])
  })

  it('counts visible single-chat sessions with the same filters as the list endpoint', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    localListSessionsMock.mockReturnValue([
      { id: 'default-session', profile: 'default', source: 'cli' },
      { id: 'travel-session', profile: 'travel', source: 'coding_agent' },
      { id: 'secret-session', profile: 'secret', source: 'cli' },
      { id: 'unknown-profile-session', profile: 'missing', source: 'cli' },
      { id: 'api-session', profile: 'default', source: 'api_server' },
      { id: 'workflow-session', profile: 'default', source: 'workflow' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: {},
      state: {
        user: { id: 1, role: 'admin' },
      },
      body: null,
    }
    await mod.count(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith(undefined, undefined, 2147483647)
    expect(ctx.body).toEqual({ count: 3 })
  })

  it('counts sessions for an explicit profile and source', async () => {
    localListSessionsMock.mockReturnValue([
      { id: 'travel-global', profile: 'travel', source: 'global_agent' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { profile: 'travel', source: 'global_agent' },
      state: {},
      body: null,
    }
    await mod.count(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', 'global_agent', 2147483647)
    expect(ctx.body).toEqual({ count: 1 })
  })

  it('marks Hermes history sessions that already exist in the Web UI store', async () => {
    localListSessionsMock.mockReturnValue([{ id: 'cli-1', profile: 'travel' }])
    listSessionSummariesMock.mockResolvedValue([
      {
        id: 'cli-1',
        source: 'cli',
        model: 'gpt-5',
        title: 'Imported',
        started_at: 1,
        ended_at: null,
        last_active: 2,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
      {
        id: 'cli-2',
        source: 'cli',
        model: 'gpt-5',
        title: 'History only',
        started_at: 1,
        ended_at: null,
        last_active: 2,
        message_count: 1,
        tool_call_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        billing_provider: null,
        estimated_cost_usd: 0,
        actual_cost_usd: null,
        cost_status: '',
        preview: '',
      },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { profile: 'travel' }, state: {}, body: null }

    await mod.listHermesSessions(ctx)

    expect(localListSessionsMock).toHaveBeenCalledWith('travel', undefined, 2000)
    expect(listSessionSummariesMock).toHaveBeenCalledWith(undefined, 2000, 'travel')
    expect(ctx.body.sessions).toEqual([
      expect.objectContaining({ id: 'cli-1', profile: 'travel', webui_imported: true }),
      expect.objectContaining({ id: 'cli-2', profile: 'travel', webui_imported: false }),
    ])
  })

  it('searches all account-accessible single-chat sessions unless profile is explicit', async () => {
    localSearchSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { q: 'docker', limit: '10' },
      state: { profile: { name: 'travel' } },
      body: null,
    }
    await mod.search(ctx)

    expect(localSearchSessionsMock).toHaveBeenCalledWith(undefined, 'docker', 10)
    expect(ctx.body.results).toEqual([
      expect.objectContaining({ id: 'global-1', source: 'global_agent' }),
      expect.objectContaining({ id: 'chat-1', source: 'cli' }),
    ])
  })

  it('searches only global-agent sessions when requested by source', async () => {
    localSearchSessionsMock.mockReturnValue([
      { id: 'global-1', profile: 'default', source: 'global_agent' },
      { id: 'chat-1', profile: 'default', source: 'cli' },
    ])

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      query: { q: 'docker', source: 'global_agent', limit: '10' },
      state: {},
      body: null,
    }
    await mod.search(ctx)

    expect(localSearchSessionsMock).toHaveBeenCalledWith(undefined, 'docker', 10)
    expect(ctx.body.results).toEqual([expect.objectContaining({ id: 'global-1', source: 'global_agent' })])
  })

  it('propagates local session store errors for conversation summaries', async () => {
    localListSessionsMock.mockImplementation(() => {
      throw new Error('db unavailable')
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { humanOnly: 'false' }, body: null }
    await expect(mod.listConversations(ctx)).rejects.toThrow('db unavailable')
  })

  it('gets conversation messages from the local session store', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'root',
      messages: [
        { id: 1, session_id: 'root', role: 'user', content: 'hello', timestamp: 1 },
        { id: 2, session_id: 'root', role: 'command', content: '/usage', timestamp: 2 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'true' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('root')
    expect(getConversationDetailMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      session_id: 'root',
      messages: [{ id: 1, session_id: 'root', role: 'user', content: 'hello', timestamp: 1 }],
      visible_count: 1,
      thread_session_count: 1,
    })
  })

  it('treats missing conversation message arrays as empty', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'root',
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('root')
    expect(ctx.body).toEqual({
      session_id: 'root',
      messages: [],
      visible_count: 0,
      thread_session_count: 1,
    })
  })

  it('returns 404 when local conversation detail is missing', async () => {
    localGetSessionDetailMock.mockReturnValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'root' }, query: { humanOnly: 'false' }, body: null }
    await mod.getConversationMessages(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Conversation not found' })
  })

  it('prefers local session detail for Hermes history detail when available', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'cli-1',
      source: 'cli',
      title: 'Local complete',
      messages: [
        { id: 1, session_id: 'cli-1', role: 'user', content: 'local full message', timestamp: 1 },
      ],
    })
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'cli-1',
      source: 'cli',
      title: 'Hermes incomplete',
      messages: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'cli-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('cli-1')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'cli-1',
      title: 'Local complete',
      messages: [{ content: 'local full message' }],
    })
  })

  it('falls back to Hermes state.db when local history detail is missing', async () => {
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbMock.mockResolvedValue({
      id: 'hermes-1',
      source: 'cli',
      title: 'Hermes detail',
      messages: [
        { id: 1, session_id: 'hermes-1', role: 'user', content: 'from hermes', timestamp: 1 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'hermes-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('hermes-1')
    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('hermes-1')
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'hermes-1',
      title: 'Hermes detail',
      messages: [{ content: 'from hermes' }],
    })
  })

  it('reads Hermes history detail from the requested profile database', async () => {
    localGetSessionDetailMock.mockReturnValue(null)
    getSessionDetailFromDbWithProfileMock.mockResolvedValue({
      id: 'travel-session',
      source: 'cli',
      title: 'Travel detail',
      messages: [
        { id: 1, session_id: 'travel-session', role: 'user', content: 'from travel', timestamp: 1 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'travel-session' }, query: { profile: 'travel' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('travel-session')
    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(getSessionDetailFromDbMock).not.toHaveBeenCalled()
    expect(getSessionMock).not.toHaveBeenCalled()
    expect(ctx.body.session).toMatchObject({
      id: 'travel-session',
      profile: 'travel',
      title: 'Travel detail',
      messages: [{ content: 'from travel' }],
    })
  })

  it('does not return api_server sessions from the Hermes history detail endpoint', async () => {
    localGetSessionDetailMock.mockReturnValue({
      id: 'api-1',
      source: 'api_server',
      title: 'API Server',
      messages: [{ id: 1, session_id: 'api-1', role: 'user', content: 'local api', timestamp: 1 }],
    })
    getSessionDetailFromDbMock.mockResolvedValue(null)
    getSessionMock.mockResolvedValue(null)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'api-1' }, body: null }
    await mod.getHermesSession(ctx)

    expect(localGetSessionDetailMock).toHaveBeenCalledWith('api-1')
    expect(getSessionDetailFromDbMock).toHaveBeenCalledWith('api-1')
    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'Session not found' })
  })

  it('returns native state.db usage analytics for the requested period', async () => {
    const today = new Date().toISOString().slice(0, 10)
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 2,
      cache_write_tokens: 1,
      reasoning_tokens: 3,
      sessions: 1,
      by_model: [
        { model: 'local-model', input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, reasoning_tokens: 3, sessions: 1 },
      ],
      by_day: [
        { date: today, input_tokens: 10, output_tokens: 5, cache_read_tokens: 2, cache_write_tokens: 1, sessions: 1, errors: 0, cost: 0 },
      ],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      reasoning_tokens: 6,
      sessions: 2,
      cost: 0.02,
      total_api_calls: 7,
      by_model: [
        { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
      ],
      by_day: [
        { date: today, input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, sessions: 2, errors: 0, cost: 0.02 },
      ],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(getLocalUsageStatsMock).not.toHaveBeenCalled()
    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2)
    expect(ctx.body).toMatchObject({
      total_input_tokens: 20,
      total_output_tokens: 10,
      total_cache_read_tokens: 4,
      total_cache_write_tokens: 2,
      total_reasoning_tokens: 6,
      total_sessions: 2,
      total_cost: 0.02,
      total_api_calls: 7,
      period_days: 2,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'hermes-model', input_tokens: 20, output_tokens: 10, cache_read_tokens: 4, cache_write_tokens: 2, reasoning_tokens: 6, sessions: 2 },
    ])
    expect(ctx.body.daily_usage.find((row: any) => row.date === today)).toMatchObject({
      input_tokens: 20,
      output_tokens: 10,
      cache_read_tokens: 4,
      cache_write_tokens: 2,
      sessions: 2,
      cost: 0.02,
    })
  })

  it('loads usage analytics from the request-scoped profile state database', async () => {
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 12,
      output_tokens: 6,
      cache_read_tokens: 3,
      cache_write_tokens: 1,
      reasoning_tokens: 2,
      sessions: 1,
      cost: 0.01,
      total_api_calls: 4,
      by_model: [
        { model: 'research-model', input_tokens: 12, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, state: { profile: { name: 'research' } }, body: null }
    await mod.usageStats(ctx)

    expect(getUsageStatsFromDbMock).toHaveBeenCalledWith(2, undefined, 'research')
    expect(ctx.body).toMatchObject({
      total_input_tokens: 12,
      total_output_tokens: 6,
      total_sessions: 1,
      total_cost: 0.01,
      total_api_calls: 4,
    })
    expect(ctx.body.model_usage).toEqual([
      { model: 'research-model', input_tokens: 12, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 1, reasoning_tokens: 2, sessions: 1 },
    ])
  })

  it('keeps blank model usage as returned by state.db analytics', async () => {
    getLocalUsageStatsMock.mockReturnValue({
      input_tokens: 3,
      output_tokens: 1,
      cache_read_tokens: 2,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      sessions: 1,
      by_model: [
        { model: '', input_tokens: 3, output_tokens: 1, cache_read_tokens: 2, cache_write_tokens: 0, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })
    getUsageStatsFromDbMock.mockResolvedValue({
      input_tokens: 2,
      output_tokens: 1,
      cache_read_tokens: 1,
      cache_write_tokens: 1,
      reasoning_tokens: 0,
      sessions: 1,
      cost: 0,
      total_api_calls: 0,
      by_model: [
        { model: ' ', input_tokens: 2, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 1 },
      ],
      by_day: [],
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { query: { days: '2' }, body: null }
    await mod.usageStats(ctx)

    expect(ctx.body.model_usage).toEqual([
      { model: ' ', input_tokens: 2, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1, reasoning_tokens: 0, sessions: 1 },
    ])
  })

  it('sets a session model and provider in the local session store', async () => {
    getSessionMock.mockReturnValue({ id: 'session-1' })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { model: 'grok-4', provider: 'xai' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localCreateSessionMock).not.toHaveBeenCalled()
    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-1', {
      model: 'grok-4',
      provider: 'xai',
      workspace: '/tmp/hermes-test/default/workspace',
    })
    expect(bridgeSwitchSessionModelMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('notifies a loaded agent bridge session after storing the session model', async () => {
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: true, running: true, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    bridgeSwitchSessionModelMock.mockResolvedValue({
      ok: true,
      session_id: 'session-1',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      loaded: true,
      switched: true,
    })
    getSessionMock.mockReturnValue({ id: 'session-1', profile: 'travel' })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'session-1' },
      request: { body: { model: 'claude-sonnet-4-6', provider: 'claude-oauth' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('session-1', {
      model: 'claude-sonnet-4-6',
      provider: 'claude-oauth',
      workspace: '/tmp/hermes-test/travel/workspace',
    })
    expect(bridgeSwitchSessionModelMock).toHaveBeenCalledWith(
      'session-1',
      'claude-sonnet-4-6',
      'anthropic',
      'travel',
    )
    expect(ctx.body).toEqual({ ok: true })
  })

  it('stores a coding agent session model without stopping the runner or notifying the Hermes bridge', async () => {
    bridgeGetRuntimeStateMock.mockReturnValue({ ready: true, running: true, endpoint: 'ipc:///tmp/hermes-agent-bridge.sock' })
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
      agent: 'codex',
      model: 'old-model',
      provider: 'openrouter',
      agent_native_session_id: 'old-native-thread',
      workspace: '/tmp/original-workspace',
    })

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      params: { id: 'codex-session' },
      request: { body: { model: 'gpt-5.5', provider: 'openai-codex' } },
      body: null,
    }
    await mod.setModel(ctx)

    expect(localUpdateSessionMock).toHaveBeenCalledWith('codex-session', {
      model: 'gpt-5.5',
      provider: 'openai-codex',
      agent_native_session_id: '',
    })
    expect(codingAgentRunManagerMock.stop).not.toHaveBeenCalled()
    expect(bridgeSwitchSessionModelMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({ ok: true })
  })

  it('deletes a current-profile Hermes history session even when no local Web UI session exists', async () => {
    getActiveProfileNameMock.mockReturnValue('travel')
    getSessionMock.mockReturnValue(null)
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'history-only', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'history-only' }, body: null }
    await mod.remove(ctx)

    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('history-only', 'travel')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('history-only', 'travel')
    expect(localDeleteSessionMock).not.toHaveBeenCalled()
    expect(ctx.body).toEqual({
      ok: true,
      deleted: false,
      hermes: { attempted: true, deleted: true, profile: 'travel', error: undefined },
    })
  })

  it('deletes a local coding-agent session without invoking Hermes CLI deletion', async () => {
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
    })
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'codex-session' }, body: null }
    await mod.remove(ctx)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('codex-session', { reportClosed: false })
    expect(getExactSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(deleteHermesSessionForProfileMock).not.toHaveBeenCalled()
    expect(localDeleteSessionMock).toHaveBeenCalledWith('codex-session')
    expect(ctx.body).toEqual({
      ok: true,
      deleted: true,
      hermes: { attempted: false, deleted: false, profile: 'default' },
    })
  })

  it('batch deletes sessions from their requested profiles', async () => {
    listUserProfilesMock.mockReturnValue([{ profile_name: 'default' }, { profile_name: 'travel' }])
    getSessionMock.mockImplementation((id: string) => ({
      id,
      profile: id === 'travel-session' ? 'travel' : 'default',
    }))
    getExactSessionDetailFromDbWithProfileMock.mockResolvedValue({ id: 'matched', messages: [] })
    deleteHermesSessionForProfileMock.mockResolvedValue(true)
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      request: {
        body: {
          sessions: [
            { id: 'default-session', profile: 'default' },
            { id: 'travel-session', profile: 'travel' },
          ],
        },
      },
      state: {
        user: { id: 1, role: 'admin' },
      },
      body: null,
    }
    await mod.batchRemove(ctx)

    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('default-session', 'default')
    expect(getExactSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('default-session', 'default')
    expect(deleteHermesSessionForProfileMock).toHaveBeenCalledWith('travel-session', 'travel')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('default-session')
    expect(localDeleteSessionMock).toHaveBeenCalledWith('travel-session')
    expect(ctx.body).toMatchObject({ ok: true, deleted: 2, failed: 0, hermesDeleted: 2 })
  })

  it('batch deletes local coding-agent sessions without invoking Hermes CLI deletion', async () => {
    getSessionMock.mockReturnValue({
      id: 'codex-session',
      profile: 'default',
      source: 'coding_agent',
    })
    localDeleteSessionMock.mockReturnValue(true)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = {
      request: {
        body: {
          sessions: [{ id: 'codex-session', profile: 'default' }],
        },
      },
      body: null,
    }
    await mod.batchRemove(ctx)

    expect(codingAgentRunManagerMock.stop).toHaveBeenCalledWith('codex-session', { reportClosed: false })
    expect(getExactSessionDetailFromDbWithProfileMock).not.toHaveBeenCalled()
    expect(deleteHermesSessionForProfileMock).not.toHaveBeenCalled()
    expect(localDeleteSessionMock).toHaveBeenCalledWith('codex-session')
    expect(ctx.body).toMatchObject({ ok: true, deleted: 1, failed: 0, hermesDeleted: 0 })
  })

  it('imports a Hermes session into the local Web UI store', async () => {
    const hermesDetail = {
      id: 'cli-1',
      source: 'cli',
      user_id: null,
      model: 'gpt-5',
      title: 'CLI run',
      started_at: 100,
      ended_at: 200,
      end_reason: null,
      message_count: 2,
      tool_call_count: 0,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      billing_provider: null,
      estimated_cost_usd: 0,
      actual_cost_usd: null,
      cost_status: '',
      preview: 'hello',
      last_active: 200,
      thread_session_count: 1,
      messages: [
        { id: 1, session_id: 'cli-1', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null },
        { id: 2, session_id: 'cli-1', role: 'assistant', content: 'hi', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null, reasoning_details: { text: 'ok' } },
        { id: 3, session_id: 'cli-1', role: 'assistant', content: '', tool_call_id: null, tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: { path: 'README.md' } } }], tool_name: null, timestamp: 102, token_count: null, finish_reason: 'tool_calls', reasoning: null },
        { id: 4, session_id: 'cli-1', role: 'tool', content: { ok: true }, tool_call_id: 'call-1', tool_calls: null, tool_name: 'read_file', timestamp: 103, token_count: null, finish_reason: null, reasoning: null },
        { id: 5, session_id: 'cli-1', role: 'tool', content: 'orphan', tool_call_id: null, tool_calls: null, tool_name: 'bad_tool', timestamp: 104, token_count: null, finish_reason: null, reasoning: null },
        { id: 6, session_id: 'cli-1', role: 'system', content: 'drop me', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 105, token_count: null, finish_reason: null, reasoning: null },
      ],
    }
    localGetSessionDetailMock.mockReturnValueOnce(null).mockReturnValueOnce({ ...hermesDetail, profile: 'travel' })
    getSessionDetailFromDbWithProfileMock.mockResolvedValue(hermesDetail)

    const mod = await import('../../packages/server/src/controllers/hermes/sessions')
    const ctx: any = { params: { id: 'cli-1' }, query: { profile: 'travel' }, state: {}, body: null }

    await mod.importHermesSession(ctx)

    expect(getSessionDetailFromDbWithProfileMock).toHaveBeenCalledWith('cli-1', 'travel')
    expect(localCreateSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      id: 'cli-1',
      profile: 'travel',
      source: 'cli',
      model: 'gpt-default',
      provider: 'openai',
      title: 'CLI run',
    }))
    expect(localUpdateSessionMock).toHaveBeenCalledWith('cli-1', expect.objectContaining({
      source: 'cli',
      model: 'gpt-default',
      provider: 'openai',
    }))
    expect(localAddMessagesMock).toHaveBeenCalledWith([
      expect.objectContaining({ session_id: 'cli-1', role: 'user', content: 'hello', tool_calls: null }),
      expect.objectContaining({ session_id: 'cli-1', role: 'assistant', content: 'hi', reasoning_details: '{"text":"ok"}' }),
      expect.objectContaining({
        session_id: 'cli-1',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }],
      }),
      expect.objectContaining({ session_id: 'cli-1', role: 'tool', content: '{"ok":true}', tool_call_id: 'call-1', tool_name: 'read_file' }),
    ])
    expect(localUpdateSessionStatsMock).toHaveBeenCalledWith('cli-1')
    expect(localUpdateSessionMock.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      last_active: expect.any(Number),
    }))
    expect(localUpdateSessionMock.mock.calls.at(-1)?.[1].last_active).toBeGreaterThan(200)
    expect(ctx.body).toMatchObject({ ok: true, imported: true })
  })

  describe('exportSession', () => {
    it('returns session as JSON download with correct headers (full mode)', async () => {
      const sessionData = { id: 'abc-123', title: 'Test Session', messages: [{ id: 1, role: 'user', content: 'hello' }] }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'abc-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).toHaveBeenCalledWith('abc-123')
      expect(setMock).toHaveBeenCalledWith('Content-Disposition', expect.stringContaining('abc-123'))
      expect(setMock).toHaveBeenCalledWith('Content-Type', 'application/json')
      expect(ctx.status).toBeUndefined()
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'abc-123', title: 'Test Session' })
    })

    it('returns full TXT export', async () => {
      const sessionData = {
        id: 'txt-123',
        title: 'Text Export',
        messages: [
          { id: 1, role: 'user', content: 'hello', timestamp: 1700000000 },
          { id: 2, role: 'assistant', content: 'hi', timestamp: 1700000001 },
        ],
      }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'txt-123' }, query: { mode: 'full', ext: 'txt' }, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(setMock).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8')
      expect(ctx.body).toContain('# Text Export')
      expect(ctx.body).toContain('[user]')
      expect(ctx.body).toContain('hello')
      expect(ctx.body).toContain('[assistant]')
      expect(ctx.body).toContain('hi')
    })

    it('returns 404 when session not found', async () => {
      localGetSessionDetailMock.mockReturnValue(null)
      getSessionMock.mockResolvedValue(null)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const ctx: any = { params: { id: 'not-found' }, query: {}, set: vi.fn(), body: null }

      await mod.exportSession(ctx)

      expect(ctx.status).toBe(404)
      expect(ctx.body).toEqual({ error: 'Session not found' })
    })

    it('falls back to CLI when DB query fails', async () => {
      const sessionData = { id: 'cli-123', title: 'CLI Session', messages: [] }
      localGetSessionDetailMock.mockReturnValue(sessionData)

      const mod = await import('../../packages/server/src/controllers/hermes/sessions')
      const setMock = vi.fn()
      const ctx: any = { params: { id: 'cli-123' }, query: {}, set: setMock, body: null }

      await mod.exportSession(ctx)

      expect(localGetSessionDetailMock).toHaveBeenCalledWith('cli-123')
      expect(JSON.parse(ctx.body)).toMatchObject({ id: 'cli-123' })
    })
  })
})
