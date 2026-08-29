import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { EkkoDatabaseManager, type EkkoDatabaseMigration } from '../database'
import { memorySlotForKind } from './schema'
import { memoryScopeColumns, memoryScopeFromColumns, normalizeMemoryOrigin } from './scope'
import type {
  MemoryAuditEvent,
  MemoryAuditQuery,
  MemoryMessage,
  MemoryNode,
  MemoryQuery,
  MemoryStore,
} from './types'

const MEMORY_MIGRATIONS: EkkoDatabaseMigration[] = [{
  component: 'memory',
  version: 3,
  migrate(db) {
    db.exec(`
      DROP TABLE IF EXISTS memory_nodes_fts;
      DROP TABLE IF EXISTS memory_embeddings;
      DROP TABLE IF EXISTS memory_audit_events;
      DROP TABLE IF EXISTS memory_nodes;
      DROP TABLE IF EXISTS memory_messages;

      CREATE TABLE IF NOT EXISTS memory_messages (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_nodes (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        parent_id TEXT,
        supersedes_id TEXT,
        profile_id TEXT NOT NULL,
        domain TEXT NOT NULL,
        category_path_json TEXT NOT NULL,
        category_path_text TEXT NOT NULL,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        value_json TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        entities_json TEXT NOT NULL DEFAULT '[]',
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_audit_events (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        node_id TEXT,
        session_id TEXT,
        profile_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        node_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_messages_session_created
        ON memory_messages (session_id, row_id);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_lookup
        ON memory_nodes (profile_id, status, domain, type, importance, updated_at);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_key
        ON memory_nodes (profile_id, status, domain, type, key, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_nodes_unique_active_key
        ON memory_nodes (profile_id, key) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_category
        ON memory_nodes (category_path_text);
      CREATE INDEX IF NOT EXISTS idx_memory_audit_events_node
        ON memory_audit_events (node_id, row_id);
    `)
  },
}, {
  component: 'memory',
  version: 4,
  migrate(db) {
    db.exec(`
      ALTER TABLE memory_nodes ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'profile';
      ALTER TABLE memory_nodes ADD COLUMN scope_namespace TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_nodes ADD COLUMN scope_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE memory_nodes ADD COLUMN origin_json TEXT;
      DROP INDEX IF EXISTS idx_memory_nodes_unique_active_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_nodes_unique_active_scope_key
        ON memory_nodes (profile_id, scope_type, scope_namespace, scope_id, key)
        WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope
        ON memory_nodes (profile_id, scope_type, scope_namespace, scope_id, status, updated_at);
    `)
  },
}, {
  component: 'memory',
  version: 5,
  migrate() {},
}, {
  component: 'memory',
  version: 6,
  migrate() {},
}, {
  component: 'memory',
  version: 7,
  migrate(db) {
    db.exec(`DROP TABLE IF EXISTS memory_review_jobs;`)
  },
}, {
  component: 'memory',
  version: 8,
  migrate(db) {
    db.exec(`
      DROP TABLE IF EXISTS memory_session_state;
      DROP TABLE IF EXISTS memory_summaries;
    `)
  },
}]

type Row = Record<string, unknown>

export class SqliteMemoryStore implements MemoryStore {
  readonly databaseManager: EkkoDatabaseManager
  private ftsEnabled = false

  constructor(databaseManager = new EkkoDatabaseManager()) {
    this.databaseManager = databaseManager
    this.databaseManager.migrate(MEMORY_MIGRATIONS)
    this.initializeFts()
  }

  get databasePath(): string {
    return this.databaseManager.databasePath
  }

  async appendMessage(message: MemoryMessage): Promise<void> {
    this.db.prepare(`
      INSERT OR IGNORE INTO memory_messages
        (id, session_id, parent_id, role, content, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.sessionId,
      message.parentId ?? null,
      message.role,
      message.content,
      jsonOrNull(message.metadata),
      message.createdAt,
    )
  }

  async listRecentMessages(input: { sessionId: string; limit: number }): Promise<MemoryMessage[]> {
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM memory_messages WHERE session_id = ? ORDER BY row_id DESC LIMIT ?
      ) ORDER BY row_id ASC
    `).all(input.sessionId, boundedLimit(input.limit, 50)) as Row[]
    return rows.map(messageFromRow)
  }

