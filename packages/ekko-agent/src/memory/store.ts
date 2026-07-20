import { randomUUID } from 'node:crypto'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { EkkoDatabaseManager, type EkkoDatabaseMigration } from '../database'
import type {
  MemoryAuditEvent,
  MemoryMessage,
  MemoryNode,
  MemoryQuery,
  MemorySessionState,
  MemoryStore,
  MemorySummary,
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
      DROP TABLE IF EXISTS memory_session_state;
      DROP TABLE IF EXISTS memory_summaries;
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
      CREATE TABLE IF NOT EXISTS memory_summaries (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        parent_summary_id TEXT,
        from_message_id TEXT NOT NULL,
        to_message_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        current_goal TEXT,
        constraints_json TEXT NOT NULL DEFAULT '[]',
        preferences_json TEXT NOT NULL DEFAULT '[]',
        decisions_json TEXT NOT NULL DEFAULT '[]',
        completed_work_json TEXT NOT NULL DEFAULT '[]',
        pending_work_json TEXT NOT NULL DEFAULT '[]',
        known_issues_json TEXT NOT NULL DEFAULT '[]',
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
      CREATE TABLE IF NOT EXISTS memory_session_state (
        session_id TEXT PRIMARY KEY,
        last_extracted_message_id TEXT,
        last_summary_message_id TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_messages_session_created
        ON memory_messages (session_id, row_id);
      CREATE INDEX IF NOT EXISTS idx_memory_summaries_session_created
        ON memory_summaries (session_id, row_id);
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

  async listMessagesAfter(input: { sessionId: string; messageId?: string; limit?: number }): Promise<MemoryMessage[]> {
    const after = input.messageId
      ? this.db.prepare('SELECT row_id FROM memory_messages WHERE id = ? AND session_id = ?').get(input.messageId, input.sessionId) as Row | undefined
      : undefined
    const rows = this.db.prepare(`
      SELECT * FROM memory_messages
      WHERE session_id = ? AND row_id > ?
      ORDER BY row_id ASC
      LIMIT ?
    `).all(input.sessionId, Number(after?.row_id || 0), boundedLimit(input.limit ?? 100, 500)) as Row[]
    return rows.map(messageFromRow)
  }

  async appendSummary(summary: MemorySummary): Promise<void> {
    this.db.prepare(`
      INSERT INTO memory_summaries (
        id, session_id, parent_summary_id, from_message_id, to_message_id, summary,
        current_goal, constraints_json, preferences_json, decisions_json,
        completed_work_json, pending_work_json, known_issues_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      summary.id,
      summary.sessionId,
      summary.parentSummaryId ?? null,
      summary.fromMessageId,
      summary.toMessageId,
      summary.summary,
      summary.currentGoal ?? null,
      JSON.stringify(summary.constraints),
      JSON.stringify(summary.preferences),
      JSON.stringify(summary.decisions),
      JSON.stringify(summary.completedWork),
      JSON.stringify(summary.pendingWork),
      JSON.stringify(summary.knownIssues),
      summary.createdAt,
    )
  }

  async getLatestSummary(input: { sessionId: string }): Promise<MemorySummary | undefined> {
    const row = this.db.prepare(
      'SELECT * FROM memory_summaries WHERE session_id = ? ORDER BY row_id DESC LIMIT 1',
    ).get(input.sessionId) as Row | undefined
    return row ? summaryFromRow(row) : undefined
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
    if (!query.profileId) return []
    clauses.push('profile_id = ?')
    params.push(query.profileId)
    if (query.includeExpired) {
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
    if (query.queryText?.trim()) {
      const pattern = `%${escapeLike(query.queryText.trim())}%`
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags_json LIKE ? ESCAPE '\\' OR entities_json LIKE ? ESCAPE '\\')")
      params.push(pattern, pattern, pattern, pattern)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`
      SELECT * FROM memory_nodes ${where}
      ORDER BY importance DESC, confidence DESC, updated_at DESC
      LIMIT ?
    `).all(...params, boundedLimit(query.limit ?? 50, 200)) as Row[]
    let nodes = rows.map(nodeFromRow)
    if (query.tags?.length) nodes = nodes.filter(node => query.tags!.every(tag => node.tags.includes(tag)))
    if (query.entities?.length) nodes = nodes.filter(node => query.entities!.every(entity => node.entities.includes(entity)))
    return nodes
  }

  async appendAuditEvent(event: MemoryAuditEvent): Promise<void> {
    this.writeAudit(event)
  }

  async getSessionState(sessionId: string): Promise<MemorySessionState | undefined> {
    const row = this.db.prepare('SELECT * FROM memory_session_state WHERE session_id = ?').get(sessionId) as Row | undefined
    if (!row) return undefined
    return {
      sessionId: String(row.session_id),
      lastExtractedMessageId: optionalString(row.last_extracted_message_id),
      lastSummaryMessageId: optionalString(row.last_summary_message_id),
      updatedAt: String(row.updated_at),
    }
  }

  async setSessionState(state: MemorySessionState): Promise<void> {
    this.db.prepare(`
      INSERT INTO memory_session_state
        (session_id, last_extracted_message_id, last_summary_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_extracted_message_id = excluded.last_extracted_message_id,
        last_summary_message_id = excluded.last_summary_message_id,
        updated_at = excluded.updated_at
    `).run(
      state.sessionId,
      state.lastExtractedMessageId ?? null,
      state.lastSummaryMessageId ?? null,
      state.updatedAt,
    )
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
        domain, category_path_json, category_path_text, type, key, revision, value_json,
        title, content, status, confidence, importance, tags_json, entities_json,
        source_message_ids_json, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        parent_id = excluded.parent_id,
        supersedes_id = excluded.supersedes_id,
        profile_id = excluded.profile_id,
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
  return [
    node.id,
    node.parentId ?? null,
    node.supersedesId ?? null,
    node.profileId,
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

function summaryFromRow(row: Row): MemorySummary {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    parentSummaryId: optionalString(row.parent_summary_id),
    fromMessageId: String(row.from_message_id),
    toMessageId: String(row.to_message_id),
    summary: String(row.summary),
    currentGoal: optionalString(row.current_goal),
    constraints: parseStringArray(row.constraints_json),
    preferences: parseStringArray(row.preferences_json),
    decisions: parseStringArray(row.decisions_json),
    completedWork: parseStringArray(row.completed_work_json),
    pendingWork: parseStringArray(row.pending_work_json),
    knownIssues: parseStringArray(row.known_issues_json),
    createdAt: String(row.created_at),
  }
}

function nodeFromRow(row: Row): MemoryNode {
  return {
    id: String(row.id),
    parentId: optionalString(row.parent_id),
    supersedesId: optionalString(row.supersedes_id),
    profileId: String(row.profile_id),
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

export { stableJson }
