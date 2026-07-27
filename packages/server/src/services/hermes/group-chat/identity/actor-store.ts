import type { DatabaseSync } from 'node:sqlite'

import {
  AGENT_GROUP_CHAT_CAPABILITIES,
  isSupportedGroupChatCapability,
  LOCAL_GROUP_CHAT_CAPABILITIES,
  normalizeGroupChatCapabilities,
  SYSTEM_GROUP_CHAT_CAPABILITIES,
  type GroupChatCapability,
} from './capability-policy'
import {
  createDeterministicGroupActorCapabilityId,
  createDeterministicGroupActorId,
  createDeterministicLocalSubjectId,
  createGroupActorCapabilityId,
  createGroupActorId,
} from './actor-ids'
import type {
  EnsureAgentActorInput,
  EnsureAuthenticatedHumanActorInput,
  EnsureLocalActorInput,
  EnsureSystemActorInput,
  GroupActor,
  GroupActorMetadata,
  GroupActorType,
} from './types'
import {
  verifyAgentActorInput,
  verifyAuthenticatedHumanActorInput,
  verifyLocalActorInput,
  verifySystemActorInput,
} from './types'

const ACTOR_TABLE = 'gc_room_actors'
const CAPABILITY_TABLE = 'gc_room_actor_capabilities'
const DELETED_AGENT_NAME = 'Deleted agent'

type TransactionalDatabase = DatabaseSync & {
  readonly inTransaction?: boolean
  readonly isTransaction?: boolean
}

type ActorInsertSeed = {
  roomId: string
  actorType: GroupActorType
  authUserId: number | null
  agentId: string | null
  localSubjectId: string | null
  systemKey: string | null
  metadata: GroupActorMetadata
  id?: string
  createdAt?: number
  updatedAt?: number
}

type EnsureActorSeed = {
  roomId: string
  actorType: GroupActorType
  metadata: GroupActorMetadata
  capabilities: readonly string[]
  replaceExistingCapabilities?: boolean
  findExisting: () => GroupActor | null
  insertSeed: Omit<ActorInsertSeed, 'metadata'>
}

type LegacyActorSource = {
  roomId: string
  actorType: GroupActorType
  authUserId: number | null
  agentId: string | null
  localSubjectId: string | null
  systemKey: string | null
  name: string
  description: string
  avatar: string
  stableSourceKey: string
  createdAt: number
  capabilities: readonly GroupChatCapability[]
}

export interface GroupChatActorBackfillSummary {
  actorCount: number
  capabilityCount: number
}

const ACTOR_SELECT = `
  SELECT id, roomId, actorType, authUserId, agentId, localSubjectId, systemKey,
         name, description, avatar, active, authorizationRevision, contextRevision,
         tombstonedAt, createdAt, updatedAt
  FROM ${ACTOR_TABLE}
`

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint/i.test(error.message)
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

function findActorById(db: DatabaseSync, actorId: string): GroupActor | null {
  return (db.prepare(`${ACTOR_SELECT} WHERE id = ?`).get(actorId) as GroupActor | undefined) ?? null
}

function updateActorMetadata(db: DatabaseSync, actorId: string, metadata: GroupActorMetadata, updatedAt: number): void {
  db.prepare(
    `UPDATE ${ACTOR_TABLE}
     SET name = ?, description = ?, avatar = ?, updatedAt = ?
     WHERE id = ?`
  ).run(metadata.name, metadata.description, metadata.avatar, updatedAt, actorId)
}

