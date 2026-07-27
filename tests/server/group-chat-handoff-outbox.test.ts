import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const dbMock = vi.hoisted(() => ({ current: null as DatabaseSync | null }))

vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => dbMock.current }))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  isAuthEnabled: vi.fn(async () => false),
  authenticateUserToken: vi.fn(),
}))

import {
  GC_HANDOFF_JOBS_TABLE,
  initAllHermesTables,
} from '../../packages/server/src/db/hermes/schemas'
import {
  ChatStorage,
  GroupChatServer,
  planGroupHandoffs,
  shouldPlanGroupHandoffs,
} from '../../packages/server/src/services/hermes/group-chat'

const LOCAL_SOURCE_SUBJECT = `local:${'a'.repeat(32)}`

function createAuthorizedSource(storage: ChatStorage, roomId: string) {
  return storage.ensureLocalActor({
    roomId,
    localSubjectId: LOCAL_SOURCE_SUBJECT,
    userId: 'human-1',
    userName: 'Human',
    description: '',
    avatar: '',
    grantDefaultCapabilities: true,
  })
}

function authorizedHandoffs(storage: ChatStorage, roomId: string, handoffs: any[]) {
  const source = createAuthorizedSource(storage, roomId)
  return {
    handoffs,
    authority: { initiatorActorId: source.id, sourceActorId: source.id },
  }
}

