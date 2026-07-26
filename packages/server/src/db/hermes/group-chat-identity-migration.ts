import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

import {
  backfillGroupChatActors,
  validateBackfilledGroupChatActors,
} from '../../services/hermes/group-chat/identity/actor-store'
import { GROUP_CHAT_IDENTITY_READER_EPOCH } from '../../services/hermes/group-chat/identity/types'
import { assertHermesDatabaseOwnership } from '../ownership'

const SCHEMA_STATE_TABLE = 'gc_schema_state'
const SCHEMA_NAME = 'groupChatIdentityV1'
const SCHEMA_VERSION = 1
const SCHEMA_STATUS_COMPLETE = 'complete'
const SCHEMA_STATUS_PENDING = 'pending'
const ACTOR_TABLE = 'gc_room_actors'
const CAPABILITY_TABLE = 'gc_room_actor_capabilities'
const ROOM_SESSION_SEED_RE = /^[0-9A-Fa-f]{32}$/

type TransactionalDatabase = DatabaseSync & {
  readonly inTransaction?: boolean
  readonly isTransaction?: boolean
}

export type GroupChatIdentityMigrationFailpoint = 'after-backfill' | null

let groupChatIdentityMigrationFailpoint: GroupChatIdentityMigrationFailpoint = null

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(tableName))
}

function rowCount(db: DatabaseSync, tableName: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number }).count
}

function createSchemaStateTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA_STATE_TABLE} (
      schema_name TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      min_reader_epoch INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      rollback_marker TEXT NOT NULL
    )
  `)
}

function createActorTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ACTOR_TABLE} (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      actorType TEXT NOT NULL,
      authUserId INTEGER,
      agentId TEXT,
      localSubjectId TEXT,
      systemKey TEXT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      authorizationRevision INTEGER NOT NULL DEFAULT 0,
      contextRevision INTEGER NOT NULL DEFAULT 0,
      tombstonedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${CAPABILITY_TABLE} (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      actorId TEXT NOT NULL,
      capability TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
  `)
}