function replaceActorCapabilities(
  db: DatabaseSync,
  roomId: string,
  actorId: string,
  capabilities: readonly string[],
): { capabilities: GroupChatCapability[]; changed: boolean } {
  const normalized = normalizeGroupChatCapabilities(capabilities)
  const current = getActorCapabilities(db, actorId)
  const changed = current.length !== normalized.length
    || current.some((capability, index) => capability !== normalized[index])
  if (!changed) {
    return { capabilities: normalized, changed: false }
  }
  db.prepare(`DELETE FROM ${CAPABILITY_TABLE} WHERE actorId = ?`).run(actorId)
  if (!normalized.length) {
    return { capabilities: normalized, changed: true }
  }
  const now = Date.now()
  const insert = db.prepare(
    `INSERT INTO ${CAPABILITY_TABLE}
     (id, roomId, actorId, capability, active, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  )
  for (const capability of normalized) {
    insert.run(createGroupActorCapabilityId(), roomId, actorId, capability, now, now)
  }
  return { capabilities: normalized, changed: true }
}

function insertActor(db: DatabaseSync, seed: ActorInsertSeed): GroupActor {
  const now = seed.updatedAt ?? seed.createdAt ?? Date.now()
  const createdAt = seed.createdAt ?? now
  const id = seed.id ?? createGroupActorId()
  db.prepare(
    `INSERT INTO ${ACTOR_TABLE}
     (id, roomId, actorType, authUserId, agentId, localSubjectId, systemKey, name, description, avatar, active, authorizationRevision, contextRevision, tombstonedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, NULL, ?, ?)`
  ).run(
    id,
    seed.roomId,
    seed.actorType,
    seed.authUserId,
    seed.agentId,
    seed.localSubjectId,
    seed.systemKey,
    seed.metadata.name,
    seed.metadata.description,
    seed.metadata.avatar,
    createdAt,
    now,
  )
  const actor = findActorById(db, id)
  if (!actor) {
    throw new Error(`failed to read back actor ${id}`)
  }
  return actor
}

function ensureActor(db: DatabaseSync, seed: EnsureActorSeed): GroupActor {
  return withImmediateTransaction(db as TransactionalDatabase, () => {
    const updatedAt = Date.now()
    let actor = seed.findExisting()
    let createdActor = false
    if (!actor) {
      try {
        actor = insertActor(db, {
          ...seed.insertSeed,
          roomId: seed.roomId,
          actorType: seed.actorType,
          metadata: seed.metadata,
          createdAt: updatedAt,
          updatedAt,
        })
        createdActor = true
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error
        }
        actor = seed.findExisting()
        if (!actor) {
          throw error
        }
      }
    }
    const metadataChanged = actor.name !== seed.metadata.name
      || actor.description !== seed.metadata.description
      || actor.avatar !== seed.metadata.avatar
    updateActorMetadata(db, actor.id, seed.metadata, updatedAt)
    const capabilityReplacement = createdActor || seed.replaceExistingCapabilities
      ? replaceActorCapabilities(db, seed.roomId, actor.id, seed.capabilities)
      : { capabilities: getActorCapabilities(db, actor.id), changed: false }
    if (!createdActor && (metadataChanged || capabilityReplacement.changed)) {
      db.prepare(
        `UPDATE ${ACTOR_TABLE}
         SET authorizationRevision = authorizationRevision + ?,
             contextRevision = contextRevision + ?,
             updatedAt = ?
         WHERE id = ?`
      ).run(capabilityReplacement.changed ? 1 : 0, metadataChanged ? 1 : 0, updatedAt, actor.id)
    }
    const refreshed = findActorById(db, actor.id)
    if (!refreshed) {
      throw new Error(`failed to refresh actor ${actor.id}`)
    }
    return refreshed
  })
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function assertLegacyRoomReferences(db: DatabaseSync, tableName: 'gc_room_agents' | 'gc_room_members'): void {
  const count = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${tableName} source
     LEFT JOIN gc_rooms room ON room.id = source.roomId
     WHERE room.id IS NULL`
  ).get() as { count: number }).count
  if (count !== 0) {
    throw new Error(`groupChatIdentityV1 found ${count} ${tableName} rows referencing unknown rooms`)
  }
}