describe('durable group-chat handoff outbox', () => {
  beforeEach(() => {
    dbMock.current?.close()
    dbMock.current = new DatabaseSync(':memory:')
    initAllHermesTables()
  })

  it('creates the handoff table with a source/target idempotency boundary', () => {
    const db = dbMock.current!
    const columns = db.prepare(`PRAGMA table_info("${GC_HANDOFF_JOBS_TABLE}")`).all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id', 'roomId', 'chainId', 'sourceMessageId',
      'initiatorActorId', 'initiatorActorAuthorizationRevision', 'initiatorActorContextRevision',
      'sourceActorId', 'sourceActorAuthorizationRevision', 'sourceActorContextRevision',
      'targetActorId', 'targetActorAuthorizationRevision', 'targetActorContextRevision',
      'roomAuthorizationRevision', 'authorizationReaderEpoch',
      'targetAgentId', 'targetSessionId', 'targetSessionGeneration',
      'depth', 'kind', 'status', 'attemptCount', 'availableAt', 'leaseOwner',
      'leaseToken', 'leaseExpiresAt', 'lastError', 'createdAt', 'updatedAt', 'completedAt',
    ]))
    const indexes = db.prepare(`PRAGMA index_list("${GC_HANDOFF_JOBS_TABLE}")`).all() as Array<{ name: string; unique: number }>
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'uniq_gc_handoff_source_target', unique: 1 }))
  })

  it('fails legacy rows with missing authority closed instead of claiming them', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    dbMock.current!.prepare(`
      INSERT INTO gc_handoff_jobs (
        id, roomId, chainId, sourceMessageId, targetAgentId, targetSessionId,
        depth, kind, status, availableAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, 0, 'mention', 'pending', 0, 1, 1)
    `).run('legacy-job', 'room-1', 'legacy-chain', 'legacy-message', target.agentId, target.sessionId)

    expect(storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)).toEqual([])
    expect(storage.getHandoffJob('legacy-job')).toMatchObject({
      status: 'authorization_revoked', leaseOwner: '', leaseToken: '', attemptCount: 0,
    })
  })

  it('persists a message and all fan-out jobs atomically without duplicating jobs on replay', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    const msg = {
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@all hello', timestamp: 100, role: 'user',
    }
    const plans = [a, b].map(agent => ({
      chainId: 'chain-human-message-1',
      targetAgentId: agent.agentId,
      targetSessionId: agent.sessionId,
      depth: 0,
      kind: 'fanout' as const,
    }))

    const first = storage.saveMessageAndRefreshRoom(msg, authorizedHandoffs(storage, 'room-1', plans))
    const replay = storage.saveMessageAndRefreshRoom(msg, authorizedHandoffs(storage, 'room-1', plans))

    expect(first.handoffJobs).toHaveLength(2)
    expect(replay.handoffJobs).toHaveLength(2)
    const rows = dbMock.current!.prepare('SELECT * FROM gc_handoff_jobs ORDER BY targetAgentId').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.targetAgentId)).toEqual(['agent-a', 'agent-b'])
    expect(storage.getMessage('human-message-1')?.roomSeq).toBe(1)
  })

  it('captures live source, target, Room and session authority in the same admission transaction', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, {
      sessionId: 'session-a', sessionGeneration: 7,
    })
    const targetActor = storage.findActiveActorByAgentIdentity('room-1', target.agentId)!
    const room = storage.getRoom('room-1')!

    storage.saveMessageAndRefreshRoom({
      id: 'authority-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'authority-chain-1', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    } as any)

    expect(dbMock.current!.prepare('SELECT * FROM gc_handoff_jobs WHERE sourceMessageId = ?').get('authority-message-1')).toMatchObject({
      initiatorActorId: source.id,
      initiatorActorAuthorizationRevision: source.authorizationRevision,
      initiatorActorContextRevision: source.contextRevision,
      sourceActorId: source.id,
      sourceActorAuthorizationRevision: source.authorizationRevision,
      sourceActorContextRevision: source.contextRevision,
      targetActorId: targetActor.id,
      targetActorAuthorizationRevision: targetActor.authorizationRevision,
      targetActorContextRevision: targetActor.contextRevision,
      roomAuthorizationRevision: room.authorizationRevision,
      authorizationReaderEpoch: 1,
      targetAgentId: target.agentId,
      targetSessionId: target.sessionId,
      targetSessionGeneration: 7,
    })
  })

  it('rolls back a routed message when the live source lacks agent.invoke', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    dbMock.current!.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'agent.invoke'",
    ).run(source.id)

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'denied-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A denied', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'denied-chain-1', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    } as any)).toThrow(/agent\.invoke|authorization/i)

    expect(storage.getMessage('denied-message-1')).toBeNull()
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM gc_handoff_jobs').get()).toEqual({ total: 0 })
  })

  it('rejects reuse of a routed message id with different content', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const plan = [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' as const }]
    storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A original', timestamp: 100, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', plan))

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A changed', timestamp: 101, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', plan))).toThrow(/message id conflict/i)
    expect(storage.getMessage('human-message-1')?.content).toBe('@A original')
  })

  it('rolls back the message when a handoff target violates the durable contract', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-bad', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@Missing hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{
        chainId: 'chain-bad', targetAgentId: 'missing', targetSessionId: 'missing-session',
        depth: 0, kind: 'mention',
      }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })).toThrow(/target participant/i)
    expect(storage.getMessage('human-message-bad')).toBeNull()
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM gc_handoff_jobs').get()).toEqual({ total: 0 })
  })

  it('does not let another process claim a running job before recovery classifies it', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }]))

    const first = storage.claimHandoffJobs('process-old', 1_000, 1, 5_000)
    expect(first).toHaveLength(1)
    expect(storage.claimHandoffJobs('process-old', 1_001, 1, 5_000)).toHaveLength(0)

    expect(storage.claimHandoffJobs('process-new', 7_000, 1, 5_000)).toHaveLength(0)
    expect(storage.getHandoffJob(first[0].id)).toMatchObject({ status: 'running', leaseOwner: 'process-old', attemptCount: 1 })
  })

  it('durably fences pending and running jobs when the Room authorization revision advances', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    const first = storage.saveMessageAndRefreshRoom({
      id: 'revision-source-a', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'revision-chain-a', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })
    storage.saveMessageAndRefreshRoom({
      id: 'revision-source-b', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@B hello', timestamp: 101, role: 'user',
    }, {
      handoffs: [{ chainId: 'revision-chain-b', targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 60_000)[0]
    expect(running.id).toBe(first.handoffJobs[0].id)

    storage.updateRoomInviteCode('room-1', 'ROOM2')

    expect(storage.listHandoffJobs('room-1')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running.id, status: 'authorization_revoked', leaseOwner: '', leaseToken: '' }),
      expect.objectContaining({ targetAgentId: b.agentId, status: 'authorization_revoked', attemptCount: 0 }),
    ]))
  })

  it('terminalizes a pending job when source invoke is revoked without a revision bump', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const created = storage.saveMessageAndRefreshRoom({
      id: 'claim-revoke-source', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'claim-chain-source', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })
    dbMock.current!.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'agent.invoke'",
    ).run(source.id)

    expect(storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)).toEqual([])
    expect(storage.getHandoffJob(created.handoffJobs[0].id)).toMatchObject({
      status: 'authorization_revoked', leaseOwner: '', leaseToken: '', attemptCount: 0,
    })
  })

  it('terminalizes a pending job when target write is revoked without a revision bump', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const targetActor = storage.findActiveActorByAgentIdentity('room-1', target.agentId)!
    const created = storage.saveMessageAndRefreshRoom({
      id: 'claim-revoke-target', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'claim-chain-target', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })
    dbMock.current!.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'room.write'",
    ).run(targetActor.id)

    expect(storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)).toEqual([])
    expect(storage.getHandoffJob(created.handoffJobs[0].id)).toMatchObject({
      status: 'authorization_revoked', leaseOwner: '', leaseToken: '', attemptCount: 0,
    })
  })

  it('fails lease renewal closed when current authority is revoked without a revision bump', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const source = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const created = storage.saveMessageAndRefreshRoom({
      id: 'heartbeat-revoke-source', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'heartbeat-chain-source', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 60_000)[0]
    expect(running.id).toBe(created.handoffJobs[0].id)
    dbMock.current!.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'agent.invoke'",
    ).run(source.id)

    expect(storage.renewHandoffLease(running.id, running.leaseToken, 'process-1', 2_000, 60_000)).toBe(false)
    expect(storage.getHandoffJob(running.id)).toMatchObject({
      status: 'authorization_revoked', leaseOwner: '', leaseToken: '', leaseExpiresAt: 0,
    })
  })

  it('marks the source job complete and creates the next job in the same assistant-message transaction', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'fixed' }]))
    const source = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]

    const saved = storage.saveMessageAndRefreshRoom({
      id: 'assistant-message-1', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'answer without any mention', timestamp: 200, role: 'assistant',
      handoffChainId: source.chainId, handoffDepth: 1, sourceHandoffJobId: source.id,
      sourceHandoffLeaseToken: source.leaseToken, agentSessionId: a.sessionId, handoffFinal: true,
    }, {
      handoffs: [{ chainId: source.chainId, targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 1, kind: 'fixed' }],
      authority: { initiatorActorId: source.initiatorActorId, sourceActorId: source.targetActorId },
    })

    expect(saved.handoffJobs).toHaveLength(1)
    expect(storage.getHandoffJob(source.id)).toMatchObject({ status: 'completed', completedAt: 200 })
    expect(saved.handoffJobs[0]).toMatchObject({ targetAgentId: b.agentId, depth: 1, kind: 'fixed', status: 'pending' })
  })

  it('rejects final publication and next jobs when authority is revoked after launch', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const sourceActor = createAuthorizedSource(storage, 'room-1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    const created = storage.saveMessageAndRefreshRoom({
      id: 'final-revoke-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'final-revoke-chain', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'fixed' }],
      authority: { initiatorActorId: sourceActor.id, sourceActorId: sourceActor.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(running.id).toBe(created.handoffJobs[0].id)
    dbMock.current!.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'agent.invoke'",
    ).run(sourceActor.id)

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'revoked-final-message', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'must not publish', timestamp: 200, role: 'assistant',
      handoffChainId: running.chainId, handoffDepth: 1, sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken, agentSessionId: a.sessionId, handoffFinal: true,
    }, {
      handoffs: [{ chainId: running.chainId, targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 1, kind: 'fixed' }],
      authority: { initiatorActorId: running.initiatorActorId, sourceActorId: running.targetActorId },
    })).toThrow(/authorization|revoked/i)

    expect(storage.getMessage('revoked-final-message')).toBeNull()
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'authorization_revoked', leaseOwner: '', leaseToken: '' })
    expect(storage.listHandoffJobs('room-1').filter(job => job.sourceMessageId === 'revoked-final-message')).toEqual([])
  })

  it('rejects a stale lease final without publishing or changing the live job', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'stale-lease-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', [{ chainId: 'stale-lease-chain', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }]))
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'stale-final-message', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'must not publish', timestamp: 200, role: 'assistant',
      handoffChainId: running.chainId, handoffDepth: 1, sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: 'stale-token', agentSessionId: a.sessionId, handoffFinal: true,
    })).toThrow(/publication rejected|lease/i)

    expect(storage.getMessage('stale-final-message')).toBeNull()
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'running', leaseToken: running.leaseToken })
  })

  it('rejects and fences a partial assistant message when durable authority is revoked', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const sourceActor = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'partial-revoke-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'partial-revoke-chain', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: sourceActor.id, sourceActorId: sourceActor.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    dbMock.current!.prepare(
      "UPDATE gc_room_actor_capabilities SET active = 0 WHERE actorId = ? AND capability = 'agent.invoke'",
    ).run(sourceActor.id)

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'revoked-partial-message', roomId: 'room-1', senderId: target.agentId, senderName: 'A',
      content: 'must not publish', timestamp: 200, role: 'assistant',
      handoffChainId: running.chainId, handoffDepth: 1, sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken, agentSessionId: target.sessionId, handoffFinal: false,
    })).toThrow(/authorization|revoked/i)

    expect(storage.getMessage('revoked-partial-message')).toBeNull()
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'authorization_revoked', leaseOwner: '', leaseToken: '' })
  })

  it('rejects workspace evidence after the linked durable handoff is fenced', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const sourceActor = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'workspace-revoke-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'workspace-revoke-chain', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: sourceActor.id, sourceActorId: sourceActor.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(storage.fenceHandoffJobAfterLeaseLoss(running.id, running.leaseToken, 'process-1')).toBe(true)

    expect(storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1', senderId: target.agentId, senderName: 'A', sessionId: target.sessionId,
      runId: 'workspace-fenced-run', status: 'completed', workspace: '/workspace/project',
      sourceHandoffJobId: running.id, sourceHandoffLeaseToken: running.leaseToken,
      draft: {
        change_id: 'workspace-fenced-change', session_id: target.sessionId, run_id: 'workspace-fenced-run',
        source: 'run', workspace: '/workspace/project', started_at: 1, finished_at: 2,
        files_changed: 0, additions: 0, deletions: 0, total_patch_bytes: 0, files: [],
      },
    } as any)).toBeNull()
    expect(dbMock.current!.prepare("SELECT COUNT(*) AS total FROM gc_messages WHERE tool_name = 'workspace_diff'").get()).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM workspace_run_changes').get()).toEqual({ total: 0 })
    const tokensBeforeRejectedUsage = storage.getRoom('room-1')?.totalTokens
    expect(storage.updateRoomTotalTokensForHandoff({
      roomId: 'room-1', totalTokens: 999, sourceHandoffJobId: running.id,
      sourceHandoffLeaseToken: running.leaseToken, targetAgentId: target.agentId, targetSessionId: target.sessionId,
    })).toBe(false)
    expect(storage.getRoom('room-1')?.totalTokens).toBe(tokensBeforeRejectedUsage)
  })

  it('claims at most one FIFO job per room target while allowing different targets in parallel', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 1, { sessionId: 'session-b' })
    for (const [id, target] of [['human-1', a], ['human-2', a], ['human-3', b]] as const) {
      storage.saveMessageAndRefreshRoom({
        id, roomId: 'room-1', senderId: 'human-1', senderName: 'Human', content: `@${target.name}`, timestamp: Number(id.at(-1)) * 100, role: 'user',
      }, authorizedHandoffs(storage, 'room-1', [{ chainId: `chain-${id}`, targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }]))
    }

    const claimed = storage.claimHandoffJobs('process-1', 1_000, 10, 5_000)
    expect(claimed).toHaveLength(2)
    expect(claimed.map(job => job.targetAgentId).sort()).toEqual([a.agentId, b.agentId].sort())
    expect(storage.listHandoffJobs('room-1').filter(job => job.targetAgentId === a.agentId).map(job => job.status).sort()).toEqual(['pending', 'running'])
  })

  it('cancels durable pending and running jobs when the user stops a participant', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    for (const id of ['human-1', 'human-2']) {
      storage.saveMessageAndRefreshRoom({
        id, roomId: 'room-1', senderId: 'human-1', senderName: 'Human', content: '@A', timestamp: Number(id.at(-1)) * 100, role: 'user',
      }, authorizedHandoffs(storage, 'room-1', [{ chainId: `chain-${id}`, targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }]))
    }
    storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)

    expect(storage.cancelHandoffJobs('room-1', a.agentId, 'Participant stopped by user')).toBe(2)
    expect(storage.listHandoffJobs('room-1').map(job => job.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('fails closed instead of auto-replaying a job whose process died while running', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }]))
    const claimed = storage.claimHandoffJobs('process-old', 1_000, 1, 5_000)[0]

    expect(storage.recoverInterruptedHandoffJobs('process-new', 7_000)).toBe(1)
    expect(storage.getHandoffJob(claimed.id)).toMatchObject({ status: 'interrupted', leaseOwner: '', leaseToken: '' })
    expect(storage.claimHandoffJobs('process-new', 7_000, 1, 5_000)).toEqual([])
  })

  it('routes a throwing heartbeat renewal through durable fencing before runtime interrupt', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      let finishRun!: () => void
      const server = Object.create(GroupChatServer.prototype) as any
      const job = {
        id: 'job-heartbeat-throw', roomId: 'room-1', chainId: 'chain-1', sourceMessageId: 'message-1',
        targetAgentId: 'agent-a', targetSessionId: 'session-a', depth: 0, kind: 'mention',
        leaseToken: 'lease-1', attemptCount: 1,
      }
      server.handoffDispatcherOwner = 'process-1'
      server.handoffDispatchRunning = false
      server.handoffDispatcherReady = true
      server.handoffDispatchTimer = null
      server.scheduleHandoffDispatch = vi.fn()
      server.storage = {
        recoverInterruptedHandoffJobs: vi.fn(),
        claimHandoffJobs: vi.fn().mockReturnValueOnce([job]).mockReturnValue([]),
        getMessage: vi.fn(() => ({
          id: 'message-1', content: '@A hello', senderName: 'Human', senderId: 'human-1', timestamp: 100, role: 'user',
        })),
        getHandoffJob: vi.fn(() => ({ ...job, status: 'running', leaseOwner: 'process-1' })),
        renewHandoffLease: vi.fn(() => {
          order.push('renew-threw')
          throw new Error('sqlite busy')
        }),
        fenceHandoffJobAfterLeaseLoss: vi.fn(() => {
          order.push('durable-fence')
          return true
        }),
        markHandoffJobFailed: vi.fn(),
        rescheduleHandoffJobWithoutAttempt: vi.fn(),
      }
      server.agentClients = {
        processHandoffJob: vi.fn(() => new Promise<void>(resolve => { finishRun = resolve })),
        interruptAgent: vi.fn(async () => {
          order.push('runtime-interrupt')
          finishRun()
        }),
      }

      const drain = server.drainHandoffJobs()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)
      server.handoffDispatcherReady = false
      await drain

      expect(order.slice(0, 3)).toEqual(['renew-threw', 'durable-fence', 'runtime-interrupt'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails the dispatcher closed when a lost heartbeat cannot be durably fenced or confirmed', async () => {
    vi.useFakeTimers()
    try {
      let finishRun!: () => void
      const server = Object.create(GroupChatServer.prototype) as any
      const job = {
        id: 'job-heartbeat-unfenced', roomId: 'room-1', chainId: 'chain-1', sourceMessageId: 'message-1',
        targetAgentId: 'agent-a', targetSessionId: 'session-a', depth: 0, kind: 'mention',
        leaseToken: 'lease-1', attemptCount: 1,
      }
      server.handoffDispatcherOwner = 'process-1'
      server.handoffDispatchRunning = false
      server.handoffDispatcherReady = true
      server.handoffDispatchTimer = null
      server.scheduleHandoffDispatch = vi.fn()
      server.storage = {
        recoverInterruptedHandoffJobs: vi.fn(),
        claimHandoffJobs: vi.fn().mockReturnValueOnce([job]).mockReturnValue([]),
        getMessage: vi.fn(() => ({
          id: 'message-1', content: '@A hello', senderName: 'Human', senderId: 'human-1', timestamp: 100, role: 'user',
        })),
        getHandoffJob: vi.fn(() => ({ ...job, status: 'running', leaseOwner: 'process-1' })),
        renewHandoffLease: vi.fn(() => false),
        fenceHandoffJobAfterLeaseLoss: vi.fn(() => false),
        markHandoffJobFailed: vi.fn(),
        rescheduleHandoffJobWithoutAttempt: vi.fn(),
      }
      server.agentClients = {
        processHandoffJob: vi.fn(() => new Promise<void>(resolve => { finishRun = resolve })),
        interruptAgent: vi.fn(),
      }

      const drain = server.drainHandoffJobs()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)
      finishRun()
      await expect(drain).rejects.toThrow(/durable fence/i)

      expect(server.handoffDispatcherReady).toBe(false)
      expect(server.storage.fenceHandoffJobAfterLeaseLoss).toHaveBeenCalledTimes(3)
      expect(server.agentClients.interruptAgent).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('durably fences a lost heartbeat before interrupting the owning participant runtime', async () => {
    vi.useFakeTimers()
    try {
      const order: string[] = []
      let finishRun!: () => void
      const server = Object.create(GroupChatServer.prototype) as any
      const job = {
        id: 'job-heartbeat-loss', roomId: 'room-1', chainId: 'chain-1', sourceMessageId: 'message-1',
        targetAgentId: 'agent-a', targetSessionId: 'session-a', depth: 0, kind: 'mention',
        leaseToken: 'lease-1', attemptCount: 1,
      }
      server.handoffDispatcherOwner = 'process-1'
      server.handoffDispatchRunning = false
      server.handoffDispatcherReady = true
      server.handoffDispatchTimer = null
      server.scheduleHandoffDispatch = vi.fn()
      server.storage = {
        recoverInterruptedHandoffJobs: vi.fn(),
        claimHandoffJobs: vi.fn().mockReturnValueOnce([job]).mockReturnValue([]),
        getMessage: vi.fn(() => ({
          id: 'message-1', content: '@A hello', senderName: 'Human', senderId: 'human-1', timestamp: 100, role: 'user',
        })),
        renewHandoffLease: vi.fn(() => {
          order.push('renew-failed')
          return false
        }),
        fenceHandoffJobAfterLeaseLoss: vi.fn(() => {
          order.push('durable-fence')
          return true
        }),
        markHandoffJobFailed: vi.fn(),
        rescheduleHandoffJobWithoutAttempt: vi.fn(),
      }
      server.agentClients = {
        processHandoffJob: vi.fn(() => new Promise<void>(resolve => { finishRun = resolve })),
        interruptAgent: vi.fn(async () => {
          order.push('runtime-interrupt')
          finishRun()
        }),
      }

      const drain = server.drainHandoffJobs()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)
      server.handoffDispatcherReady = false
      const observedOrder = [...order]
      if (!order.includes('runtime-interrupt')) finishRun()
      await drain

      expect(observedOrder.slice(0, 3)).toEqual(['renew-failed', 'durable-fence', 'runtime-interrupt'])
      expect(server.agentClients.interruptAgent).toHaveBeenCalledWith('room-1', 'agent-a')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('fixed-order group-chat handoff planning', () => {
  it('does not continue a chain from an error final', () => {
    expect(shouldPlanGroupHandoffs({ role: 'assistant', handoffFinal: true, finish_reason: 'error' }, true)).toBe(false)
    expect(shouldPlanGroupHandoffs({ role: 'assistant', handoffFinal: true, finish_reason: null }, true)).toBe(true)
  })

  const agents = [
    { agentId: 'a', id: 'row-a', name: 'Hermes', sessionId: 'session-a' },
    { agentId: 'b', id: 'row-b', name: 'Codex', sessionId: 'session-b' },
    { agentId: 'c', id: 'row-c', name: 'Claude Code', sessionId: 'session-c' },
  ] as any[]

  it('uses the configured successor even when the model omitted the mention', () => {
    expect(planGroupHandoffs({
      room: { handoffMode: 'fixed', handoffOrderJson: '["a","b","c"]', maxAgentMentionDepth: 4 },
      agents,
      source: { senderId: 'a', content: '业精于勤。', role: 'assistant', handoffDepth: 1, handoffChainId: 'chain-1' },
      sourceJobKind: 'fixed',
    })).toEqual([{ chainId: 'chain-1', targetAgentId: 'b', targetSessionId: 'session-b', depth: 1, kind: 'fixed' }])
  })

  it('stops after the configured emitted-response depth', () => {
    expect(planGroupHandoffs({
      room: { handoffMode: 'fixed', handoffOrderJson: '["a","b","c"]', maxAgentMentionDepth: 4 },
      agents,
      source: { senderId: 'a', content: '@Codex ignored', role: 'assistant', handoffDepth: 5, handoffChainId: 'chain-1' },
      sourceJobKind: 'fixed',
    })).toEqual([])
  })

  it('keeps @all as parallel fan-out instead of converting it into ordered relay', () => {
    const plans = planGroupHandoffs({
      room: { handoffMode: 'fixed', handoffOrderJson: '["a","b","c"]', maxAgentMentionDepth: 4 },
      agents,
      source: { id: 'human-1', senderId: 'human', content: '@all hello', role: 'user', handoffDepth: 0 },
    })
    expect(plans).toHaveLength(3)
    expect(plans.every(plan => plan.kind === 'fanout' && plan.chainId === 'gcchain_human-1')).toBe(true)
    expect(plans.map(plan => plan.depth)).toEqual([0, 0, 0])
  })
})