function createActorIndexes(db: DatabaseSync): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_gc_room_actors_room ON ${ACTOR_TABLE}(roomId);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_gc_room_actors_active_auth ON ${ACTOR_TABLE}(roomId, authUserId) WHERE active = 1 AND authUserId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_gc_room_actors_active_agent ON ${ACTOR_TABLE}(roomId, agentId) WHERE active = 1 AND agentId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_gc_room_actors_active_local ON ${ACTOR_TABLE}(roomId, localSubjectId) WHERE active = 1 AND localSubjectId IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_gc_room_actors_active_system ON ${ACTOR_TABLE}(roomId, systemKey) WHERE active = 1 AND systemKey IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_gc_room_actor_capabilities_actor ON ${CAPABILITY_TABLE}(actorId);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_gc_room_actor_capabilities_active ON ${CAPABILITY_TABLE}(roomId, actorId, capability) WHERE active = 1;
  `)
}

function appliedState(db: DatabaseSync): {
  schema_name: string
  version: number
  status: string
  min_reader_epoch: number
} | null {
  if (!tableExists(db, SCHEMA_STATE_TABLE)) {
    return null
  }
  const states = db.prepare(
    `SELECT schema_name, version, status, min_reader_epoch
     FROM ${SCHEMA_STATE_TABLE}
     ORDER BY schema_name ASC`
  ).all() as Array<{
    schema_name: string
    version: number
    status: string
    min_reader_epoch: number
  }>
  const foreign = states.find(state => state.schema_name !== SCHEMA_NAME)
  if (foreign) {
    throw new Error(
      `${SCHEMA_NAME} found foreign schema state ${foreign.schema_name} ${foreign.status}@${foreign.version}`,
    )
  }
  return states.find(state => state.schema_name === SCHEMA_NAME) ?? null
}

function assertSupportedReaderEpoch(state: { min_reader_epoch: number }): void {
  if (state.min_reader_epoch > GROUP_CHAT_IDENTITY_READER_EPOCH) {
    throw new Error(
      `${SCHEMA_NAME} minimum reader epoch ${state.min_reader_epoch} exceeds supported epoch ${GROUP_CHAT_IDENTITY_READER_EPOCH}`,
    )
  }
}

function assertSupportedRecordedState(state: { version: number; status: string; min_reader_epoch: number }): void {
  assertSupportedReaderEpoch(state)
  if (state.version !== SCHEMA_VERSION || state.status !== SCHEMA_STATUS_COMPLETE) {
    throw new Error(`${SCHEMA_NAME} found unsupported recorded state ${state.status}@${state.version}`)
  }
}

function withImmediateTransaction<T>(db: TransactionalDatabase, fn: () => T): T {
  if (db.inTransaction || db.isTransaction) {
    return fn()
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // best effort rollback
    }
    throw error
  }
}

function assertLatestMainOnly(db: DatabaseSync): void {
  if (!tableExists(db, ACTOR_TABLE) && !tableExists(db, CAPABILITY_TABLE)) {
    return
  }
  const actorRows = tableExists(db, ACTOR_TABLE) ? rowCount(db, ACTOR_TABLE) : 0
  const capabilityRows = tableExists(db, CAPABILITY_TABLE) ? rowCount(db, CAPABILITY_TABLE) : 0
  if (actorRows > 0 || capabilityRows > 0) {
    throw new Error(`${SCHEMA_NAME} refuses mixed-version group chat identity state without recorded schema success`)
  }
}

function maybeFail(stage: GroupChatIdentityMigrationFailpoint): void {
  if (groupChatIdentityMigrationFailpoint === stage) {
    throw new Error(`${SCHEMA_NAME} failpoint triggered at ${stage}`)
  }
}

function rotateLegacyRoomSessionSeeds(db: DatabaseSync): void {
  const rows = db.prepare(
    'SELECT id, sessionSeed FROM gc_rooms'
  ).all() as Array<{ id: string; sessionSeed: string | null }>
  const update = db.prepare('UPDATE gc_rooms SET sessionSeed = ? WHERE id = ?')
  for (const row of rows) {
    const sessionSeed = typeof row.sessionSeed === 'string' ? row.sessionSeed : ''
    if (sessionSeed !== '0' && sessionSeed !== '' && ROOM_SESSION_SEED_RE.test(sessionSeed)) {
      continue
    }
    update.run(randomBytes(16).toString('hex'), row.id)
  }
}

export function setGroupChatIdentityMigrationFailpointForTesting(
  failpoint: GroupChatIdentityMigrationFailpoint,
): void {
  groupChatIdentityMigrationFailpoint = failpoint
}

export function assertGroupChatIdentityReaderEpochPreflight(db: DatabaseSync): void {
  const state = appliedState(db)
  if (state) {
    assertSupportedRecordedState(state)
  }
}

export function runGroupChatIdentityV1Migration(db: DatabaseSync): void {
  assertHermesDatabaseOwnership(db)
  assertGroupChatIdentityReaderEpochPreflight(db)

  withImmediateTransaction(db as TransactionalDatabase, () => {
    const state = appliedState(db)
    if (state) {
      assertSupportedRecordedState(state)
      rotateLegacyRoomSessionSeeds(db)
      createActorIndexes(db)
      return
    }

    assertLatestMainOnly(db)

    createSchemaStateTable(db)
    createActorTables(db)
    db.prepare(
      `INSERT INTO ${SCHEMA_STATE_TABLE}
       (schema_name, version, status, min_reader_epoch, applied_at, rollback_marker)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      SCHEMA_NAME,
      SCHEMA_VERSION,
      SCHEMA_STATUS_PENDING,
      GROUP_CHAT_IDENTITY_READER_EPOCH,
      Date.now(),
      `${SCHEMA_NAME}.rollback`,
    )

    const summary = backfillGroupChatActors(db)
    rotateLegacyRoomSessionSeeds(db)
    maybeFail('after-backfill')
    validateBackfilledGroupChatActors(db, summary)
    createActorIndexes(db)

    db.prepare(
      `UPDATE ${SCHEMA_STATE_TABLE}
       SET status = ?, applied_at = ?, rollback_marker = ?
       WHERE schema_name = ?`
    ).run(
      SCHEMA_STATUS_COMPLETE,
      Date.now(),
      `${SCHEMA_NAME}.complete`,
      SCHEMA_NAME,
    )
  })
}
