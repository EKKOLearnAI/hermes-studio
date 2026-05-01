import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalCwd = process.cwd()
let tempCwd: string | null = null

async function resetWithTempDb() {
  tempCwd = mkdtempSync(join(tmpdir(), 'hermes-wui-chat-run-sync-'))
  process.chdir(tempCwd)
  vi.resetModules()
  vi.doMock('../../packages/server/src/services/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }))
  const schemas = await import('../../packages/server/src/db/hermes/schemas')
  schemas.initAllHermesTables()
}

async function closeTempDb() {
  try {
    const dbMod = await import('../../packages/server/src/db/index')
    dbMod.getDb()?.close()
  } catch {
    // ignore cleanup failures
  }
  process.chdir(originalCwd)
  if (tempCwd) rmSync(tempCwd, { recursive: true, force: true })
  tempCwd = null
  vi.resetModules()
  vi.doUnmock('../../packages/server/src/services/logger')
  vi.doUnmock('../../packages/server/src/db/hermes/sessions-db')
}

describe('durable chat run mapping', () => {
  beforeEach(async () => {
    await resetWithTempDb()
  })

  afterEach(async () => {
    await closeTempDb()
  })

  it('persists a WUI session to Hermes run mapping and marks it synced only after repair', async () => {
    const store = await import('../../packages/server/src/db/hermes/chat-run-store')

    store.recordChatSessionRun({
      wuiSessionId: 'wui-session-1',
      hermesSessionId: 'eph_run_1',
      profile: 'default',
      status: 'started',
      startedAt: 100,
    })
    store.recordChatSessionRun({
      wuiSessionId: 'wui-session-1',
      hermesSessionId: 'eph_run_1',
      runId: 'run-1',
      profile: 'default',
      status: 'running',
      startedAt: 101,
    })

    const row = store.getChatSessionRunByHermesSessionId('eph_run_1')
    expect(row).toMatchObject({
      wui_session_id: 'wui-session-1',
      hermes_session_id: 'eph_run_1',
      run_id: 'run-1',
      status: 'running',
      started_at: 100,
    })

    store.markChatSessionRunCompleted('eph_run_1', 'completed', 200)
    expect(store.listRepairableChatSessionRuns('wui-session-1')).toHaveLength(1)

    store.markChatSessionRunSynced('eph_run_1', 210)
    expect(store.listRepairableChatSessionRuns('wui-session-1')).toHaveLength(0)

    store.markChatSessionRunCompleted('eph_run_1', 'completed', 220)
    expect(store.getChatSessionRunByHermesSessionId('eph_run_1')?.status).toBe('synced')
    store.markChatSessionRunSyncFailed('eph_run_1', 'late sync failure', 230)
    expect(store.getChatSessionRunByHermesSessionId('eph_run_1')?.status).toBe('synced')
    store.recordChatSessionRun({
      wuiSessionId: 'wui-session-1',
      hermesSessionId: 'eph_run_1',
      runId: 'run-1-late',
      profile: 'default',
      status: 'running',
      startedAt: 240,
    })
    expect(store.getChatSessionRunByHermesSessionId('eph_run_1')?.status).toBe('synced')

    store.recordChatSessionRun({
      wuiSessionId: 'wui-session-1',
      hermesSessionId: 'eph_failed',
      profile: 'default',
      status: 'failed',
      startedAt: 300,
    })
    store.markChatSessionRunSyncFailed('eph_failed', 'missing source', 310)
    expect(store.getChatSessionRunByHermesSessionId('eph_failed')?.status).toBe('failed')
    expect(store.listRepairableChatSessionRuns('wui-session-1')).toHaveLength(0)
  })

  it('syncs mapped Hermes non-user rows idempotently, including assistant tool-call scaffolding', async () => {
    vi.doMock('../../packages/server/src/db/hermes/sessions-db', () => ({
      getSessionMessagesFromDb: vi.fn(async () => ({
        session: {
          id: 'eph_run_2',
          source: 'api_server',
          user_id: null,
          model: 'gpt-test',
          title: null,
          started_at: 100,
          ended_at: 200,
          end_reason: 'stop',
          message_count: 3,
          tool_call_count: 1,
          input_tokens: 11,
          output_tokens: 22,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          billing_provider: null,
          estimated_cost_usd: 0,
          actual_cost_usd: null,
          cost_status: '',
          preview: 'hello',
          last_active: 200,
        },
        messages: [
          { id: 1, session_id: 'eph_run_2', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          { id: 2, session_id: 'eph_run_2', role: 'assistant', content: '', tool_call_id: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], tool_name: null, timestamp: 101, token_count: null, finish_reason: 'tool_calls', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          { id: 3, session_id: 'eph_run_2', role: 'tool', content: 'tool output', tool_call_id: 'call_1', tool_calls: null, tool_name: null, timestamp: 102, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
        ],
      })),
      getSessionMessagesFromDbWithProfile: vi.fn(async () => ({
        session: {
          id: 'eph_run_2', source: 'api_server', user_id: null, model: 'gpt-test', title: null,
          started_at: 100, ended_at: 200, end_reason: 'stop', message_count: 3, tool_call_count: 1,
          input_tokens: 11, output_tokens: 22, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
          billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'hello', last_active: 200,
        },
        messages: [
          { id: 1, session_id: 'eph_run_2', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          { id: 2, session_id: 'eph_run_2', role: 'assistant', content: '', tool_call_id: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } }], tool_name: null, timestamp: 101, token_count: null, finish_reason: 'tool_calls', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          { id: 3, session_id: 'eph_run_2', role: 'tool', content: 'tool output', tool_call_id: 'call_1', tool_calls: null, tool_name: null, timestamp: 102, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
        ],
      })),
    }))

    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    const runStore = await import('../../packages/server/src/db/hermes/chat-run-store')
    const sync = await import('../../packages/server/src/services/hermes/chat-run-sync')

    sessionStore.createSession({ id: 'wui-session-2', profile: 'default', model: 'gpt-test', title: 'hello' })
    sessionStore.addMessage({ session_id: 'wui-session-2', role: 'user', content: 'hello', timestamp: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-2', hermesSessionId: 'eph_run_2', profile: 'default', status: 'completed', startedAt: 100 })

    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-2', hermesSessionId: 'eph_run_2', profile: 'default' })
    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-2', hermesSessionId: 'eph_run_2', profile: 'default' })
    runStore.markChatSessionRunCompleted('eph_run_2', 'completed', 250)
    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-2', hermesSessionId: 'eph_run_2', profile: 'default' })

    const detail = sessionStore.getSessionDetail('wui-session-2')!
    expect(detail.messages.map(m => [m.role, m.content, m.tool_call_id, m.tool_name])).toEqual([
      ['user', 'hello', null, null],
      ['assistant', '', null, null],
      ['tool', 'tool output', 'call_1', 'lookup'],
    ])
    expect(detail.message_count).toBe(3)
    expect(runStore.getChatSessionRunByHermesSessionId('eph_run_2')?.status).toBe('synced')

    const usage = (await import('../../packages/server/src/db/hermes/usage-store')).getLocalUsageStats('default')
    expect(usage.input_tokens).toBe(11)
    expect(usage.output_tokens).toBe(22)
  })

  it('does not collapse distinct Hermes messages with identical local payloads', async () => {
    const hermesSession = {
      id: 'eph_dupes', source: 'api_server', user_id: null, model: 'gpt-test', title: null,
      started_at: 100, ended_at: 200, end_reason: 'stop', message_count: 3, tool_call_count: 0,
      input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'dup', last_active: 200,
    }
    const hermesMessages = [
      { id: 1, session_id: 'eph_dupes', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
      { id: 2, session_id: 'eph_dupes', role: 'assistant', content: 'duplicate', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: 'stop', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
      { id: 3, session_id: 'eph_dupes', role: 'assistant', content: 'duplicate', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: 'stop', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
    ]
    vi.doMock('../../packages/server/src/db/hermes/sessions-db', () => ({
      getSessionMessagesFromDb: vi.fn(async () => ({ session: hermesSession, messages: hermesMessages })),
      getSessionMessagesFromDbWithProfile: vi.fn(async () => ({ session: hermesSession, messages: hermesMessages })),
    }))

    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    const runStore = await import('../../packages/server/src/db/hermes/chat-run-store')
    const sync = await import('../../packages/server/src/services/hermes/chat-run-sync')

    sessionStore.createSession({ id: 'wui-session-dupes', profile: 'default', model: 'gpt-test', title: 'hello' })
    sessionStore.addMessage({ session_id: 'wui-session-dupes', role: 'user', content: 'hello', timestamp: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-dupes', hermesSessionId: 'eph_dupes', profile: 'default', status: 'completed', startedAt: 100 })

    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-dupes', hermesSessionId: 'eph_dupes', profile: 'default' })
    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-dupes', hermesSessionId: 'eph_dupes', profile: 'default' })

    const detail = sessionStore.getSessionDetail('wui-session-dupes')!
    expect(detail.messages.map(m => [m.role, m.content, m.timestamp])).toEqual([
      ['user', 'hello', 100],
      ['assistant', 'duplicate', 101],
      ['assistant', 'duplicate', 101],
    ])
    expect(detail.message_count).toBe(3)
    expect(runStore.getChatSessionRunByHermesSessionId('eph_dupes')?.status).toBe('synced')
  })

  it('does not reuse a mapped local row for duplicate payloads from later Hermes runs', async () => {
    const makeSession = (id: string) => ({
      id, source: 'api_server', user_id: null, model: 'gpt-test', title: null,
      started_at: 100, ended_at: 200, end_reason: 'stop', message_count: 2, tool_call_count: 0,
      input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
      billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'dup', last_active: 200,
    })
    const makeMessages = (sessionId: string) => [
      { id: 1, session_id: sessionId, role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
      { id: 2, session_id: sessionId, role: 'assistant', content: 'duplicate', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: 'stop', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
    ]
    vi.doMock('../../packages/server/src/db/hermes/sessions-db', () => ({
      getSessionMessagesFromDb: vi.fn(async (sessionId: string) => ({ session: makeSession(sessionId), messages: makeMessages(sessionId) })),
      getSessionMessagesFromDbWithProfile: vi.fn(async (sessionId: string) => ({ session: makeSession(sessionId), messages: makeMessages(sessionId) })),
    }))

    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    const runStore = await import('../../packages/server/src/db/hermes/chat-run-store')
    const sync = await import('../../packages/server/src/services/hermes/chat-run-sync')

    sessionStore.createSession({ id: 'wui-session-cross-dupes', profile: 'default', model: 'gpt-test', title: 'hello' })
    sessionStore.addMessage({ session_id: 'wui-session-cross-dupes', role: 'user', content: 'hello', timestamp: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-cross-dupes', hermesSessionId: 'eph_dupe_a', profile: 'default', status: 'completed', startedAt: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-cross-dupes', hermesSessionId: 'eph_dupe_b', profile: 'default', status: 'completed', startedAt: 101 })

    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-cross-dupes', hermesSessionId: 'eph_dupe_a', profile: 'default' })
    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-cross-dupes', hermesSessionId: 'eph_dupe_b', profile: 'default' })
    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-cross-dupes', hermesSessionId: 'eph_dupe_a', profile: 'default' })
    await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-cross-dupes', hermesSessionId: 'eph_dupe_b', profile: 'default' })

    const detail = sessionStore.getSessionDetail('wui-session-cross-dupes')!
    expect(detail.messages.map(m => [m.role, m.content, m.timestamp])).toEqual([
      ['user', 'hello', 100],
      ['assistant', 'duplicate', 101],
      ['assistant', 'duplicate', 101],
    ])
    expect(detail.message_count).toBe(3)
  })

  it('does not sync or delete non-terminal Hermes runs', async () => {
    vi.doMock('../../packages/server/src/db/hermes/sessions-db', () => ({
      getSessionMessagesFromDb: vi.fn(async () => ({
        session: {
          id: 'eph_running', source: 'api_server', user_id: null, model: 'gpt-test', title: null,
          started_at: 100, ended_at: null, end_reason: null, message_count: 2, tool_call_count: 0,
          input_tokens: 5, output_tokens: 6, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
          billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'partial', last_active: 101,
        },
        messages: [
          { id: 1, session_id: 'eph_running', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          { id: 2, session_id: 'eph_running', role: 'assistant', content: 'partial', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
        ],
      })),
      getSessionMessagesFromDbWithProfile: vi.fn(async () => ({
        session: {
          id: 'eph_running', source: 'api_server', user_id: null, model: 'gpt-test', title: null,
          started_at: 100, ended_at: null, end_reason: null, message_count: 2, tool_call_count: 0,
          input_tokens: 5, output_tokens: 6, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
          billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'partial', last_active: 101,
        },
        messages: [
          { id: 1, session_id: 'eph_running', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          { id: 2, session_id: 'eph_running', role: 'assistant', content: 'partial', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
        ],
      })),
    }))

    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    const runStore = await import('../../packages/server/src/db/hermes/chat-run-store')
    const sync = await import('../../packages/server/src/services/hermes/chat-run-sync')

    sessionStore.createSession({ id: 'wui-session-3', profile: 'default', model: 'gpt-test', title: 'hello' })
    sessionStore.addMessage({ session_id: 'wui-session-3', role: 'user', content: 'hello', timestamp: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-3', hermesSessionId: 'eph_running', profile: 'default', status: 'running', startedAt: 100 })

    const result = await sync.syncHermesRunToLocalSession({ localSessionId: 'wui-session-3', hermesSessionId: 'eph_running', profile: 'default' })

    expect(result.status).toBe('pending')
    expect(sessionStore.getSessionDetail('wui-session-3')!.messages).toHaveLength(1)
    expect(runStore.getChatSessionRunByHermesSessionId('eph_running')?.status).toBe('running')
  })

  it('continues repairing later runs when an older mapped run errors', async () => {
    vi.doMock('../../packages/server/src/db/hermes/sessions-db', () => ({
      getSessionMessagesFromDb: vi.fn(async (sessionId: string) => {
        if (sessionId === 'eph_bad') throw new Error('boom')
        return {
          session: {
            id: 'eph_good', source: 'api_server', user_id: null, model: 'gpt-test', title: null,
            started_at: 100, ended_at: 200, end_reason: 'stop', message_count: 2, tool_call_count: 0,
            input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
            billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'done', last_active: 200,
          },
          messages: [
            { id: 1, session_id: 'eph_good', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
            { id: 2, session_id: 'eph_good', role: 'assistant', content: 'done', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: 'stop', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          ],
        }
      }),
      getSessionMessagesFromDbWithProfile: vi.fn(async (sessionId: string) => {
        if (sessionId === 'eph_bad') throw new Error('boom')
        return {
          session: {
            id: 'eph_good', source: 'api_server', user_id: null, model: 'gpt-test', title: null,
            started_at: 100, ended_at: 200, end_reason: 'stop', message_count: 2, tool_call_count: 0,
            input_tokens: 1, output_tokens: 2, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
            billing_provider: null, estimated_cost_usd: 0, actual_cost_usd: null, cost_status: '', preview: 'done', last_active: 200,
          },
          messages: [
            { id: 1, session_id: 'eph_good', role: 'user', content: 'hello', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 100, token_count: null, finish_reason: null, reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
            { id: 2, session_id: 'eph_good', role: 'assistant', content: 'done', tool_call_id: null, tool_calls: null, tool_name: null, timestamp: 101, token_count: null, finish_reason: 'stop', reasoning: null, reasoning_details: null, reasoning_content: null, codex_reasoning_items: null },
          ],
        }
      }),
    }))

    const sessionStore = await import('../../packages/server/src/db/hermes/session-store')
    const runStore = await import('../../packages/server/src/db/hermes/chat-run-store')
    const sync = await import('../../packages/server/src/services/hermes/chat-run-sync')

    sessionStore.createSession({ id: 'wui-session-4', profile: 'default', model: 'gpt-test', title: 'hello' })
    sessionStore.addMessage({ session_id: 'wui-session-4', role: 'user', content: 'hello', timestamp: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-4', hermesSessionId: 'eph_bad', profile: 'default', status: 'completed', startedAt: 100 })
    runStore.recordChatSessionRun({ wuiSessionId: 'wui-session-4', hermesSessionId: 'eph_good', profile: 'default', status: 'completed', startedAt: 101 })

    const results = await sync.repairUnsyncedChatRuns('wui-session-4', 'default')

    expect(results.map(r => r.status)).toEqual(['error', 'synced'])
    expect(sessionStore.getSessionDetail('wui-session-4')!.messages.map(m => m.content)).toEqual(['hello', 'done'])
    expect(runStore.getChatSessionRunByHermesSessionId('eph_bad')?.status).toBe('sync_failed')
    expect(runStore.getChatSessionRunByHermesSessionId('eph_good')?.status).toBe('synced')
  })
})