function canonicalLegacySources(db: DatabaseSync): LegacyActorSource[] {
  assertLegacyRoomReferences(db, 'gc_room_agents')
  assertLegacyRoomReferences(db, 'gc_room_members')

  const canonical = new Map<string, LegacyActorSource>()
  const agentCreatedAtColumn = tableHasColumn(db, 'gc_room_agents', 'createdAt') ? 'createdAt' : '0'
  const agentRows = db.prepare(
    `SELECT id, roomId, agentId, profile, name, description, ${agentCreatedAtColumn} AS createdAt
     FROM gc_room_agents
     ORDER BY createdAt ASC, id ASC`
  ).all() as Array<{
    id: string
    roomId: string
    agentId: string
    profile: string
    name: string
    description: string
    createdAt: number
  }>
  const canonicalAgentKeys = new Set<string>()

  for (const row of agentRows) {
    const canonicalCreatedAt = Number.isFinite(row.createdAt) && row.createdAt > 0
      ? Math.floor(row.createdAt)
      : 0
    const agentId = String(row.agentId || '').trim()
    if (!agentId) {
      throw new Error(`groupChatIdentityV1 invalid agent identity shape for room ${row.roomId}`)
    }
    const key = `${row.roomId}::agent::${row.agentId}`
    if (canonical.has(key)) {
      continue
    }
    canonicalAgentKeys.add(`${row.roomId}::${row.agentId}`)
    canonical.set(key, {
      roomId: row.roomId,
      actorType: 'agent',
      authUserId: null,
      agentId: row.agentId,
      localSubjectId: null,
      systemKey: null,
      name: row.name,
      description: row.description,
      avatar: '',
      stableSourceKey: `legacy-agent:${row.id}`,
      createdAt: canonicalCreatedAt,
      capabilities: AGENT_GROUP_CHAT_CAPABILITIES,
    })
  }

  const memberRows = db.prepare(
    `SELECT id, roomId, userId, userName, description, avatar, authUserId, joinedAt
     FROM gc_room_members
     ORDER BY joinedAt ASC, id ASC`
  ).all() as Array<{
    id: string
    roomId: string
    userId: string
    userName: string
    description: string
    avatar: string
    authUserId: number | null
    joinedAt: number
  }>

  for (const row of memberRows) {
    if (canonicalAgentKeys.has(`${row.roomId}::${row.userId}`)) {
      continue
    }
    if (typeof row.authUserId === 'number' && row.authUserId > 0) {
      const key = `${row.roomId}::auth::${row.authUserId}`
      if (canonical.has(key)) {
        continue
      }
      canonical.set(key, {
        roomId: row.roomId,
        actorType: 'authenticated_human',
        authUserId: row.authUserId,
        agentId: null,
        localSubjectId: null,
        systemKey: null,
        name: row.userName,
        description: row.description,
        avatar: row.avatar,
        stableSourceKey: `legacy-auth:${row.id}`,
        createdAt: row.joinedAt > 0 ? row.joinedAt : 0,
        capabilities: ['room.read'],
      })
      continue
    }
    const legacyRoutingUserId = String(row.userId || '').trim()
    if (!legacyRoutingUserId) {
      throw new Error(`groupChatIdentityV1 invalid local member identity shape for room ${row.roomId}`)
    }
    const key = `${row.roomId}::local::${row.userId}`
    if (canonical.has(key)) {
      continue
    }
    const stableSourceKey = `legacy-local:${row.id}`
    canonical.set(key, {
      roomId: row.roomId,
      actorType: 'local',
      authUserId: null,
      agentId: null,
      localSubjectId: createDeterministicLocalSubjectId(row.roomId, stableSourceKey),
      systemKey: null,
      name: row.userName,
      description: row.description,
      avatar: row.avatar,
      stableSourceKey,
      createdAt: row.joinedAt > 0 ? row.joinedAt : 0,
      capabilities: LOCAL_GROUP_CHAT_CAPABILITIES,
    })
  }

  return [...canonical.values()]
}

export function findActiveActorByAuthUserId(db: DatabaseSync, roomId: string, authUserId: number): GroupActor | null {
  return (db.prepare(
    `${ACTOR_SELECT}
     WHERE roomId = ? AND authUserId = ? AND active = 1
     ORDER BY createdAt DESC
     LIMIT 1`
  ).get(roomId, authUserId) as GroupActor | undefined) ?? null
}

export function findActiveActorByAgentIdentity(db: DatabaseSync, roomId: string, agentId: string): GroupActor | null {
  return (db.prepare(
    `${ACTOR_SELECT}
     WHERE roomId = ? AND agentId = ? AND active = 1
     ORDER BY createdAt DESC
     LIMIT 1`
  ).get(roomId, agentId) as GroupActor | undefined) ?? null
}