  async listMessagesAfter(input: {
    sessionId: string
    messageId?: string
    throughMessageId?: string
    limit?: number
  }): Promise<MemoryMessage[]> {
    const after = input.messageId
      ? this.db.prepare('SELECT row_id FROM memory_messages WHERE id = ? AND session_id = ?').get(input.messageId, input.sessionId) as Row | undefined
      : undefined
    const through = input.throughMessageId
      ? this.db.prepare('SELECT row_id FROM memory_messages WHERE id = ? AND session_id = ?').get(input.throughMessageId, input.sessionId) as Row | undefined
      : undefined
    const rows = this.db.prepare(`
      SELECT * FROM memory_messages
      WHERE session_id = ? AND row_id > ? AND row_id <= ?
      ORDER BY row_id ASC
      LIMIT ?
    `).all(
      input.sessionId,
      Number(after?.row_id || 0),
      input.throughMessageId ? Number(through?.row_id || 0) : Number.MAX_SAFE_INTEGER,
      boundedLimit(input.limit ?? 100, 500),
    ) as Row[]
    return rows.map(messageFromRow)
  }

  async getNode(id: string): Promise<MemoryNode | undefined> {
    const row = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as Row | undefined
    return row ? nodeFromRow(row) : undefined
  }

  async upsertNode(
    node: MemoryNode,
    audit?: Omit<MemoryAuditEvent, 'id' | 'nodeId' | 'createdAt'>,
  ): Promise<void> {
    this.databaseManager.transaction(() => {
      this.writeNode(node)
      if (audit) this.writeAudit({ ...audit, id: randomUUID(), nodeId: node.id, createdAt: node.updatedAt })
    })
  }

  async supersedeNode(input: { oldNodeId: string; newNode: MemoryNode; reason: string; actor: string; sessionId?: string }): Promise<void> {
    this.databaseManager.transaction(() => {
      const old = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(input.oldNodeId) as Row | undefined
      if (!old) throw new Error(`Memory node not found: ${input.oldNodeId}`)
      const oldNode = nodeFromRow(old)
      if (input.newNode.revision !== oldNode.revision + 1) {
        throw new Error(`Memory revision must advance exactly once: ${input.oldNodeId}`)
      }
      const changed = this.db.prepare(
        "UPDATE memory_nodes SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active' AND revision = ?",
      ).run(input.newNode.updatedAt, input.oldNodeId, oldNode.revision)
      if (Number(changed.changes) !== 1) throw new Error(`Memory node is not active: ${input.oldNodeId}`)
      this.writeNode({ ...input.newNode, supersedesId: input.oldNodeId })
      this.syncFts({ ...oldNode, status: 'superseded', updatedAt: input.newNode.updatedAt })
      this.writeAudit(auditForNode('supersede', input.newNode, input.reason, input.actor, {
        supersededNodeId: input.oldNodeId,
      }, input.sessionId))
    })
  }

  async updateNodeStatus(input: { nodeId: string; status: MemoryNode['status']; reason: string; actor: string; expectedRevision?: number; sessionId?: string }): Promise<boolean> {
    const existing = await this.getNode(input.nodeId)
    if (!existing) return false
    if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) return false
    const updatedAt = new Date().toISOString()
    this.databaseManager.transaction(() => {
      const changed = this.db.prepare('UPDATE memory_nodes SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
        .run(input.status, updatedAt, input.nodeId, existing.revision)
      if (Number(changed.changes) !== 1) throw new Error(`Memory revision changed: ${input.nodeId}`)
      this.syncFts({ ...existing, status: input.status, revision: existing.revision + 1, updatedAt })
      this.writeAudit(auditForNode(
        input.status === 'expired' ? 'expire' : input.status === 'deleted' ? 'delete' : 'update',
        { ...existing, status: input.status, revision: existing.revision + 1, updatedAt },
        input.reason,
        input.actor,
        undefined,
        input.sessionId,
      ))
    })
    return true
  }

