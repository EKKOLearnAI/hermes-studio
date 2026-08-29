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
  MemoryReviewJob,
  MemoryReviewJobCreateInput,
  MemoryReviewJobListInput,
  MemoryReviewQueueStatus,
  MemoryReviewJobUpdateInput,
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
  migrate(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_session_state (
        session_id TEXT PRIMARY KEY,
        last_extracted_message_id TEXT,
        last_summary_message_id TEXT,
        updated_at TEXT NOT NULL
      );
      ALTER TABLE memory_session_state ADD COLUMN last_reviewed_message_id TEXT;
      UPDATE memory_session_state
      SET last_reviewed_message_id = last_extracted_message_id
      WHERE last_reviewed_message_id IS NULL;

      CREATE TABLE IF NOT EXISTS memory_review_jobs (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        through_message_id TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        request_type TEXT NOT NULL,
        request_json TEXT NOT NULL,
        preferred_provider TEXT,
        preferred_model TEXT,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        locked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_review_jobs_evidence
        ON memory_review_jobs (profile_id, session_id, through_message_id, request_type);
      CREATE INDEX IF NOT EXISTS idx_memory_review_jobs_claim
        ON memory_review_jobs (profile_id, status, next_attempt_at, row_id);
    `)
  },
}, {
  component: 'memory',
  version: 6,
  migrate(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_memory_review_jobs_evidence;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_review_jobs_evidence_request
        ON memory_review_jobs (profile_id, session_id, through_message_id, request_type, request_json);
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

  async getSessionState(sessionId: string): Promise<MemorySessionState | undefined> {
    const row = this.db.prepare('SELECT * FROM memory_session_state WHERE session_id = ?').get(sessionId) as Row | undefined
    if (!row) return undefined
    return {
      sessionId: String(row.session_id),
      lastExtractedMessageId: optionalString(row.last_extracted_message_id),
      lastReviewedMessageId: optionalString(row.last_reviewed_message_id)
        || optionalString(row.last_extracted_message_id),
      lastSummaryMessageId: optionalString(row.last_summary_message_id),
      updatedAt: String(row.updated_at),
    }
  }

  async setSessionState(state: MemorySessionState): Promise<void> {
    this.db.prepare(`
      INSERT INTO memory_session_state
        (session_id, last_extracted_message_id, last_reviewed_message_id, last_summary_message_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        last_extracted_message_id = COALESCE(excluded.last_extracted_message_id, memory_session_state.last_extracted_message_id),
        last_reviewed_message_id = COALESCE(excluded.last_reviewed_message_id, memory_session_state.last_reviewed_message_id),
        last_summary_message_id = COALESCE(excluded.last_summary_message_id, memory_session_state.last_summary_message_id),
        updated_at = CASE
          WHEN excluded.updated_at > memory_session_state.updated_at THEN excluded.updated_at
          ELSE memory_session_state.updated_at
        END
    `).run(
      state.sessionId,
      state.lastExtractedMessageId ?? state.lastReviewedMessageId ?? null,
      state.lastReviewedMessageId ?? state.lastExtractedMessageId ?? null,
      state.lastSummaryMessageId ?? null,
      state.updatedAt,
    )
  }

  async enqueueReviewJob(input: MemoryReviewJobCreateInput): Promise<MemoryReviewJob> {
    this.databaseManager.transaction(() => {
      const evidence = this.db.prepare(
        'SELECT 1 AS present FROM memory_messages WHERE id = ? AND session_id = ?',
      ).get(input.throughMessageId, input.sessionId) as Row | undefined
      if (!evidence) throw new Error(`Memory review evidence was not captured: ${input.throughMessageId}`)
      this.db.prepare(`
        INSERT OR IGNORE INTO memory_review_jobs (
          id, profile_id, session_id, through_message_id, identity_json,
          request_type, request_json, preferred_provider, preferred_model,
          status, attempt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        input.id,
        input.profileId,
        input.sessionId,
        input.throughMessageId,
        stableJson(input.identity),
        input.request.trigger,
        stableJson(input.request),
        input.preferredProvider ?? null,
        input.preferredModel ?? null,
        input.createdAt,
        input.createdAt,
      )
    })
    const row = this.db.prepare('SELECT * FROM memory_review_jobs WHERE id = ?').get(input.id) as Row | undefined
      || this.db.prepare(`
        SELECT * FROM memory_review_jobs
        WHERE profile_id = ? AND session_id = ? AND through_message_id = ?
          AND request_type = ? AND request_json = ?
      `).get(
        input.profileId,
        input.sessionId,
        input.throughMessageId,
        input.request.trigger,
        stableJson(input.request),
      ) as Row | undefined
    if (!row) throw new Error(`Memory review job was not persisted: ${input.id}`)
    return reviewJobFromRow(row)
  }

  async getReviewJob(id: string): Promise<MemoryReviewJob | undefined> {
    const row = this.db.prepare('SELECT * FROM memory_review_jobs WHERE id = ?').get(id) as Row | undefined
    return row ? reviewJobFromRow(row) : undefined
  }

  async listReviewJobs(input: MemoryReviewJobListInput): Promise<MemoryReviewJob[]> {
    const clauses = ['profile_id = ?']
    const params: SQLInputValue[] = [input.profileId]
    if (input.statuses?.length) addInClause(clauses, params, 'status', input.statuses)
    const rows = this.db.prepare(`
      SELECT * FROM memory_review_jobs
      WHERE ${clauses.join(' AND ')}
      ORDER BY row_id DESC
      LIMIT ? OFFSET ?
    `).all(
      ...params,
      boundedLimit(input.limit ?? 100, 500),
      boundedOffset(input.offset),
    ) as Row[]
    return rows.map(reviewJobFromRow)
  }

  async activateReviewJob(input: {
    id: string
    profileId: string
    now: string
    confirmedByUser?: boolean
  }): Promise<MemoryReviewJob | undefined> {
    this.databaseManager.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM memory_review_jobs WHERE id = ? AND profile_id = ?
      `).get(input.id, input.profileId) as Row | undefined
      if (!row || String(row.status) === 'completed' || String(row.status) === 'running') return
      const request = reviewJobFromRow(row).request
      const nextRequest = input.confirmedByUser
        ? {
            ...request,
            userConfirmed: true,
            ...(request.forget ? { forget: { ...request.forget, confirmed: true } } : {}),
          }
        : request
      this.db.prepare(`
        UPDATE memory_review_jobs
        SET request_json = ?, status = 'pending', next_attempt_at = NULL,
            locked_at = NULL, last_error = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ? AND profile_id = ? AND status <> 'completed' AND status <> 'running'
      `).run(stableJson(nextRequest), input.now, input.id, input.profileId)
    })
    return this.getReviewJob(input.id).then(job => job?.profileId === input.profileId ? job : undefined)
  }

  async claimNextReviewJob(input: {
    profileId: string
    now: string
    staleBefore: string
  }): Promise<MemoryReviewJob | undefined> {
    let claimed: MemoryReviewJob | undefined
    this.databaseManager.transaction(() => {
      this.db.prepare(`
        UPDATE memory_review_jobs
        SET status = 'retry', locked_at = NULL, next_attempt_at = ?,
            last_error = COALESCE(last_error, 'Reviewer lease expired.'), updated_at = ?
        WHERE profile_id = ? AND status = 'running' AND locked_at < ?
      `).run(input.now, input.now, input.profileId, input.staleBefore)
      const row = this.db.prepare(`
        SELECT * FROM memory_review_jobs
        WHERE profile_id = ?
          AND status IN ('pending', 'retry', 'waiting_for_model')
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY CASE request_type WHEN 'forget' THEN 0 WHEN 'review' THEN 1 ELSE 2 END, row_id ASC
        LIMIT 1
      `).get(input.profileId, input.now) as Row | undefined
      if (!row) return
      const changed = this.db.prepare(`
        UPDATE memory_review_jobs
        SET status = 'running', attempt = attempt + 1, locked_at = ?,
            next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'retry', 'waiting_for_model')
      `).run(input.now, input.now, String(row.id))
      if (Number(changed.changes) !== 1) return
      const current = this.db.prepare('SELECT * FROM memory_review_jobs WHERE id = ?')
        .get(String(row.id)) as Row | undefined
      if (current) claimed = reviewJobFromRow(current)
    })
    return claimed
  }

  async updateReviewJob(id: string, input: MemoryReviewJobUpdateInput): Promise<void> {
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE memory_review_jobs
      SET status = ?, next_attempt_at = ?, locked_at = ?, last_error = ?,
          completed_at = ?, updated_at = ?,
          attempt = attempt + ?
      WHERE id = ?
    `).run(
      input.status,
      input.nextAttemptAt ?? null,
      input.lockedAt ?? null,
      input.lastError ?? null,
      input.completedAt ?? null,
      now,
      input.incrementAttempt ? 1 : 0,
      id,
    )
  }

  async requeueStaleReviewJobs(input: {
    profileId?: string
    now: string
    staleBefore: string
  }): Promise<number> {
    const profileClause = input.profileId ? ' AND profile_id = ?' : ''
    const params: SQLInputValue[] = [input.now, input.now, input.staleBefore]
    if (input.profileId) params.push(input.profileId)
    const result = this.db.prepare(`
      UPDATE memory_review_jobs
      SET status = 'retry', locked_at = NULL, next_attempt_at = ?,
          last_error = 'Reviewer lease expired before completion.', updated_at = ?
      WHERE status = 'running' AND locked_at < ?${profileClause}
    `).run(...params)
    return Number(result.changes)
  }

  async activateReviewJobs(input: { profileId?: string; now: string }): Promise<void> {
    const profileClause = input.profileId ? ' AND profile_id = ?' : ''
    const params: SQLInputValue[] = [input.now, input.now]
    if (input.profileId) params.push(input.profileId)
    this.db.prepare(`
      UPDATE memory_review_jobs
      SET next_attempt_at = ?, updated_at = ?
      WHERE status IN ('retry', 'waiting_for_model')${profileClause}
    `).run(...params)
  }

  async listPendingReviewProfiles(input: { now: string; staleBefore: string }): Promise<string[]> {
    const rows = this.db.prepare(`
      SELECT DISTINCT profile_id FROM memory_review_jobs
      WHERE (status IN ('pending', 'retry', 'waiting_for_model')
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
         OR (status = 'running' AND locked_at < ?)
      ORDER BY profile_id
    `).all(input.now, input.staleBefore) as Row[]
    return rows.map(row => String(row.profile_id))
  }

  async getReviewQueueStatus(profileId: string): Promise<MemoryReviewQueueStatus> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count, MAX(completed_at) AS latest_completed_at
      FROM memory_review_jobs
      WHERE profile_id = ?
      GROUP BY status
    `).all(profileId) as Row[]
    const counts = new Map(rows.map(row => [String(row.status), Number(row.count || 0)]))
    const pending = counts.get('pending') || 0
    const running = counts.get('running') || 0
    const retry = counts.get('retry') || 0
    const waitingForModel = counts.get('waiting_for_model') || 0
    const needsConfirmation = counts.get('needs_confirmation') || 0
    const latestCompletedAt = rows
      .map(row => optionalString(row.latest_completed_at))
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1)
    const activelyReviewingJobs = pending + running + retry
    const activeJobs = activelyReviewingJobs + waitingForModel
    return {
      reviewing: activelyReviewingJobs > 0,
      activeJobs,
      pending,
      running,
      retry,
      waitingForModel,
      needsConfirmation,
      latestCompletedAt,
    }
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

function reviewJobFromRow(row: Row): MemoryReviewJob {
  const identity = parseJsonObject(row.identity_json)
  const request = parseJsonObject(row.request_json)
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    sessionId: String(row.session_id),
    throughMessageId: String(row.through_message_id),
    identity: {
      sessionId: String(identity?.sessionId || row.session_id),
      profileId: optionalString(identity?.profileId) || String(row.profile_id),
      origin: normalizeMemoryOrigin(identity?.origin),
      recallScopes: Array.isArray(identity?.recallScopes)
        ? identity.recallScopes as MemoryReviewJob['identity']['recallScopes']
        : undefined,
      writeScopes: Array.isArray(identity?.writeScopes)
        ? identity.writeScopes as MemoryReviewJob['identity']['writeScopes']
        : undefined,
      defaultWriteScope: identity?.defaultWriteScope as MemoryReviewJob['identity']['defaultWriteScope'],
    },
    request: {
      trigger: String(request?.trigger || row.request_type) as MemoryReviewJob['request']['trigger'],
      forget: request?.forget as MemoryReviewJob['request']['forget'],
      userConfirmed: request?.userConfirmed === true || undefined,
    },
    preferredProvider: optionalString(row.preferred_provider),
    preferredModel: optionalString(row.preferred_model),
    status: String(row.status) as MemoryReviewJob['status'],
    attempt: Math.max(0, Number(row.attempt || 0)),
    nextAttemptAt: optionalString(row.next_attempt_at),
    lockedAt: optionalString(row.locked_at),
    lastError: optionalString(row.last_error),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    completedAt: optionalString(row.completed_at),
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
