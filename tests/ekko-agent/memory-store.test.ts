import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EkkoDatabaseManager,
  SqliteMemoryStore,
  type MemoryNode,
} from '../../packages/ekko-agent/src'

let webUiHome = ''
let store: SqliteMemoryStore

beforeEach(async () => {
  webUiHome = await mkdtemp(join(tmpdir(), 'ekko-memory-store-'))
  store = new SqliteMemoryStore(new EkkoDatabaseManager({ webUiHome }))
})

afterEach(async () => {
  store.close()
  await rm(webUiHome, { recursive: true, force: true })
})

describe('SqliteMemoryStore', () => {
  it('stores recent messages and chained summaries in order', async () => {
    await store.appendMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'one', createdAt: '2026-01-01T00:00:00.000Z' })
    await store.appendMessage({ id: 'm2', sessionId: 's1', parentId: 'm1', role: 'assistant', content: 'two', createdAt: '2026-01-01T00:00:01.000Z' })
    await store.appendSummary({
      id: 'summary-1',
      sessionId: 's1',
      fromMessageId: 'm1',
      toMessageId: 'm2',
      summary: 'first chain',
      constraints: [],
      preferences: [],
      decisions: [],
      completedWork: [],
      pendingWork: [],
      knownIssues: [],
      createdAt: '2026-01-01T00:00:02.000Z',
    })

    await expect(store.listRecentMessages({ sessionId: 's1', limit: 2 })).resolves.toMatchObject([
      { id: 'm1', content: 'one' },
      { id: 'm2', parentId: 'm1', content: 'two' },
    ])
    await expect(store.getLatestSummary({ sessionId: 's1' })).resolves.toMatchObject({ id: 'summary-1' })
  })

  it('isolates scopes and excludes expired nodes by default', async () => {
    await store.upsertNode(memoryNode('workspace-a', { scope: 'workspace', workspaceId: '/a' }))
    await store.upsertNode(memoryNode('workspace-b', { scope: 'workspace', workspaceId: '/b' }))
    await store.upsertNode(memoryNode('expired', {
      scope: 'workspace',
      workspaceId: '/a',
      expiresAt: '2020-01-01T00:00:00.000Z',
    }))

    await expect(store.queryNodes({ scopes: ['workspace'], workspaceId: '/a' })).resolves.toMatchObject([
      { id: 'workspace-a' },
    ])
    expect((await store.queryNodes({ scopes: ['workspace'], workspaceId: '/a', includeExpired: true })).map(node => node.id).sort())
      .toEqual(['expired', 'workspace-a'])
  })

  it('atomically supersedes nodes and supports soft and hard deletion', async () => {
    const oldNode = memoryNode('old')
    const newNode = memoryNode('new', { content: 'new preference', updatedAt: '2026-01-02T00:00:00.000Z' })
    await store.upsertNode(oldNode)
    store.databaseManager.connection.prepare(
      'INSERT INTO memory_embeddings (node_id, model, embedding, created_at) VALUES (?, ?, ?, ?)',
    ).run('old', 'test', Buffer.from([1, 2, 3]), '2026-01-01T00:00:00.000Z')
    await store.supersedeNode({ oldNodeId: oldNode.id, newNode, reason: 'corrected', actor: 'test' })

    await expect(store.getNode('old')).resolves.toMatchObject({ status: 'superseded' })
    await expect(store.getNode('new')).resolves.toMatchObject({ status: 'active', supersedesId: 'old' })
    await expect(store.deleteNode({ nodeId: 'new', mode: 'soft', reason: 'forget', actor: 'test' })).resolves.toBe(true)
    await expect(store.getNode('new')).resolves.toMatchObject({ status: 'deleted' })
    await expect(store.deleteNode({ nodeId: 'new', mode: 'hard', reason: 'erase', actor: 'test' })).resolves.toBe(true)
    await expect(store.getNode('new')).resolves.toBeUndefined()
    await expect(store.deleteNode({ nodeId: 'old', mode: 'hard', reason: 'erase old', actor: 'test' })).resolves.toBe(true)

    expect(store.databaseManager.connection.prepare(
      'SELECT COUNT(*) AS count FROM memory_embeddings WHERE node_id IN (?, ?)',
    ).get('old', 'new')).toMatchObject({ count: 0 })
    expect(store.databaseManager.connection.prepare(
      'SELECT COUNT(*) AS count FROM memory_nodes_fts WHERE node_id IN (?, ?)',
    ).get('old', 'new')).toMatchObject({ count: 0 })

    const audit = store.databaseManager.connection.prepare(
      'SELECT event_type FROM memory_audit_events ORDER BY row_id',
    ).all() as Array<{ event_type: string }>
    expect(audit.map(row => row.event_type)).toEqual(['supersede', 'delete', 'delete', 'delete'])
  })
})

function memoryNode(id: string, overrides: Partial<MemoryNode> = {}): MemoryNode {
  return {
    id,
    sessionId: 's1',
    scope: 'session',
    domain: 'general',
    categoryPath: ['general'],
    type: 'preference',
    key: 'style',
    valueJson: id,
    title: id,
    content: `${id} preference`,
    status: 'active',
    confidence: 0.9,
    importance: 0.8,
    tags: [],
    entities: [],
    sourceMessageIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}