export function findActiveActorByLocalSubjectId(db: DatabaseSync, roomId: string, localSubjectId: string): GroupActor | null {
  return (db.prepare(
    `${ACTOR_SELECT}
     WHERE roomId = ? AND localSubjectId = ? AND active = 1
     ORDER BY createdAt DESC
     LIMIT 1`
  ).get(roomId, localSubjectId) as GroupActor | undefined) ?? null
}

export function findActiveActorBySystemKey(db: DatabaseSync, roomId: string, systemKey: string): GroupActor | null {
  return (db.prepare(
    `${ACTOR_SELECT}
     WHERE roomId = ? AND systemKey = ? AND active = 1
     ORDER BY createdAt DESC
     LIMIT 1`
  ).get(roomId, systemKey) as GroupActor | undefined) ?? null
}

export function getActorCapabilities(db: DatabaseSync, actorId: string): GroupChatCapability[] {
  const rows = db.prepare(
    `SELECT capability
     FROM ${CAPABILITY_TABLE}
     WHERE actorId = ? AND active = 1
     ORDER BY capability`
  ).all(actorId) as Array<{ capability: string }>
  return normalizeGroupChatCapabilities(rows.map((row) => row.capability))
}

export function ensureAuthenticatedHumanActor(
  db: DatabaseSync,
  input: EnsureAuthenticatedHumanActorInput,
): GroupActor {
  const verified = verifyAuthenticatedHumanActorInput(input)
  return ensureActor(db, {
    roomId: verified.roomId,
    actorType: 'authenticated_human',
    metadata: {
      name: verified.userName,
      description: verified.description,
      avatar: verified.avatar,
    },
    capabilities: verified.capabilities ?? [],
    replaceExistingCapabilities: input.capabilities !== undefined,
    findExisting: () => findActiveActorByAuthUserId(db, verified.roomId, verified.authUserId),
    insertSeed: {
      roomId: verified.roomId,
      actorType: 'authenticated_human',
      authUserId: verified.authUserId,
      agentId: null,
      localSubjectId: null,
      systemKey: null,
    },
  })
}

export function ensureLocalActor(db: DatabaseSync, input: EnsureLocalActorInput): GroupActor {
  const verified = verifyLocalActorInput(input)
  return ensureActor(db, {
    roomId: verified.roomId,
    actorType: 'local',
    metadata: {
      name: verified.userName,
      description: verified.description,
      avatar: verified.avatar,
    },
    capabilities: LOCAL_GROUP_CHAT_CAPABILITIES,
    replaceExistingCapabilities: verified.grantDefaultCapabilities === true,
    findExisting: () => findActiveActorByLocalSubjectId(db, verified.roomId, verified.localSubjectId),
    insertSeed: {
      roomId: verified.roomId,
      actorType: 'local',
      authUserId: null,
      agentId: null,
      localSubjectId: verified.localSubjectId,
      systemKey: null,
    },
  })
}

export function ensureAgentActor(db: DatabaseSync, input: EnsureAgentActorInput): GroupActor {
  const verified = verifyAgentActorInput(input)
  return ensureActor(db, {
    roomId: verified.roomId,
    actorType: 'agent',
    metadata: {
      name: verified.name,
      description: verified.description,
      avatar: '',
    },
    capabilities: AGENT_GROUP_CHAT_CAPABILITIES,
    findExisting: () => findActiveActorByAgentIdentity(db, verified.roomId, verified.agentId),
    insertSeed: {
      roomId: verified.roomId,
      actorType: 'agent',
      authUserId: null,
      agentId: verified.agentId,
      localSubjectId: null,
      systemKey: null,
    },
  })
}

export function ensureSystemActor(db: DatabaseSync, input: EnsureSystemActorInput): GroupActor {
  const verified = verifySystemActorInput(input)
  return ensureActor(db, {
    roomId: verified.roomId,
    actorType: 'system',
    metadata: {
      name: 'system',
      description: '',
      avatar: '',
    },
    capabilities: SYSTEM_GROUP_CHAT_CAPABILITIES,
    findExisting: () => findActiveActorBySystemKey(db, verified.roomId, verified.systemKey ?? 'room-system'),
    insertSeed: {
      roomId: verified.roomId,
      actorType: 'system',
      authUserId: null,
      agentId: null,
      localSubjectId: null,
      systemKey: verified.systemKey ?? 'room-system',
    },
  })
}

