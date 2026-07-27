import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

type SchemaModule = typeof import('../../packages/server/src/db/hermes/schemas')
type MigrationModule = typeof import('../../packages/server/src/db/hermes/group-chat-identity-migration')

let db: DatabaseSync | null = null

function createLegacyGroupChatTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE gc_rooms (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      inviteCode TEXT UNIQUE,
      triggerTokens INTEGER NOT NULL DEFAULT 100000,
      maxHistoryTokens INTEGER NOT NULL DEFAULT 32000,
      tailMessageCount INTEGER NOT NULL DEFAULT 10,
      totalTokens INTEGER NOT NULL DEFAULT 0,
      sessionSeed TEXT NOT NULL DEFAULT '0',
      workspace TEXT NOT NULL DEFAULT '',
      ownerAuthUserId INTEGER
    );
    CREATE TABLE gc_room_agents (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      profile TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      invited INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE gc_room_members (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      userId TEXT NOT NULL,
      userName TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      joinedAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      authUserId INTEGER
    );
  `)
}

function hasTable(database: DatabaseSync, tableName: string): boolean {
  return Boolean(database.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(tableName))
}

function userTableNames(database: DatabaseSync): string[] {
  return (database.prepare(
    `SELECT name
     FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY name`
  ).all() as Array<{ name: string }>).map((row) => row.name)
}

function tableColumns(database: DatabaseSync, tableName: string): string[] {
  return (database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
    .map((row) => row.name)
}

async function claimTestOwnership(database: DatabaseSync): Promise<void> {
  const ownership = await import('../../packages/server/src/db/ownership')
  ownership.claimHermesDatabaseOwnershipForTesting(database)
}

async function loadSchemasWithDb(database: DatabaseSync): Promise<{
  initAllHermesTables: SchemaModule['initAllHermesTables']
  runGroupChatIdentityV1Migration: MigrationModule['runGroupChatIdentityV1Migration']
  setGroupChatIdentityMigrationFailpointForTesting: MigrationModule['setGroupChatIdentityMigrationFailpointForTesting']
}> {
  vi.doMock('../../packages/server/src/db/index', () => ({
    getDb: () => database,
    getStoragePath: () => ':memory:',
  }))

  const schemas = await import('../../packages/server/src/db/hermes/schemas')
  const migration = await import('../../packages/server/src/db/hermes/group-chat-identity-migration')

  return {
    initAllHermesTables: schemas.initAllHermesTables,
    runGroupChatIdentityV1Migration: migration.runGroupChatIdentityV1Migration,
    setGroupChatIdentityMigrationFailpointForTesting: migration.setGroupChatIdentityMigrationFailpointForTesting,
  }
}

afterEach(() => {
  db?.close()
  db = null
  vi.doUnmock('../../packages/server/src/db/index')
  vi.resetModules()
})

describe('group chat identity migration', () => {
  it('rejects init without an explicit ownership claim before any schema writes', async () => {
    db = new DatabaseSync(':memory:')
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    expect(() => initAllHermesTables()).toThrow(/ownership/i)
    expect(userTableNames(db)).toEqual([])
  })

  it('creates schema state and actor tables on a fresh database', async () => {
    db = new DatabaseSync(':memory:')
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    initAllHermesTables()

    expect(hasTable(db, 'gc_schema_state')).toBe(true)
    expect(hasTable(db, 'gc_room_actors')).toBe(true)
    expect(hasTable(db, 'gc_room_actor_capabilities')).toBe(true)
    expect(db.prepare(
      `SELECT schema_name, version, status, min_reader_epoch
       FROM gc_schema_state
       WHERE schema_name = ?`
    ).get('groupChatIdentityV1')).toEqual({
      schema_name: 'groupChatIdentityV1',
      version: 1,
      status: 'complete',
      min_reader_epoch: 1,
    })
  })

  it('upgrades latest-main group chat state by backfilling canonical actors and supported grants', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace, ownerAuthUserId)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '', 7);
      INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited)
      VALUES ('agent-row-1', 'room-1', 'agent-1', 'default', 'Worker', 'Build things', 0);
      INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId)
      VALUES
        ('member-auth-1', 'room-1', 'auth:7', 'Alice', 'Owner', 1, 1, 'avatar-a', 7),
        ('member-local-1', 'room-1', 'local-1', 'Local User', '', 2, 2, '', NULL);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    initAllHermesTables()

    expect(db.prepare(
      `SELECT actorType, authUserId, name, description, avatar
       FROM gc_room_actors
       WHERE roomId = ? AND authUserId = ?`
    ).get('room-1', 7)).toEqual({
      actorType: 'authenticated_human',
      authUserId: 7,
      name: 'Alice',
      description: 'Owner',
      avatar: 'avatar-a',
    })
    expect(db.prepare(
      `SELECT actorType, agentId, name, description
       FROM gc_room_actors
       WHERE roomId = ? AND agentId = ?`
    ).get('room-1', 'agent-1')).toEqual({
      actorType: 'agent',
      agentId: 'agent-1',
      name: 'Worker',
      description: 'Build things',
    })
    const localActor = db.prepare(
      `SELECT actorType, localSubjectId, name
       FROM gc_room_actors
       WHERE roomId = ? AND actorType = 'local'`
    ).get('room-1') as { actorType: string; localSubjectId: string; name: string }
    expect(localActor).toEqual({
      actorType: 'local',
      localSubjectId: expect.stringMatching(/^local:[0-9a-f]{32}$/),
      name: 'Local User',
    })
    expect(localActor.localSubjectId).not.toBe('local-1')

    const grants = (db.prepare(
      `SELECT capability
       FROM gc_room_actor_capabilities
       WHERE roomId = ? AND actorId = (
         SELECT id FROM gc_room_actors WHERE roomId = ? AND agentId = ?
       )
       ORDER BY capability`
    ).all('room-1', 'room-1', 'agent-1') as Array<{ capability: string }>).map((row) => row.capability)
    expect(grants).toEqual([
      'agent.invoke',
      'room.read',
      'room.type',
      'room.write',
    ])
  })

  it('reconciles duplicate authenticated and agent identities by canonical timestamps instead of insertion rowid', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace, ownerAuthUserId)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '', 7);
      ALTER TABLE gc_room_agents ADD COLUMN createdAt INTEGER NOT NULL DEFAULT 0;
      INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited)
      VALUES
        ('agent-row-z', 'room-1', 'agent-dup', 'default', 'Worker New', 'second', 0),
        ('agent-row-a', 'room-1', 'agent-dup', 'default', 'Worker Old', 'first', 0);
      UPDATE gc_room_agents SET createdAt = 20 WHERE id = 'agent-row-z';
      UPDATE gc_room_agents SET createdAt = 10 WHERE id = 'agent-row-a';
      INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId)
      VALUES
        ('member-auth-z', 'room-1', 'auth:7-new', 'Alice New', 'second', 20, 20, 'avatar-new', 7),
        ('member-auth-a', 'room-1', 'auth:7-old', 'Alice Old', 'first', 10, 10, 'avatar-old', 7);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    initAllHermesTables()

    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM gc_room_actors
       WHERE roomId = ? AND agentId = ?`
    ).get('room-1', 'agent-dup')).toEqual({ count: 1 })
    expect(db.prepare(
      `SELECT name, description
       FROM gc_room_actors
       WHERE roomId = ? AND agentId = ?`
    ).get('room-1', 'agent-dup')).toEqual({
      name: 'Worker Old',
      description: 'first',
    })
    expect(db.prepare(
      `SELECT COUNT(*) AS count
       FROM gc_room_actors
       WHERE roomId = ? AND authUserId = ?`
    ).get('room-1', 7)).toEqual({ count: 1 })
    expect(db.prepare(
      `SELECT name, description, avatar
       FROM gc_room_actors
       WHERE roomId = ? AND authUserId = ?`
    ).get('room-1', 7)).toEqual({
      name: 'Alice Old',
      description: 'first',
      avatar: 'avatar-old',
    })
  })

  it('repeats idempotently once groupChatIdentityV1 is recorded', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '');
      INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited)
      VALUES ('agent-row-1', 'room-1', 'agent-1', 'default', 'Worker', '', 0);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    initAllHermesTables()
    const firstState = db.prepare(
      `SELECT schema_name, version, status, min_reader_epoch, applied_at
       FROM gc_schema_state
       WHERE schema_name = ?`
    ).get('groupChatIdentityV1')
    const firstActors = db.prepare(
      `SELECT id, roomId, actorType, agentId, authUserId, localSubjectId
       FROM gc_room_actors
       ORDER BY id`
    ).all()
    const firstCapabilities = db.prepare(
      `SELECT actorId, capability
       FROM gc_room_actor_capabilities
       ORDER BY actorId, capability`
    ).all()

    initAllHermesTables()

    expect(db.prepare(
      `SELECT schema_name, version, status, min_reader_epoch, applied_at
       FROM gc_schema_state
       WHERE schema_name = ?`
    ).get('groupChatIdentityV1')).toEqual(firstState)
    expect(db.prepare(
      `SELECT id, roomId, actorType, agentId, authUserId, localSubjectId
       FROM gc_room_actors
       ORDER BY id`
    ).all()).toEqual(firstActors)
    expect(db.prepare(
      `SELECT actorId, capability
       FROM gc_room_actor_capabilities
       ORDER BY actorId, capability`
    ).all()).toEqual(firstCapabilities)
  })

  it('rotates invalid legacy room session seeds once while preserving valid 32-hex seeds', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace)
      VALUES
        ('room-empty', 'Empty', 'EMPTY1', '', ''),
        ('room-zero', 'Zero', 'ZERO01', '0', ''),
        ('room-legacy', 'Legacy', 'LEGACY1', 'seed-1', ''),
        ('room-valid', 'Valid', 'VALID1', '0123456789abcdefABCDEF0123456789', '');
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    initAllHermesTables()

    const firstSeeds = db.prepare(
      'SELECT id, sessionSeed FROM gc_rooms ORDER BY id'
    ).all() as Array<{ id: string; sessionSeed: string }>
    expect(firstSeeds).toEqual([
      { id: 'room-empty', sessionSeed: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { id: 'room-legacy', sessionSeed: expect.stringMatching(/^[0-9a-f]{32}$/) },
      { id: 'room-valid', sessionSeed: '0123456789abcdefABCDEF0123456789' },
      { id: 'room-zero', sessionSeed: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ])
    expect(firstSeeds.find(row => row.id === 'room-empty')?.sessionSeed).not.toBe('')
    expect(firstSeeds.find(row => row.id === 'room-legacy')?.sessionSeed).not.toBe('seed-1')
    expect(firstSeeds.find(row => row.id === 'room-zero')?.sessionSeed).not.toBe('0')

    initAllHermesTables()

    expect(db.prepare(
      'SELECT id, sessionSeed FROM gc_rooms ORDER BY id'
    ).all()).toEqual(firstSeeds)

    db.prepare("UPDATE gc_rooms SET sessionSeed = '0' WHERE id = 'room-valid'").run()
    initAllHermesTables()
    const repairedSeed = (db.prepare(
      'SELECT sessionSeed FROM gc_rooms WHERE id = ?'
    ).get('room-valid') as { sessionSeed: string }).sessionSeed
    expect(repairedSeed).toMatch(/^[0-9a-f]{32}$/)
    expect(repairedSeed).not.toBe('0')
  })

  it('rolls back the entire migration when an injected failpoint fires', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '');
      INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited)
      VALUES ('agent-row-1', 'room-1', 'agent-1', 'default', 'Worker', '', 0);
    `)
    const {
      initAllHermesTables,
      runGroupChatIdentityV1Migration: _runGroupChatIdentityV1Migration,
      setGroupChatIdentityMigrationFailpointForTesting,
    } = await loadSchemasWithDb(db)

    await claimTestOwnership(db)
    setGroupChatIdentityMigrationFailpointForTesting('after-backfill')
    const beforeRoomColumns = tableColumns(db, 'gc_rooms')
    const beforeRooms = db.prepare(
      'SELECT id, sessionSeed FROM gc_rooms ORDER BY id'
    ).all()
    expect(() => initAllHermesTables()).toThrow(/groupChatIdentityV1/i)
    setGroupChatIdentityMigrationFailpointForTesting(null)

    expect(tableColumns(db, 'gc_rooms')).toEqual(beforeRoomColumns)
    expect(db.prepare(
      'SELECT id, sessionSeed FROM gc_rooms ORDER BY id'
    ).all()).toEqual(beforeRooms)
    expect(hasTable(db, 'gc_schema_state')).toBe(false)
    expect(hasTable(db, 'gc_room_actors')).toBe(false)
    expect(hasTable(db, 'gc_room_actor_capabilities')).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS count FROM gc_room_agents').get()).toEqual({ count: 1 })
  })

  it('rejects orphaned legacy room references and rolls back every PR1 group chat change', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '');
      INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId)
      VALUES ('member-orphan', 'ghost-room', 'ghost-user', 'Ghost', '', 10, 10, '', NULL);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)
    const beforeColumns = tableColumns(db, 'gc_rooms')

    expect(() => initAllHermesTables()).toThrow(/room/i)
    expect(tableColumns(db, 'gc_rooms')).toEqual(beforeColumns)
    expect(hasTable(db, 'gc_schema_state')).toBe(false)
    expect(hasTable(db, 'gc_room_actors')).toBe(false)
    expect(hasTable(db, 'gc_room_actor_capabilities')).toBe(false)
  })

  it('rejects invalid active identity shapes before creating actor indexes', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '');
      INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId)
      VALUES
        ('member-valid', 'room-1', 'local-valid', 'Local', '', 1, 1, '', NULL),
        ('member-invalid', 'room-1', '', 'Broken', '', 2, 2, '', NULL);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)

    expect(() => initAllHermesTables()).toThrow(/identity|localSubjectId|userId/i)
    expect(hasTable(db, 'gc_room_actors')).toBe(false)
    expect(hasTable(db, 'gc_room_actor_capabilities')).toBe(false)
  })

  it('refuses to run when a recorded minimum reader epoch is newer than PR1 epoch 1', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      CREATE TABLE gc_schema_state (
        schema_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        min_reader_epoch INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO gc_schema_state (schema_name, version, status, min_reader_epoch, applied_at)
      VALUES ('groupChatIdentityV1', 1, 'complete', 2, 123);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)
    const beforeTables = userTableNames(db)
    const beforeColumns = tableColumns(db, 'gc_rooms')

    expect(() => initAllHermesTables()).toThrow(/minimum reader epoch 2/i)
    expect(userTableNames(db)).toEqual(beforeTables)
    expect(tableColumns(db, 'gc_rooms')).toEqual(beforeColumns)
  })

  it('rejects pending or foreign recorded state before any schema write', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      CREATE TABLE gc_schema_state (
        schema_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        min_reader_epoch INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO gc_schema_state (schema_name, version, status, min_reader_epoch, applied_at)
      VALUES ('groupChatIdentityV1', 1, 'pending', 1, 123);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)
    const beforeTables = userTableNames(db)
    const beforeColumns = tableColumns(db, 'gc_rooms')

    expect(() => initAllHermesTables()).toThrow(/unsupported recorded state pending@1/i)
    expect(userTableNames(db)).toEqual(beforeTables)
    expect(tableColumns(db, 'gc_rooms')).toEqual(beforeColumns)
  })

  it('rejects a foreign Group Chat schema-state row before any schema write', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      CREATE TABLE gc_schema_state (
        schema_name TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        min_reader_epoch INTEGER NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO gc_schema_state (schema_name, version, status, min_reader_epoch, applied_at)
      VALUES ('groupChatIdentityV2', 2, 'pending', 2, 123);
    `)
    await claimTestOwnership(db)
    const { initAllHermesTables } = await loadSchemasWithDb(db)
    const beforeTables = userTableNames(db)
    const beforeColumns = tableColumns(db, 'gc_rooms')

    expect(() => initAllHermesTables()).toThrow(/foreign.*groupChatIdentityV2/i)
    expect(userTableNames(db)).toEqual(beforeTables)
    expect(tableColumns(db, 'gc_rooms')).toEqual(beforeColumns)
  })

  it('asserts ownership and composes with an existing transaction for standalone migration', async () => {
    db = new DatabaseSync(':memory:')
    createLegacyGroupChatTables(db)
    db.exec(`
      INSERT INTO gc_rooms (id, name, inviteCode, sessionSeed, workspace)
      VALUES ('room-1', 'Room 1', 'ROOM1', 'seed-1', '');
      INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited)
      VALUES ('agent-row-1', 'room-1', 'agent-1', 'default', 'Worker', '', 0);
    `)
    await claimTestOwnership(db)
    const { runGroupChatIdentityV1Migration } = await loadSchemasWithDb(db)

    db.exec('BEGIN IMMEDIATE')
    expect(() => runGroupChatIdentityV1Migration(db!)).not.toThrow()
    db.exec('ROLLBACK')

    expect(hasTable(db, 'gc_schema_state')).toBe(false)
    expect(hasTable(db, 'gc_room_actors')).toBe(false)
  })
})