  async deleteNode(input: { nodeId: string; mode: 'soft' | 'hard'; reason: string; actor: string; expectedRevision?: number; sessionId?: string }): Promise<boolean> {
    const existing = await this.getNode(input.nodeId)
    if (!existing) return false
    if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) return false
    if (input.mode === 'soft') {
      return this.updateNodeStatus({ ...input, status: 'deleted' })
    }
    this.databaseManager.transaction(() => {
      this.writeAudit(auditForNode('delete', existing, input.reason, input.actor, { mode: 'hard' }, input.sessionId))
      if (this.ftsEnabled) this.db.prepare('DELETE FROM memory_nodes_fts WHERE node_id = ?').run(input.nodeId)
      this.db.prepare('DELETE FROM memory_embeddings WHERE node_id = ?').run(input.nodeId)
      const removed = this.db.prepare('DELETE FROM memory_nodes WHERE id = ? AND revision = ?')
        .run(input.nodeId, existing.revision)
      if (Number(removed.changes) !== 1) throw new Error(`Memory revision changed: ${input.nodeId}`)
    })
    return true
  }

  async queryNodes(query: MemoryQuery): Promise<MemoryNode[]> {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    const relevanceParams: SQLInputValue[] = []
    const relevanceExpressions: string[] = []
    if (!query.profileId) return []
    clauses.push('profile_id = ?')
    params.push(query.profileId)
    if (query.scopes?.length) {
      const scopeClauses: string[] = []
      for (const scope of query.scopes) {
        const columns = memoryScopeColumns(scope)
        scopeClauses.push('(scope_type = ? AND scope_namespace = ? AND scope_id = ?)')
        params.push(columns.type, columns.namespace, columns.id)
      }
      clauses.push(`(${scopeClauses.join(' OR ')})`)
    }
    if (query.statuses?.length) {
      addInClause(clauses, params, 'status', query.statuses)
    } else if (query.includeExpired) {
      clauses.push("status IN ('active', 'expired')")
    } else {
      clauses.push("status = 'active' AND (expires_at IS NULL OR expires_at > ?)")
      params.push(new Date().toISOString())
    }
    if (query.domain) {
      clauses.push('domain = ?')
      params.push(query.domain)
    }
    if (query.types?.length) addInClause(clauses, params, 'type', query.types)
    if (query.kinds?.length) {
      const kindClauses: string[] = []
      for (const kind of query.kinds) {
        const slot = memorySlotForKind(kind)
        if (slot.itemized) {
          kindClauses.push("(key = ? OR key LIKE ? ESCAPE '\\')")
          params.push(slot.key, `${escapeLike(slot.key)}:%`)
        } else {
          kindClauses.push('key = ?')
          params.push(slot.key)
        }
      }
      clauses.push(`(${kindClauses.join(' OR ')})`)
    }
    if (query.key) {
      clauses.push('key = ?')
      params.push(query.key)
    }
    if (query.valueJson !== undefined) {
      clauses.push('value_json = ?')
      params.push(stableJson(query.valueJson))
    }
    if (query.categoryPathPrefix?.length) {
      const path = categoryPathText(query.categoryPathPrefix)
      clauses.push('(category_path_text = ? OR category_path_text LIKE ?)')
      params.push(path, `${escapeLike(path)}/%`)
    }
    const queryTerms = memoryQueryTerms(query.queryText)
    if (queryTerms.length) {
      const searchableColumns = [
        ['title', 5],
        ['entities_json', 4],
        ['key', 4],
        ['tags_json', 3],
        ['value_json', 3],
        ['category_path_text', 2],
        ['content', 2],
      ] as const
      const termClauses: string[] = []
      for (const term of queryTerms) {
        const pattern = `%${escapeLike(term)}%`
        termClauses.push(`(${searchableColumns.map(([column]) => `${column} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
        params.push(...searchableColumns.map(() => pattern))
        for (const [column, weight] of searchableColumns) {
          relevanceExpressions.push(`CASE WHEN ${column} LIKE ? ESCAPE '\\' THEN ${weight} ELSE 0 END`)
          relevanceParams.push(pattern)
        }
      }
      clauses.push(`(${termClauses.join(' OR ')})`)
    }
    for (const tag of query.tags || []) {
      clauses.push("tags_json LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(JSON.stringify(String(tag)))}%`)
    }
    for (const entity of query.entities || []) {
      clauses.push("entities_json LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLike(JSON.stringify(String(entity)))}%`)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const relevanceOrder = relevanceExpressions.length
      ? `${relevanceExpressions.join(' + ')} DESC,`
      : ''
    const rows = this.db.prepare(`
      SELECT * FROM memory_nodes ${where}
      ORDER BY ${relevanceOrder} importance DESC, confidence DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `).all(
      ...params,
      ...relevanceParams,
      boundedLimit(query.limit ?? 50, 500),
      boundedOffset(query.offset),
    ) as Row[]
    return rows.map(nodeFromRow)
  }

  async appendAuditEvent(event: MemoryAuditEvent): Promise<void> {
    this.writeAudit(event)
  }

  async listAuditEvents(query: MemoryAuditQuery = {}): Promise<MemoryAuditEvent[]> {
    const clauses: string[] = []
    const params: SQLInputValue[] = []
    if (query.profileId) {
      clauses.push('profile_id = ?')
      params.push(query.profileId)
    }
    if (query.nodeId) {
      clauses.push('node_id = ?')
      params.push(query.nodeId)
    }
    if (query.sessionId) {
      clauses.push('session_id = ?')
      params.push(query.sessionId)
    }
    if (query.eventTypes?.length) addInClause(clauses, params, 'event_type', query.eventTypes)
    if (query.actor) {
      clauses.push('actor = ?')
      params.push(query.actor)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM memory_audit_events ${where}
      ORDER BY row_id DESC
      LIMIT ? OFFSET ?
    `).all(
      ...params,
      boundedLimit(query.limit ?? 50, 500),
      boundedOffset(query.offset),
    ) as Row[]
    return rows.map(auditFromRow)
  }

  rebuildSearchIndex(): void {
    if (!this.ftsEnabled) return
    this.databaseManager.transaction(() => {
      this.db.exec('DELETE FROM memory_nodes_fts')
      const rows = this.db.prepare('SELECT * FROM memory_nodes').all() as Row[]
      for (const row of rows) this.syncFts(nodeFromRow(row))
    })
  }

  close(): void {
    this.databaseManager.close()
  }

  private get db(): DatabaseSync {
    return this.databaseManager.connection
  }

  private initializeFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
          node_id UNINDEXED,
          title,
          content,
          tags,
          entities
        )
      `)
      this.ftsEnabled = true
    } catch {
      this.ftsEnabled = false
    }
  }

  private writeNode(node: MemoryNode): void {
    this.db.prepare(`
      INSERT INTO memory_nodes (
        id, parent_id, supersedes_id, profile_id,
        scope_type, scope_namespace, scope_id, origin_json,
        domain, category_path_json, category_path_text, type, key, revision, value_json,
        title, content, status, confidence, importance, tags_json, entities_json,
        source_message_ids_json, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        supersedes_id = excluded.supersedes_id,
        profile_id = excluded.profile_id,
        scope_type = excluded.scope_type,
        scope_namespace = excluded.scope_namespace,
        scope_id = excluded.scope_id,
        origin_json = excluded.origin_json,
        domain = excluded.domain,
        category_path_json = excluded.category_path_json,
        category_path_text = excluded.category_path_text,
        type = excluded.type,
        key = excluded.key,
        revision = excluded.revision,
        value_json = excluded.value_json,
        title = excluded.title,
        content = excluded.content,
        status = excluded.status,
        confidence = excluded.confidence,
        importance = excluded.importance,
        tags_json = excluded.tags_json,
        entities_json = excluded.entities_json,
        source_message_ids_json = excluded.source_message_ids_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(...nodeValues(node))
    this.syncFts(node)
  }

  private syncFts(node: MemoryNode): void {
    if (!this.ftsEnabled) return
    this.db.prepare('DELETE FROM memory_nodes_fts WHERE node_id = ?').run(node.id)
    if (node.status !== 'active') return
    this.db.prepare(
      'INSERT INTO memory_nodes_fts (node_id, title, content, tags, entities) VALUES (?, ?, ?, ?, ?)',
    ).run(node.id, node.title, node.content, node.tags.join(' '), node.entities.join(' '))
  }

  private writeAudit(event: MemoryAuditEvent): void {
    this.db.prepare(`
      INSERT INTO memory_audit_events
        (id, event_type, node_id, session_id, profile_id, actor, reason, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.eventType,
      event.nodeId ?? null,
      event.sessionId ?? null,
      event.profileId,
      event.actor,
      event.reason,
      jsonOrNull(event.payload),
      event.createdAt,
    )
  }
}

function nodeValues(node: MemoryNode): SQLInputValue[] {
  const scope = memoryScopeColumns(node.scope)
  return [
    node.id,
    node.parentId ?? null,
    node.supersedesId ?? null,
    node.profileId,
    scope.type,
    scope.namespace,
    scope.id,
    jsonOrNull(node.origin),
    node.domain,
    JSON.stringify(node.categoryPath),
    categoryPathText(node.categoryPath),
    node.type,
    node.key,
    Math.max(1, Math.floor(node.revision || 1)),
    node.valueJson === undefined ? null : stableJson(node.valueJson),
    node.title,
    node.content,
    node.status,
    node.confidence,
    node.importance,
    JSON.stringify(node.tags),
    JSON.stringify(node.entities),
    JSON.stringify(node.sourceMessageIds),
    node.createdAt,
    node.updatedAt,
    node.expiresAt ?? null,
  ]
}

function messageFromRow(row: Row): MemoryMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    parentId: optionalString(row.parent_id),
    role: String(row.role) as MemoryMessage['role'],
    content: String(row.content),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at),
  }
}