export function deactivateAgentActorWithRetention(
  db: DatabaseSync,
  roomId: string,
  agentId: string,
): GroupActor | null {
  return withImmediateTransaction(db as TransactionalDatabase, () => {
    const actor = findActiveActorByAgentIdentity(db, roomId, agentId)
    if (!actor) {
      return null
    }
    const now = Date.now()
    db.prepare(`DELETE FROM ${CAPABILITY_TABLE} WHERE actorId = ?`).run(actor.id)
    db.prepare(
      `UPDATE ${ACTOR_TABLE}
       SET active = 0,
           authUserId = NULL,
           agentId = NULL,
           localSubjectId = NULL,
           systemKey = NULL,
           name = ?,
           description = '',
           avatar = '',
           authorizationRevision = authorizationRevision + 1,
           contextRevision = contextRevision + 1,
           tombstonedAt = ?,
           updatedAt = ?
       WHERE id = ? AND active = 1`
    ).run(DELETED_AGENT_NAME, now, now, actor.id)
    return findActorById(db, actor.id)
  })
}

export function backfillGroupChatActors(db: DatabaseSync): GroupChatActorBackfillSummary {
  const sources = canonicalLegacySources(db)
  db.prepare(`DELETE FROM ${CAPABILITY_TABLE}`).run()
  db.prepare(`DELETE FROM ${ACTOR_TABLE}`).run()
  const insertCapability = db.prepare(
    `INSERT INTO ${CAPABILITY_TABLE}
     (id, roomId, actorId, capability, active, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  )

  let capabilityCount = 0
  for (const source of sources) {
    const actorId = createDeterministicGroupActorId({
      roomId: source.roomId,
      actorType: source.actorType,
      authUserId: source.authUserId,
      agentId: source.agentId,
      localSubjectId: source.localSubjectId,
      systemKey: source.systemKey,
      stableSourceKey: source.stableSourceKey,
    })
    insertActor(db, {
      id: actorId,
      roomId: source.roomId,
      actorType: source.actorType,
      authUserId: source.authUserId,
      agentId: source.agentId,
      localSubjectId: source.localSubjectId,
      systemKey: source.systemKey,
      metadata: {
        name: source.name,
        description: source.description,
        avatar: source.avatar,
      },
      createdAt: source.createdAt,
      updatedAt: source.createdAt,
    })
    for (const capability of source.capabilities) {
      insertCapability.run(
        createDeterministicGroupActorCapabilityId(source.roomId, actorId, capability),
        source.roomId,
        actorId,
        capability,
        source.createdAt,
        source.createdAt,
      )
      capabilityCount += 1
    }
  }

  return {
    actorCount: sources.length,
    capabilityCount,
  }
}

export function validateBackfilledGroupChatActors(
  db: DatabaseSync,
  summary: GroupChatActorBackfillSummary,
): void {
  const actorCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${ACTOR_TABLE}`).get() as { count: number }).count
  const capabilityCount = (db.prepare(`SELECT COUNT(*) AS count FROM ${CAPABILITY_TABLE}`).get() as { count: number }).count
  if (actorCount !== summary.actorCount) {
    throw new Error(`groupChatIdentityV1 actor count mismatch: expected ${summary.actorCount}, found ${actorCount}`)
  }
  if (capabilityCount !== summary.capabilityCount) {
    throw new Error(`groupChatIdentityV1 capability count mismatch: expected ${summary.capabilityCount}, found ${capabilityCount}`)
  }
  const orphanedCapabilities = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${CAPABILITY_TABLE} capability
     LEFT JOIN ${ACTOR_TABLE} actor ON actor.id = capability.actorId
     WHERE actor.id IS NULL`
  ).get() as { count: number }).count
  if (orphanedCapabilities !== 0) {
    throw new Error(`groupChatIdentityV1 found ${orphanedCapabilities} orphaned capability rows`)
  }
  const orphanedActorRooms = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${ACTOR_TABLE} actor
     LEFT JOIN gc_rooms room ON room.id = actor.roomId
     WHERE room.id IS NULL`
  ).get() as { count: number }).count
  if (orphanedActorRooms !== 0) {
    throw new Error(`groupChatIdentityV1 found ${orphanedActorRooms} actor rows referencing unknown rooms`)
  }
  const orphanedCapabilityRooms = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${CAPABILITY_TABLE} capability
     LEFT JOIN gc_rooms room ON room.id = capability.roomId
     WHERE room.id IS NULL`
  ).get() as { count: number }).count
  if (orphanedCapabilityRooms !== 0) {
    throw new Error(`groupChatIdentityV1 found ${orphanedCapabilityRooms} capability rows referencing unknown rooms`)
  }
  const capabilityRoomMismatches = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${CAPABILITY_TABLE} capability
     INNER JOIN ${ACTOR_TABLE} actor ON actor.id = capability.actorId
     WHERE capability.roomId <> actor.roomId`
  ).get() as { count: number }).count
  if (capabilityRoomMismatches !== 0) {
    throw new Error(`groupChatIdentityV1 found ${capabilityRoomMismatches} capability rows with mismatched actor rooms`)
  }
  const invalidIdentityShapes = (db.prepare(
    `SELECT COUNT(*) AS count
     FROM ${ACTOR_TABLE}
     WHERE active = 1 AND (
       (actorType = 'authenticated_human' AND (
         authUserId IS NULL OR agentId IS NOT NULL OR localSubjectId IS NOT NULL OR systemKey IS NOT NULL
       ))
       OR
       (actorType = 'agent' AND (
         COALESCE(TRIM(agentId), '') = '' OR authUserId IS NOT NULL OR localSubjectId IS NOT NULL OR systemKey IS NOT NULL
       ))
       OR
       (actorType = 'local' AND (
         COALESCE(TRIM(localSubjectId), '') = '' OR authUserId IS NOT NULL OR agentId IS NOT NULL OR systemKey IS NOT NULL
       ))
       OR
       (actorType = 'system' AND (
         COALESCE(TRIM(systemKey), '') = '' OR authUserId IS NOT NULL OR agentId IS NOT NULL OR localSubjectId IS NOT NULL
       ))
     )`
  ).get() as { count: number }).count
  if (invalidIdentityShapes !== 0) {
    throw new Error(`groupChatIdentityV1 found ${invalidIdentityShapes} invalid actor identity shapes`)
  }
  const unsupportedCapabilities = (db.prepare(
    `SELECT capability
     FROM ${CAPABILITY_TABLE}
     WHERE active = 1`
  ).all() as Array<{ capability: string }>).map((row) => row.capability)
  if (unsupportedCapabilities.some((capability) => !isSupportedGroupChatCapability(capability))) {
    throw new Error('groupChatIdentityV1 found unsupported capabilities')
  }
  const duplicateQueries = [
    `SELECT roomId, authUserId, COUNT(*) AS count FROM ${ACTOR_TABLE} WHERE active = 1 AND authUserId IS NOT NULL GROUP BY roomId, authUserId HAVING COUNT(*) > 1`,
    `SELECT roomId, agentId, COUNT(*) AS count FROM ${ACTOR_TABLE} WHERE active = 1 AND agentId IS NOT NULL GROUP BY roomId, agentId HAVING COUNT(*) > 1`,
    `SELECT roomId, localSubjectId, COUNT(*) AS count FROM ${ACTOR_TABLE} WHERE active = 1 AND localSubjectId IS NOT NULL GROUP BY roomId, localSubjectId HAVING COUNT(*) > 1`,
    `SELECT roomId, systemKey, COUNT(*) AS count FROM ${ACTOR_TABLE} WHERE active = 1 AND systemKey IS NOT NULL GROUP BY roomId, systemKey HAVING COUNT(*) > 1`,
  ] as const
  for (const query of duplicateQueries) {
    const duplicates = db.prepare(query).all() as Array<{ count: number }>
    if (duplicates.length > 0) {
      throw new Error('groupChatIdentityV1 detected duplicate active actors')
    }
  }
}
