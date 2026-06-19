import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { getProfileDir } from './hermes-profile'

const SCHEMA_VERSION = 1

export type PersonalRiskLevel = 'low' | 'medium' | 'high'
export type PersonalProposalStatus = 'pending' | 'approved' | 'rejected'

export interface PersonalProposal {
  id: string
  title: string
  summary: string
  riskLevel: PersonalRiskLevel
  status: PersonalProposalStatus
  proposedAction: { type: string; payload: Record<string, unknown> }
  targetRecordIds: string[]
  provenance: {
    source: string
    confidence: number
    evidence: Array<Record<string, unknown>>
    confirmationState: string
    actor: string
    createdAt: string
    updatedAt: string
    reviewedBy: string | null
    reviewedAt: string | null
  }
}

export interface PersonalTask {
  kind: 'task'
  id: string
  title: string
  summary: string
  notes: string
  status: string
  sourceProposalId: string | null
  provenance: {
    source: string
    confidence: number
    evidence: Array<Record<string, unknown>>
    confirmationState: string
    actor: string
    createdAt: string
    updatedAt: string
  }
}

export interface PersonalMemoryContext {
  id: string
  generatedAt: string
  profile: string
  query: string | null
  summary: string
  relevantRecordIds: string[]
  contextBlocks: Array<Record<string, unknown>>
}

export interface PersonalStateOverview {
  generatedAt: string
  profile: string
  query: string | null
  proposals: PersonalProposal[]
  tasks: PersonalTask[]
  pendingProposals: PersonalProposal[]
  memoryContext: PersonalMemoryContext
}

interface ProposalRow {
  id: string
  title: string
  summary: string
  risk_level: string
  status: string
  proposed_action_json: string
  target_record_ids_json: string
  evidence_json: string
  source: string
  confidence: number
  confirmation_state: string
  actor: string
  created_at: string
  updated_at: string
  reviewed_by: string | null
  reviewed_at: string | null
}

interface TaskRow {
  id: string
  title: string
  notes: string
  status: string
  source_proposal_id: string | null
  source: string
  confidence: number
  evidence_json: string
  confirmation_state: string
  actor: string
  created_at: string
  updated_at: string
}