function nodeFromRow(row: Row): MemoryNode {
  return {
    id: String(row.id),
    parentId: optionalString(row.parent_id),
    supersedesId: optionalString(row.supersedes_id),
    profileId: String(row.profile_id),
    scope: memoryScopeFromColumns(row.scope_type, row.scope_namespace, row.scope_id),
    origin: normalizeMemoryOrigin(parseJsonObject(row.origin_json)),
    domain: String(row.domain),
    categoryPath: parseStringArray(row.category_path_json),
    type: String(row.type) as MemoryNode['type'],
    key: String(row.key),
    revision: Math.max(1, Number(row.revision || 1)),
    valueJson: parseJsonValue(row.value_json),
    title: String(row.title),
    content: String(row.content),
    status: String(row.status) as MemoryNode['status'],
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    tags: parseStringArray(row.tags_json),
    entities: parseStringArray(row.entities_json),
    sourceMessageIds: parseStringArray(row.source_message_ids_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: optionalString(row.expires_at),
  }
}

function auditFromRow(row: Row): MemoryAuditEvent {
  return {
    id: String(row.id),
    eventType: String(row.event_type) as MemoryAuditEvent['eventType'],
    nodeId: optionalString(row.node_id),
    sessionId: optionalString(row.session_id),
    profileId: String(row.profile_id),
    actor: String(row.actor),
    reason: String(row.reason),
    payload: parseJsonObject(row.payload_json),
    createdAt: String(row.created_at),
  }
}

function auditForNode(
  eventType: MemoryAuditEvent['eventType'],
  node: MemoryNode,
  reason: string,
  actor: string,
  payload?: Record<string, unknown>,
  sessionId?: string,
): MemoryAuditEvent {
  return {
    id: randomUUID(),
    eventType,
    nodeId: node.id,
    sessionId,
    profileId: node.profileId,
    actor,
    reason,
    payload,
    createdAt: node.updatedAt,
  }
}

function categoryPathText(path: string[]): string {
  return path.map(part => part.trim()).filter(Boolean).join('/')
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isFinite(value)) return Math.min(20, maximum)
  return Math.max(1, Math.min(Math.floor(value), maximum))
}

function boundedOffset(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.floor(Number(value)))
}

function addInClause(clauses: string[], params: SQLInputValue[], column: string, values: readonly string[]): void {
  clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`)
  params.push(...values)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : stableJson(value)
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJsonValue(value)
  return Array.isArray(parsed) ? parsed.map(item => String(item)) : []
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseJsonValue(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : undefined
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : String(value)
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function memoryQueryTerms(value: string | undefined): string[] {
  const normalized = String(value || '').normalize('NFKC').toLowerCase().trim()
  if (!normalized) return []
  const words = normalized.match(/[a-z0-9_]{2,}|[\p{Script=Han}]{1,}/gu) || []
  const terms = new Set<string>()
  for (const word of words) {
    if (/^[\p{Script=Han}]+$/u.test(word) && word.length > 2) {
      for (let index = 0; index < word.length - 1; index += 1) terms.add(word.slice(index, index + 2))
    }
    terms.add(word)
    if (terms.size >= 24) break
  }
  if (!terms.size) terms.add(normalized)
  return [...terms].slice(0, 24)
}

export { stableJson }
