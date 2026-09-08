import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let db: any
let home: string
 afterEach(() => {
  db?.close()
  if (home) rmSync(home, { recursive: true, force: true })
  vi.doUnmock('../../packages/server/src/modules/studio/infrastructure/database/index')
  vi.resetModules()
})

it('persists one safe failure per exact run across database reopening without changing model history', async () => {
  vi.resetModules()
  const { DatabaseSync } = await import('node:sqlite')
  home = mkdtempSync(join(tmpdir(), 'studio-response-failure-'))
  const path = join(home, 'test.db')
  db = new DatabaseSync(path)
  vi.doMock('../../packages/server/src/modules/studio/infrastructure/database/index', () => ({ getDb: () => db, isSqliteAvailable: () => true, getStoragePath: () => path }))
  const { initAllHermesTables } = await import('../../packages/server/src/modules/studio/infrastructure/database/schemas')
  initAllHermesTables()
  const store = await import('../../packages/server/src/modules/studio/repositories/session-store')
  store.createSession({ id: 'failure-session', profile: 'default', source: 'cli' })
  store.addMessage({ session_id: 'failure-session', role: 'assistant', content: 'I will check the file.', run_marker: 'run-one', timestamp: 1 })
  expect(store).toHaveProperty('persistRunFailure', expect.any(Function))
  const persist = (store as any).persistRunFailure
  const error = 'HTTP 503: no available channel https://user:password@api.test/?token=secret {"prompt":"private prompt"} Authorization: Bearer sk-private'
  const first = persist('failure-session', 'run-one', error)
  expect(persist('failure-session', 'run-one', error)).toEqual(first)
  persist('failure-session', 'run-two', 'Connection timed out token=private')
  db.close()
  db = new DatabaseSync(path)
  const rows = store.getSessionDetail('failure-session')!.messages
  expect(rows.filter(row => row.role === 'run_failure')).toHaveLength(2)
  expect(rows[0].content).toBe('I will check the file.')
  expect(JSON.parse(rows[1].content)).toEqual({ code: 'unavailable', status: 503 })
  expect(JSON.stringify(rows)).not.toMatch(/password|secret|private|api.test/)
  expect(store.getSessionContextMessages('failure-session').map(row => row.content)).toEqual(['I will check the file.'])
  const { loadSessionStateFromDb } = await import('../../packages/server/src/modules/studio/services/chat-run/load-state')
  const { buildResumeMessages } = await import('../../packages/server/src/modules/studio/services/chat-run/resume-payload')
  const state = await loadSessionStateFromDb('failure-session', new Map())
  expect(buildResumeMessages(state.messages).filter(row => row.role === 'run_failure')).toHaveLength(2)
  store.createBranchedSession({ parent_session_id: 'failure-session', id: 'fork', source: 'cli', ended_at: 3, last_active: 3, messages: rows })
  expect(store.getSessionContextMessages('fork').map(row => row.content)).toEqual(['I will check the file.'])
  expect(store.getSessionDetailPaginated('failure-session', 1, 1)?.messages[0].role).toBe('run_failure')
})