export interface ProposePersonalStateInput {
  title: string
  summary: string
  riskLevel?: PersonalRiskLevel
  proposedAction: { type: string; payload: Record<string, unknown> }
  targetRecordIds?: string[]
  evidence?: Array<Record<string, unknown>>
  actor?: string
  source?: string
  confidence?: number
  profile?: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function jsonString(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function profileName(profile?: string): string {
  return profile?.trim() || 'default'
}

export function getPersonalStateDbPath(profile?: string): string {
  return join(getProfileDir(profileName(profile)), 'personal_state.db')
}

function openPersonalStateDb(profile?: string): DatabaseSync {
  const dbPath = getPersonalStateDbPath(profile)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  initPersonalStateDb(db)
  return db
}

function initPersonalStateDb(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS personal_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS personal_proposals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      status TEXT NOT NULL,
      proposed_action_json TEXT NOT NULL,
      target_record_ids_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      confirmation_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS personal_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL,
      status TEXT NOT NULL,
      source_proposal_id TEXT,
      source TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      confirmation_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(source_proposal_id) REFERENCES personal_proposals(id)
    );
  `)
  db.prepare(`
    INSERT INTO personal_meta(key, value)
    VALUES('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(String(SCHEMA_VERSION))
}

export function proposePersonalStateChange(input: ProposePersonalStateInput): PersonalProposal {
  const db = openPersonalStateDb(input.profile)
  try {
    const id = `proposal-${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const createdAt = nowIso()
    db.prepare(`
      INSERT INTO personal_proposals (
        id, title, summary, risk_level, status, proposed_action_json,
        target_record_ids_json, evidence_json, source, confidence,
        confirmation_state, actor, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    `).run(
      id,
      input.title,
      input.summary,
      input.riskLevel || 'medium',
      jsonString(input.proposedAction),
      jsonString(input.targetRecordIds || []),
      jsonString(input.evidence || []),
      input.source || 'hermes',
      input.confidence ?? 1,
      input.actor || 'hermes',
      createdAt,
      createdAt,
    )
    return getPersonalStateProposal(id, input.profile)
  } finally {
    db.close()
  }
}

export function getPersonalStateProposal(id: string, profile?: string): PersonalProposal {
  const db = openPersonalStateDb(profile)
  try {
    const row = db.prepare('SELECT * FROM personal_proposals WHERE id = ?').get(id) as ProposalRow | undefined
    if (!row) throw new Error(`Personal State proposal not found: ${id}`)
    return rowToProposal(row)
  } finally {
    db.close()
  }
}

export function approvePersonalStateProposal(id: string, actor = 'user', profile?: string): PersonalProposal {
  return reviewPersonalStateProposal(id, true, actor, profile)
}

export function rejectPersonalStateProposal(id: string, actor = 'user', profile?: string): PersonalProposal {
  return reviewPersonalStateProposal(id, false, actor, profile)
}

function reviewPersonalStateProposal(id: string, approved: boolean, actor: string, profile?: string): PersonalProposal {
  const db = openPersonalStateDb(profile)
  try {
    const reviewedAt = nowIso()
    const status = approved ? 'approved' : 'rejected'
    const confirmationState = approved ? 'confirmed' : 'rejected'
    const result = db.prepare(`
      UPDATE personal_proposals
      SET status = ?,
          confirmation_state = ?,
          reviewed_by = ?,
          reviewed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, confirmationState, actor, reviewedAt, reviewedAt, id)
    if (result.changes === 0) throw new Error(`Personal State proposal not found: ${id}`)

    if (approved) {
      const row = db.prepare('SELECT * FROM personal_proposals WHERE id = ?').get(id) as ProposalRow | undefined
      if (row) applyApprovedProposal(db, row, actor, reviewedAt)
    }

    const row = db.prepare('SELECT * FROM personal_proposals WHERE id = ?').get(id) as ProposalRow | undefined
    if (!row) throw new Error(`Personal State proposal not found: ${id}`)
    return rowToProposal(row)
  } finally {
    db.close()
  }
}

export function checkInPersonalStateTask(id: string, actor = 'user', profile?: string): PersonalTask {
  const db = openPersonalStateDb(profile)
  try {
    const updatedAt = nowIso()
    const result = db.prepare(`
      UPDATE personal_tasks
      SET status = 'done',
          actor = ?,
          updated_at = ?
      WHERE id = ?
    `).run(actor, updatedAt, id)
    if (result.changes === 0) throw new Error(`Personal State task not found: ${id}`)
    const row = db.prepare('SELECT * FROM personal_tasks WHERE id = ?').get(id) as TaskRow | undefined
    if (!row) throw new Error(`Personal State task not found: ${id}`)
    return rowToTask(row)
  } finally {
    db.close()
  }
}

export function getPersonalStateOverview(options: { profile?: string; query?: string; limit?: number } | string = {}): PersonalStateOverview {
  const opts = typeof options === 'string' ? { profile: options } : options
  const profile = profileName(opts.profile)
  const limit = opts.limit || 20
  const db = openPersonalStateDb(profile)
  try {
    const proposals = (db.prepare(`
      SELECT * FROM personal_proposals
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(limit) as unknown as ProposalRow[]).map(rowToProposal)
    const tasks = (db.prepare(`
      SELECT * FROM personal_tasks
      ORDER BY datetime(created_at) DESC, id DESC
      LIMIT ?
    `).all(limit) as unknown as TaskRow[]).map(rowToTask)
    const pendingProposals = proposals.filter(proposal => proposal.status === 'pending')
    return {
      generatedAt: nowIso(),
      profile,
      query: opts.query || null,
      proposals,
      tasks,
      pendingProposals,
      memoryContext: buildMemoryContext(profile, tasks, proposals, pendingProposals, opts.query || null),
    }
  } finally {
    db.close()
  }
}

function applyApprovedProposal(db: DatabaseSync, row: ProposalRow, actor: string, reviewedAt: string): void {
  const action = parseJson<{ type?: string; payload?: Record<string, unknown> }>(row.proposed_action_json, {})
  if (action.type !== 'task.create') return

  const payload = action.payload && typeof action.payload === 'object' ? action.payload : {}
  const title = String(payload.title || row.title).trim()
  if (!title) return

  const taskId = String(payload.id || `task-${row.id}`)
  const notes = String(payload.notes || row.summary)
  const status = String(payload.status || 'open')
  db.prepare(`
    INSERT INTO personal_tasks (
      id, title, notes, status, source_proposal_id, source, confidence,
      evidence_json, confirmation_state, actor, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      notes=excluded.notes,
      status=excluded.status,
      updated_at=excluded.updated_at
  `).run(
    taskId,
    title,
    notes,
    status,
    row.id,
    row.source,
    row.confidence,
    row.evidence_json,
    actor,
    reviewedAt,
    reviewedAt,
  )
}

function buildMemoryContext(
  profile: string,
  tasks: PersonalTask[],
  proposals: PersonalProposal[],
  pendingProposals: PersonalProposal[],
  query: string | null,
): PersonalMemoryContext {
  const relevant = pendingProposals.length > 0 ? pendingProposals : tasks.length > 0 ? tasks : proposals
  const summary = relevant.length > 0
    ? relevant.slice(0, 5).map(record => record.summary).join('; ')
    : 'No Personal State records have been recorded yet.'
  return {
    id: `personal-context-${Date.now()}`,
    generatedAt: nowIso(),
    profile,
    query,
    summary,
    relevantRecordIds: relevant.map(record => record.id),
    contextBlocks: relevant.slice(0, 5).map(contextBlock),
  }
}

function contextBlock(record: PersonalTask | PersonalProposal): Record<string, unknown> {
  if ('kind' in record && record.kind === 'task') {
    return {
      kind: 'task',
      id: record.id,
      title: record.title,
      status: record.status,
      summary: record.summary,
      targetRecordIds: [record.id],
    }
  }
  const proposal = record as PersonalProposal
  return {
    kind: 'proposal',
    id: proposal.id,
    title: proposal.title,
    status: proposal.status,
    summary: proposal.summary,
    targetRecordIds: proposal.targetRecordIds,
  }
}

function rowToProposal(row: ProposalRow): PersonalProposal {
  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    riskLevel: row.risk_level as PersonalRiskLevel,
    status: row.status as PersonalProposalStatus,
    proposedAction: parseJson(row.proposed_action_json, { type: 'unknown', payload: {} }),
    targetRecordIds: parseJson(row.target_record_ids_json, []),
    provenance: {
      source: row.source,
      confidence: row.confidence,
      evidence: parseJson(row.evidence_json, []),
      confirmationState: row.confirmation_state,
      actor: row.actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
    },
  }
}

function rowToTask(row: TaskRow): PersonalTask {
  return {
    kind: 'task',
    id: row.id,
    title: row.title,
    summary: row.notes,
    notes: row.notes,
    status: row.status,
    sourceProposalId: row.source_proposal_id,
    provenance: {
      source: row.source,
      confidence: row.confidence,
      evidence: parseJson(row.evidence_json, []),
      confirmationState: row.confirmation_state,
      actor: row.actor,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  }
}
