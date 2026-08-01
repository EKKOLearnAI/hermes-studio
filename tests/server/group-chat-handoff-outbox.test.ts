import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'

const dbMock = vi.hoisted(() => ({ current: null as DatabaseSync | null }))

vi.mock('../../packages/server/src/db/index', () => ({
  getDb: () => dbMock.current,
  getStoragePath: () => ':memory:',
  isSqliteAvailable: () => true,
}))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
  isAuthEnabled: vi.fn(async () => false),
  authenticateUserToken: vi.fn(),
}))

import {
  GC_HANDOFF_JOBS_TABLE,
  GC_RUNTIME_FENCES_TABLE,
  initAllHermesTables,
} from '../../packages/server/src/db/hermes/schemas'
import {
  ChatStorage,
  GroupChatServer,
  planGroupHandoffs,
  shouldPlanGroupHandoffs,
} from '../../packages/server/src/services/hermes/group-chat'
import { claimTestHermesDbOwnership } from './db-test-helpers'
import { addMessage, createSession, getSession } from '../../packages/server/src/db/hermes/session-store'
import { insertWorkspaceRunChange } from '../../packages/server/src/db/hermes/workspace-run-changes-store'

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
  beforeEach(async () => {
    dbMock.current?.close()
    dbMock.current = new DatabaseSync(':memory:')
    await claimTestHermesDbOwnership(dbMock.current)
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
    const fenceColumns = db.prepare(`PRAGMA table_info("${GC_RUNTIME_FENCES_TABLE}")`).all() as Array<{ name: string }>
    expect(fenceColumns.map(column => column.name)).toEqual([
      'token', 'roomId', 'actorId', 'kind', 'reason', 'createdAt', 'expiresAt',
    ])
  })

  it('fences participant jobs without revoking participant capabilities before runtime synchronization', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-fence-state', 'Room', 'ROOM1')
    storage.addRoomAgent('room-fence-state', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const actor = storage.findActiveActorByAgentIdentity('room-fence-state', 'agent-a')!
    const capabilitiesBefore = storage.getActorCapabilities(actor.id)
    const revisionBefore = actor.authorizationRevision

    const fence = storage.beginParticipantRuntimeMutation('room-fence-state', 'agent-a', 'Participant is being deleted')

    expect(storage.getActorCapabilities(actor.id)).toEqual(capabilitiesBefore)
    expect(storage.findActiveActorByAgentIdentity('room-fence-state', 'agent-a')).toMatchObject({
      authorizationRevision: revisionBefore,
      active: 1,
    })
    expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(true)
  })

  it('rejects new handoff admission involving a participant while its durable deletion fence is held', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-participant-admission-fence', 'Room', 'ROOM1')
    const target = storage.addRoomAgent(
      'room-participant-admission-fence', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' },
    )
    const source = createAuthorizedSource(storage, 'room-participant-admission-fence')
    const fence = storage.beginParticipantRuntimeMutation(
      'room-participant-admission-fence', target.agentId, 'Participant is being deleted',
    )

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'message-during-participant-delete', roomId: 'room-participant-admission-fence',
      senderId: 'human-1', senderName: 'Human', content: '@A race', timestamp: 1, role: 'user',
    }, {
      handoffs: [{
        chainId: 'chain-race', targetAgentId: target.agentId, targetSessionId: target.sessionId,
        depth: 0, kind: 'mention',
      }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })).toThrow(/runtime mutation|delet/i)
    expect(storage.getMessage('message-during-participant-delete')).toBeNull()

    expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(true)
  })

  it.each(['initiator', 'source', 'target'] as const)(
    'rejects admission, claim, and prelaunch while the deleting participant is the %s actor',
    (deletingRole) => {
      const storage = new ChatStorage()
      storage.init()
      const roomId = `room-participant-${deletingRole}-fence`
      storage.saveRoom(roomId, 'Room', 'ROOM1')
      const deleting = storage.addRoomAgent(
        roomId, `agent-${deletingRole}`, 'default', 'Deleting', '', 0,
        { sessionId: `session-${deletingRole}` },
      )
      const survivor = storage.addRoomAgent(
        roomId, `agent-survivor-${deletingRole}`, 'default', 'Survivor', '', 0,
        { sessionId: `session-survivor-${deletingRole}` },
      )
      const human = createAuthorizedSource(storage, roomId)
      const deletingActor = storage.findActiveActorByAgentIdentity(roomId, deleting.agentId)!
      const target = deletingRole === 'target' ? deleting : survivor
      const authority = {
        initiatorActorId: deletingRole === 'initiator' ? deletingActor.id : human.id,
        sourceActorId: deletingRole === 'source' ? deletingActor.id : human.id,
      }
      const sourceMessageId = `message-before-${deletingRole}-delete`
      storage.saveMessageAndRefreshRoom({
        id: sourceMessageId, roomId, senderId: 'human-1', senderName: 'Human',
        content: `@${target.name} before delete`, timestamp: 1, role: 'user',
      }, {
        handoffs: [{
          chainId: `chain-${deletingRole}`, targetAgentId: target.agentId,
          targetSessionId: target.sessionId, depth: 0, kind: 'mention',
        }],
        authority,
      })
      const existing = storage.listHandoffJobs(roomId)[0]
      const fence = storage.beginParticipantRuntimeMutation(
        roomId, deleting.agentId, 'Participant is being deleted',
      )

      expect(() => storage.saveMessageAndRefreshRoom({
        id: `message-during-${deletingRole}-delete`, roomId, senderId: 'human-1',
        senderName: 'Human', content: `@${target.name} race`, timestamp: 2, role: 'user',
      }, {
        handoffs: [{
          chainId: `chain-race-${deletingRole}`, targetAgentId: target.agentId,
          targetSessionId: target.sessionId, depth: 0, kind: 'mention',
        }],
        authority,
      })).toThrow(/runtime mutation|delet/i)
      expect(storage.getMessage(`message-during-${deletingRole}-delete`)).toBeNull()

      // Simulate a stale/concurrent writer restoring a pre-fence job. Claim and
      // immediate prelaunch must remain independent fail-closed boundaries.
      dbMock.current!.prepare(
        `UPDATE gc_handoff_jobs
         SET status = 'pending', availableAt = 0, leaseOwner = '', leaseToken = '',
             leaseExpiresAt = 0, completedAt = 0
         WHERE id = ?`,
      ).run(existing.id)
      expect(storage.claimHandoffJobs(`worker-${deletingRole}`, 10, 1, 5_000)).toEqual([])
      expect(storage.getHandoffJob(existing.id)).toMatchObject({ status: 'authorization_revoked' })

      dbMock.current!.prepare(
        `UPDATE gc_handoff_jobs
         SET status = 'running', leaseOwner = ?, leaseToken = ?, leaseExpiresAt = 999999,
             completedAt = 0
         WHERE id = ?`,
      ).run(`worker-${deletingRole}`, `lease-${deletingRole}`, existing.id)
      expect(storage.isHandoffExecutionCurrent(
        existing.id, `lease-${deletingRole}`, target.agentId, target.sessionId, 10,
      )).toBe(false)
      expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(true)
    },
  )

  it('rejects claim and current-execution checks while a durable Room mutation fence is held', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-runtime-fence', 'Room', 'ROOM1')
    const target = storage.addRoomAgent(
      'room-runtime-fence', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' },
    )
    const source = createAuthorizedSource(storage, 'room-runtime-fence')
    storage.saveMessageAndRefreshRoom({
      id: 'message-before-room-delete', roomId: 'room-runtime-fence', senderId: 'human-1',
      senderName: 'Human', content: '@A before delete', timestamp: 1, role: 'user',
    }, {
      handoffs: [{
        chainId: 'chain-before-delete', targetAgentId: target.agentId, targetSessionId: target.sessionId,
        depth: 0, kind: 'mention',
      }],
      authority: { initiatorActorId: source.id, sourceActorId: source.id },
    })
    const job = storage.listHandoffJobs('room-runtime-fence')[0]
    const fence = storage.beginRoomRuntimeMutation('room-runtime-fence', 'Room is being deleted')

    // Simulate a stale/concurrent writer bypassing normal admission. Claim and prelaunch
    // must independently enforce the durable fence.
    dbMock.current!.prepare(
      `UPDATE gc_handoff_jobs
       SET status = 'pending', availableAt = 0, leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
           completedAt = 0
       WHERE id = ?`,
    ).run(job.id)
    expect(storage.claimHandoffJobs('worker', 10, 1, 5_000)).toEqual([])
    expect(storage.getHandoffJob(job.id)).toMatchObject({ status: 'authorization_revoked' })

    dbMock.current!.prepare(
      `UPDATE gc_handoff_jobs
       SET status = 'running', leaseOwner = 'worker', leaseToken = 'lease-race', leaseExpiresAt = 999999,
           completedAt = 0
       WHERE id = ?`,
    ).run(job.id)
    expect(storage.isHandoffExecutionCurrent(job.id, 'lease-race', target.agentId, target.sessionId, 10)).toBe(false)
    expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(true)
  })

  it('renews only the current unexpired runtime mutation fence token', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-fence-renewal', 'Room', 'ROOM1')
    const fence = storage.beginRoomRuntimeMutation('room-fence-renewal', 'Room is being deleted')
    const before = dbMock.current!.prepare(
      'SELECT expiresAt FROM gc_runtime_fences WHERE token = ?',
    ).get(fence.token) as { expiresAt: number }

    expect(storage.renewRuntimeMutation(
      fence.token, fence.roomId, fence.actorId, before.expiresAt - 1, 5 * 60_000,
    )).toBe(true)
    const renewed = dbMock.current!.prepare(
      'SELECT expiresAt FROM gc_runtime_fences WHERE token = ?',
    ).get(fence.token) as { expiresAt: number }
    expect(renewed.expiresAt).toBe(before.expiresAt - 1 + 5 * 60_000)
    expect(storage.renewRuntimeMutation(
      'wrong-token', fence.roomId, fence.actorId, before.expiresAt, 5 * 60_000,
    )).toBe(false)
    expect(storage.renewRuntimeMutation(
      fence.token, 'wrong-room', fence.actorId, before.expiresAt, 5 * 60_000,
    )).toBe(false)
    expect(storage.renewRuntimeMutation(
      fence.token, fence.roomId, 'wrong-actor', before.expiresAt, 5 * 60_000,
    )).toBe(false)

    dbMock.current!.prepare('UPDATE gc_runtime_fences SET expiresAt = ? WHERE token = ?')
      .run(before.expiresAt - 2, fence.token)
    expect(storage.renewRuntimeMutation(
      fence.token, fence.roomId, fence.actorId, before.expiresAt - 1, 5 * 60_000,
    )).toBe(false)
  })

  it('rejects a runtime mutation fence whose persisted kind no longer matches its Room capability', () => {
    const storage = new ChatStorage()
    storage.init()

    storage.saveRoom('room-fence-kind-renewal', 'Room', 'ROOM1')
    const renewalFence = storage.beginRoomRuntimeMutation('room-fence-kind-renewal', 'Room is being deleted')
    const renewalRow = dbMock.current!.prepare(
      'SELECT expiresAt FROM gc_runtime_fences WHERE token = ?',
    ).get(renewalFence.token) as { expiresAt: number }
    dbMock.current!.prepare('UPDATE gc_runtime_fences SET kind = ? WHERE token = ?')
      .run('participant', renewalFence.token)
    expect(storage.renewRuntimeMutation(
      renewalFence.token, renewalFence.roomId, renewalFence.actorId, renewalRow.expiresAt - 1, 5 * 60_000,
    )).toBe(false)

    storage.saveRoom('room-fence-kind-delete', 'Room', 'ROOM2')
    const deleteGuard = storage.captureRoomDeletionGuard('room-fence-kind-delete')
    const deleteFence = storage.beginRoomRuntimeMutation('room-fence-kind-delete', 'Room is being deleted')
    deleteGuard.runtimeMutationToken = deleteFence.token
    dbMock.current!.prepare('UPDATE gc_runtime_fences SET kind = ? WHERE token = ?')
      .run('participant', deleteFence.token)
    expect(() => storage.deleteRoom('room-fence-kind-delete', deleteGuard)).toThrow(/fence changed/i)
    expect(storage.getRoom('room-fence-kind-delete')).not.toBeNull()

    storage.saveRoom('room-fence-kind-clear', 'Room', 'ROOM3')
    storage.addMessage({
      id: 'message-fence-kind-clear', roomId: 'room-fence-kind-clear', senderId: 'human', senderName: 'Human',
      content: 'keep me', timestamp: 1, role: 'user',
    })
    const clearGuard = storage.captureRoomDeletionGuard('room-fence-kind-clear')
    const clearFence = storage.beginRoomRuntimeMutation('room-fence-kind-clear', 'Room context is being cleared')
    clearGuard.runtimeMutationToken = clearFence.token
    dbMock.current!.prepare('UPDATE gc_runtime_fences SET kind = ? WHERE token = ?')
      .run('participant', clearFence.token)
    expect(() => storage.clearRoomContext('room-fence-kind-clear', clearGuard)).toThrow(/fence changed/i)
    expect(storage.getMessage('message-fence-kind-clear')).not.toBeNull()
  })

  it('releases a runtime mutation fence only when its complete persisted scope still matches', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-fence-release', 'Room', 'ROOM1')
    const fence = storage.beginRoomRuntimeMutation('room-fence-release', 'Room is being deleted')

    dbMock.current!.prepare(
      'UPDATE gc_runtime_fences SET roomId = ?, actorId = ?, kind = ? WHERE token = ?',
    ).run('other-room', 'other-actor', 'participant', fence.token)

    expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(false)
    expect(dbMock.current!.prepare(
      'SELECT roomId, actorId, kind FROM gc_runtime_fences WHERE token = ?',
    ).get(fence.token)).toEqual({ roomId: 'other-room', actorId: 'other-actor', kind: 'participant' })
  })

  it('keeps admission, claim, and prelaunch fenced past the original TTL while the owner renews', () => {
    const now = 1_700_000_000_000
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const storage = new ChatStorage()
      storage.init()
      storage.saveRoom('room-renewed-critical-section', 'Room', 'ROOM1')
      const target = storage.addRoomAgent(
        'room-renewed-critical-section', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' },
      )
      const source = createAuthorizedSource(storage, 'room-renewed-critical-section')
      storage.saveMessageAndRefreshRoom({
        id: 'message-before-renewed-fence', roomId: 'room-renewed-critical-section', senderId: 'human-1',
        senderName: 'Human', content: '@A before delete', timestamp: 1, role: 'user',
      }, {
        handoffs: [{
          chainId: 'chain-before-renewed-fence', targetAgentId: target.agentId,
          targetSessionId: target.sessionId, depth: 0, kind: 'mention',
        }],
        authority: { initiatorActorId: source.id, sourceActorId: source.id },
      })
      const job = storage.listHandoffJobs('room-renewed-critical-section')[0]
      const fence = storage.beginRoomRuntimeMutation('room-renewed-critical-section', 'Room is being deleted')

      const renewalAt = now + 4 * 60_000
      expect(storage.renewRuntimeMutation(
        fence.token, fence.roomId, fence.actorId, renewalAt, 5 * 60_000,
      )).toBe(true)
      clock.mockReturnValue(now + 6 * 60_000)

      expect(() => storage.beginRoomRuntimeMutation(
        'room-renewed-critical-section', 'Competing context clear',
      )).toThrow(/already in progress/i)
      expect(() => storage.saveMessageAndRefreshRoom({
        id: 'message-during-renewed-fence', roomId: 'room-renewed-critical-section', senderId: 'human-1',
        senderName: 'Human', content: '@A during delete', timestamp: 2, role: 'user',
      }, {
        handoffs: [{
          chainId: 'chain-during-renewed-fence', targetAgentId: target.agentId,
          targetSessionId: target.sessionId, depth: 0, kind: 'mention',
        }],
        authority: { initiatorActorId: source.id, sourceActorId: source.id },
      })).toThrow(/runtime mutation is in progress/i)

      dbMock.current!.prepare(
        `UPDATE gc_handoff_jobs
         SET status = 'pending', availableAt = 0, leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
             completedAt = 0
         WHERE id = ?`,
      ).run(job.id)
      expect(storage.claimHandoffJobs('worker', Date.now(), 1, 5_000)).toEqual([])
      dbMock.current!.prepare(
        `UPDATE gc_handoff_jobs
         SET status = 'running', leaseOwner = 'worker', leaseToken = 'lease-renewed',
             leaseExpiresAt = ?, completedAt = 0
         WHERE id = ?`,
      ).run(Date.now() + 60_000, job.id)
      expect(storage.isHandoffExecutionCurrent(
        job.id, 'lease-renewed', target.agentId, target.sessionId, Date.now(),
      )).toBe(false)

      clock.mockReturnValue(now + 10 * 60_000)
      const recovered = storage.beginRoomRuntimeMutation(
        'room-renewed-critical-section', 'Crash recovery mutation',
      )
      expect(recovered.token).not.toBe(fence.token)
      expect(storage.releaseRuntimeMutation(recovered.token, recovered.roomId, recovered.actorId)).toBe(true)
    } finally {
      clock.mockRestore()
    }
  })

  it('serializes destructive Room mutations and recovers an expired crash fence', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-fence-lease', 'Room', 'ROOM1')
    const first = storage.beginRoomRuntimeMutation('room-fence-lease', 'Room is being deleted')

    expect(() => storage.beginRoomRuntimeMutation('room-fence-lease', 'Room context is being cleared'))
      .toThrow(/already in progress/i)

    dbMock.current!.prepare('UPDATE gc_runtime_fences SET expiresAt = 0 WHERE token = ?').run(first.token)
    const retry = storage.beginRoomRuntimeMutation('room-fence-lease', 'Room context is being cleared')
    expect(retry.token).not.toBe(first.token)
    expect(storage.releaseRuntimeMutation(retry.token, retry.roomId, retry.actorId)).toBe(true)
  })

  it('binds participant deletion CAS to the exact durable fence actor scope', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-participant-fence-cas', 'Room', 'ROOM1')
    const agent = storage.addRoomAgent('room-participant-fence-cas', 'agent-a', 'default', 'A', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'session-a', mode: 'scoped',
    })
    createSession({ id: 'session-a', profile: 'default', source: 'group_chat', agent: 'codex' })
    const guard = storage.captureParticipantDeletionGuard('room-participant-fence-cas', agent.id)
    const fence = storage.beginParticipantRuntimeMutation('room-participant-fence-cas', agent.agentId, 'Participant is being deleted')
    guard.runtimeMutationToken = fence.token
    guard.runtimeMutationActorId = 'forged-actor'

    expect(() => storage.removeAgentActorWithRetention('room-participant-fence-cas', agent.id, guard))
      .toThrow(/fence changed/i)
    expect(storage.getRoomAgent('room-participant-fence-cas', agent.id)).not.toBeNull()
    expect(getSession('session-a')).not.toBeNull()
    expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(true)
  })

  it('consumes the participant runtime fence with the complete durable actor scope', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-participant-fence-consume', 'Room', 'ROOM1')
    const agent = storage.addRoomAgent('room-participant-fence-consume', 'agent-a', 'default', 'A', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'session-a', mode: 'scoped',
    })
    createSession({ id: 'session-a', profile: 'default', source: 'group_chat', agent: 'codex' })
    const guard = storage.captureParticipantDeletionGuard('room-participant-fence-consume', agent.id)
    const fence = storage.beginParticipantRuntimeMutation(
      'room-participant-fence-consume', agent.agentId, 'Participant is being deleted',
    )
    guard.runtimeMutationToken = fence.token
    guard.runtimeMutationActorId = fence.actorId
    const preparedSql: string[] = []
    const db = dbMock.current!
    const originalPrepare = db.prepare.bind(db)
    const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      preparedSql.push(sql.replace(/\s+/g, ' ').trim())
      return originalPrepare(sql)
    })

    try {
      expect(storage.removeAgentActorWithRetention('room-participant-fence-consume', agent.id, guard))
        .toMatchObject({ agent: { id: agent.id } })
    } finally {
      prepareSpy.mockRestore()
    }

    expect(preparedSql).toContainEqual(expect.stringMatching(
      /^DELETE FROM gc_runtime_fences WHERE token = \? AND roomId = \? AND actorId = \? AND kind = 'participant'$/,
    ))
    expect(storage.getRoomAgent('room-participant-fence-consume', agent.id)).toBeNull()
    expect(storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)).toBe(false)
  })

  it('fails participant deletion closed when the persisted runtime binding changes after synchronization', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-participant-cas', 'Room', 'ROOM1')
    const agent = storage.addRoomAgent('room-participant-cas', 'agent-a', 'default', 'A', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'session-a', mode: 'scoped',
    })
    createSession({ id: 'session-a', profile: 'default', source: 'group_chat', agent: 'codex' })
    createSession({ id: 'session-rotated', profile: 'default', source: 'group_chat', agent: 'codex' })
    const guard = storage.captureParticipantDeletionGuard('room-participant-cas', agent.id)
    dbMock.current!.prepare(
      `UPDATE gc_room_agents SET sessionId = ?, sessionGeneration = sessionGeneration + 1
       WHERE roomId = ? AND id = ?`,
    ).run('session-rotated', 'room-participant-cas', agent.id)

    expect(() => storage.removeAgentActorWithRetention('room-participant-cas', agent.id, guard))
      .toThrow(/runtime identity changed/i)
    expect(storage.getRoomAgent('room-participant-cas', agent.id)).toMatchObject({ sessionId: 'session-rotated' })
    expect(getSession('session-a')).not.toBeNull()
    expect(getSession('session-rotated')).not.toBeNull()
  })

  it('fails Room deletion closed when its participant binding set changes after synchronization', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-delete-cas', 'Room', 'ROOM1')
    storage.addRoomAgent('room-delete-cas', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const guard = storage.captureRoomDeletionGuard('room-delete-cas')
    storage.addRoomAgent('room-delete-cas', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })

    expect(() => storage.deleteRoom('room-delete-cas', guard)).toThrow(/Room runtime identity changed/i)
    expect(storage.getRoom('room-delete-cas')).not.toBeNull()
    expect(storage.getRoomAgents('room-delete-cas')).toHaveLength(2)
  })

  it('fails context rotation closed when its stopped participant binding set changes', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-clear-cas', 'Room', 'ROOM1')
    const agent = storage.addRoomAgent('room-clear-cas', 'agent-a', 'default', 'A', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'session-clear-old', mode: 'scoped',
    })
    createSession({ id: 'session-clear-old', profile: 'default', source: 'group_chat', agent: 'codex' })
    storage.addMessage({
      id: 'message-clear-preserved', roomId: 'room-clear-cas', senderId: 'human', senderName: 'Human',
      content: 'keep me', timestamp: 1, role: 'user',
    })
    const guard = storage.captureRoomDeletionGuard('room-clear-cas')
    dbMock.current!.prepare(
      `UPDATE gc_room_agents SET sessionId = ?, sessionGeneration = sessionGeneration + 1
       WHERE roomId = ? AND id = ?`,
    ).run('session-clear-new', 'room-clear-cas', agent.id)

    expect(() => storage.clearRoomContext('room-clear-cas', guard)).toThrow(/Room runtime identity changed/i)
    expect(storage.getMessage('message-clear-preserved')).not.toBeNull()
    expect(storage.getRoomAgent('room-clear-cas', agent.id)).toMatchObject({ sessionId: 'session-clear-new' })
    expect(getSession('session-clear-old')).not.toBeNull()
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

  it('enforces stable agent identity and case-insensitive mention-name uniqueness in SQLite', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-unique', 'Room', 'ROOM1')
    storage.addRoomAgent('room-unique', 'agent-a', 'default', 'Worker', '', 0)

    const db = dbMock.current!
    const columns = [
      'id', 'roomId', 'agentId', 'profile', 'name', 'description', 'invited', 'runtime',
      'codingAgentId', 'sessionId', 'sessionGeneration', 'mode', 'provider', 'model',
      'apiMode', 'reasoningEffort', 'avatar', 'lastSeenRoomSeq', 'lastSuccessfulRunId',
      'checkpoint', 'checkpointSourceMessageIds', 'checkpointFromRoomSeq',
      'checkpointThroughRoomSeq', 'createdAt',
    ]
    const insertSql = `INSERT INTO gc_room_agents (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    const values = (id: string, agentId: string, name: string) => [
      id, 'room-unique', agentId, 'default', name, '', 0, 'hermes', '',
      `session-${id}`, 0, 'scoped', '', '', '', '', '', 0, '', '', '[]', 0, 0, Date.now(),
    ]

    expect(() => db.prepare(insertSql).run(...values('duplicate-id', 'agent-a', 'Other'))).toThrow()
    expect(() => db.prepare(insertSql).run(...values('duplicate-name', 'agent-b', 'worker'))).toThrow()
  })

  it('fails closed when persisted structured mention metadata is malformed', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-corrupt-mentions', 'Room', 'ROOM1')
    storage.addMessage({
      id: 'message-corrupt-mentions', roomId: 'room-corrupt-mentions', senderId: 'human', senderName: 'Human',
      content: '@Worker', timestamp: 1, role: 'user', mentions: [],
    } as any)
    dbMock.current!.prepare('UPDATE gc_messages SET mentionsJson = ? WHERE id = ?')
      .run('[{"type":"participant"}]', 'message-corrupt-mentions')

    expect(() => storage.getMessage('message-corrupt-mentions')).toThrow(/corrupt structured mention metadata/i)
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

  it('binds fixed-chain root requests to the durable Room provenance', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-a', 'Room A', 'ROOMA')
    storage.saveRoom('room-b', 'Room B', 'ROOMB')
    const agentA = storage.addRoomAgent('room-a', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const agentB = storage.addRoomAgent('room-b', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    storage.saveMessageAndRefreshRoom({
      id: 'root-a', roomId: 'room-a', senderId: 'human-a', senderName: 'Human A',
      content: '@A request A', timestamp: 100, role: 'user',
      handoffChainId: 'shared-chain', handoffDepth: 0,
    }, authorizedHandoffs(storage, 'room-a', [{
      chainId: 'shared-chain', targetAgentId: agentA.agentId, targetSessionId: agentA.sessionId, depth: 0, kind: 'fixed',
    }]))
    storage.saveMessageAndRefreshRoom({
      id: 'root-b', roomId: 'room-b', senderId: 'human-b', senderName: 'Human B',
      content: '@B request B', timestamp: 101, role: 'user',
      handoffChainId: 'shared-chain', handoffDepth: 0,
    }, authorizedHandoffs(storage, 'room-b', [{
      chainId: 'shared-chain', targetAgentId: agentB.agentId, targetSessionId: agentB.sessionId, depth: 0, kind: 'fixed',
    }]))

    expect(storage.getHandoffChainRootMessage('room-a', 'shared-chain')).toMatchObject({
      id: 'root-a', roomId: 'room-a', content: '@A request A', role: 'user',
    })
    expect(storage.getHandoffChainRootMessage('room-b', 'shared-chain')).toMatchObject({
      id: 'root-b', roomId: 'room-b', content: '@B request B', role: 'user',
    })
    dbMock.current!.prepare('UPDATE gc_messages SET handoffChainId = ? WHERE id = ?').run('forged-chain', 'root-b')
    expect(storage.getHandoffChainRootMessage('room-b', 'shared-chain')).toBeNull()
    expect(storage.getHandoffChainRootMessage('room-a', 'missing-chain')).toBeNull()
    expect(storage.getHandoffChainRootMessage('', 'shared-chain')).toBeNull()
  })

  it('deletes only Room-owned Coding Agent Studio sessions while retaining usage audit', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-cleanup', 'Room', 'ROOM1')
    const codex = storage.addRoomAgent('room-cleanup', 'agent-codex', 'default', 'Codex', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-room-cleanup-codex-0',
      mode: 'scoped', provider: 'provider', model: 'model', apiMode: 'codex_responses',
    })
    const claude = storage.addRoomAgent('room-cleanup', 'agent-claude', 'default', 'Claude', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'claude-code', sessionId: 'gc-room-cleanup-claude-0',
      mode: 'scoped', provider: 'provider', model: 'model', apiMode: 'anthropic_messages',
    })
    storage.saveSessionProfile(codex.sessionId, 'room-cleanup', codex.agentId, codex.profile)
    storage.saveSessionProfile(claude.sessionId, 'room-cleanup', claude.agentId, claude.profile)
    createSession({ id: codex.sessionId, profile: 'default', source: 'group_chat', agent: 'codex' })
    createSession({ id: claude.sessionId, profile: 'default', source: 'group_chat', agent: 'claude' })
    createSession({ id: 'ordinary-codex-chat', profile: 'default', source: 'coding_agent', agent: 'codex' })
    addMessage({ session_id: codex.sessionId, role: 'assistant', content: 'codex result' })
    addMessage({ session_id: claude.sessionId, role: 'assistant', content: 'claude result' })
    addMessage({ session_id: 'ordinary-codex-chat', role: 'assistant', content: 'keep me' })
    insertWorkspaceRunChange(dbMock.current!, {
      change_id: 'change-codex', room_id: 'room-cleanup', session_id: codex.sessionId,
      workspace: '/tmp/workspace', started_at: 1, finished_at: 2, files_changed: 1,
      additions: 1, deletions: 0, total_patch_bytes: 1,
      files: [{ path: 'a.txt', change_type: 'added', additions: 1, deletions: 0, patch: '+a', patch_bytes: 1 }],
    })
    dbMock.current!.prepare(
      `INSERT INTO session_usage (session_id, run_id, source, agent, api_calls, input_tokens, output_tokens, created_at)
       VALUES (?, ?, 'run', 'codex', 1, 1, 1, 1)`,
    ).run(codex.sessionId, 'run-codex')

    storage.deleteRoom('room-cleanup')

    expect(getSession(codex.sessionId)).toBeNull()
    expect(getSession(claude.sessionId)).toBeNull()
    expect(getSession('ordinary-codex-chat')).not.toBeNull()
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM messages WHERE session_id IN (?, ?)').get(codex.sessionId, claude.sessionId)).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM workspace_run_changes WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM workspace_run_change_files WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM session_usage WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 1 })
  })

  it('preserves a reused Coding Agent Session while another Room still references it', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-shared-a', 'Room A', 'ROOMA')
    storage.saveRoom('room-shared-b', 'Room B', 'ROOMB')
    const sharedSessionId = 'gc-shared-cross-room-codex-0'
    storage.addRoomAgent('room-shared-a', 'agent-codex-a', 'default', 'Codex A', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: sharedSessionId,
    })
    storage.addRoomAgent('room-shared-b', 'agent-codex-b', 'default', 'Codex B', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: sharedSessionId,
    })
    createSession({ id: sharedSessionId, profile: 'default', source: 'group_chat', agent: 'codex' })
    addMessage({ session_id: sharedSessionId, role: 'assistant', content: 'shared evidence must remain' })

    storage.deleteRoom('room-shared-a')

    expect(storage.getRoom('room-shared-a')).toBeFalsy()
    expect(storage.getRoom('room-shared-b')).toBeTruthy()
    expect(storage.getRoomAgentByAgentId('room-shared-b', 'agent-codex-b')).toMatchObject({ sessionId: sharedSessionId })
    expect(getSession(sharedSessionId)).toMatchObject({ source: 'group_chat', agent: 'codex' })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM messages WHERE session_id = ?').get(sharedSessionId)).toEqual({ total: 1 })
  })

  it('atomically deletes owned Coding Agent session evidence before rotating Room context', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-context-rotation', 'Room', 'ROOM1')
    const codex = storage.addRoomAgent('room-context-rotation', 'agent-codex', 'default', 'Codex', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-context-codex-0',
    })
    createSession({ id: codex.sessionId, profile: 'default', source: 'group_chat', agent: 'codex' })
    addMessage({ session_id: codex.sessionId, role: 'assistant', content: 'old context evidence' })
    insertWorkspaceRunChange(dbMock.current!, {
      change_id: 'change-context-codex', room_id: codex.roomId, session_id: codex.sessionId,
      workspace: '/tmp/workspace', started_at: 1, finished_at: 2, files_changed: 1,
      additions: 1, deletions: 0, total_patch_bytes: 1,
      files: [{ path: 'context.txt', change_type: 'added', additions: 1, deletions: 0, patch: '+context', patch_bytes: 1 }],
    })
    dbMock.current!.prepare(
      `INSERT INTO session_usage (session_id, run_id, source, agent, api_calls, input_tokens, output_tokens, created_at)
       VALUES (?, ?, 'run', 'codex', 1, 1, 1, 1)`,
    ).run(codex.sessionId, 'run-context-codex')

    storage.clearRoomContext(codex.roomId)

    const rotated = storage.getRoomAgentByAgentId(codex.roomId, codex.agentId)
    expect(rotated?.sessionGeneration).toBe(1)
    expect(rotated?.sessionId).not.toBe(codex.sessionId)
    expect(getSession(codex.sessionId)).toBeNull()
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM messages WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM workspace_run_changes WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM workspace_run_change_files WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM session_usage WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 1 })
  })

  it('removes only the deleted participant owned Coding Agent Studio session', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-participant-cleanup', 'Room', 'ROOM1')
    const codex = storage.addRoomAgent('room-participant-cleanup', 'agent-codex', 'default', 'Codex', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-participant-codex-0',
    })
    const claude = storage.addRoomAgent('room-participant-cleanup', 'agent-claude', 'default', 'Claude', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'claude-code', sessionId: 'gc-participant-claude-0',
    })
    storage.saveSessionProfile(codex.sessionId, codex.roomId, codex.agentId, codex.profile)
    storage.saveSessionProfile(claude.sessionId, claude.roomId, claude.agentId, claude.profile)
    createSession({ id: codex.sessionId, profile: 'default', source: 'group_chat', agent: 'codex' })
    createSession({ id: claude.sessionId, profile: 'default', source: 'group_chat', agent: 'claude' })
    addMessage({ session_id: codex.sessionId, role: 'assistant', content: 'delete me' })
    addMessage({ session_id: claude.sessionId, role: 'assistant', content: 'keep me' })

    const removal = storage.removeAgentActorWithRetention(codex.roomId, codex.agentId)

    expect(removal?.agent).toMatchObject({ agentId: codex.agentId, sessionId: codex.sessionId })
    expect(getSession(codex.sessionId)).toBeNull()
    expect(getSession(claude.sessionId)).not.toBeNull()
    expect(storage.getRoom(codex.roomId)).not.toBeNull()
    expect(storage.getRoomAgentByAgentId(codex.roomId, codex.agentId)).toBeNull()
    expect(storage.getRoomAgentByAgentId(claude.roomId, claude.agentId)).not.toBeNull()
  })

  it('fails closed instead of deleting a mismatched Group Chat Session identity', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-mismatch', 'Room', 'ROOM1')
    const codex = storage.addRoomAgent('room-mismatch', 'agent-codex', 'default', 'Codex', '', 0, {
      runtime: 'coding_agent', codingAgentId: 'codex', sessionId: 'gc-mismatched-session',
    })
    createSession({ id: codex.sessionId, profile: 'default', source: 'group_chat', agent: 'claude' })
    addMessage({ session_id: codex.sessionId, role: 'assistant', content: 'must remain' })

    storage.removeAgentActorWithRetention(codex.roomId, codex.agentId)

    expect(getSession(codex.sessionId)).toMatchObject({ source: 'group_chat', agent: 'claude' })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM messages WHERE session_id = ?').get(codex.sessionId)).toEqual({ total: 1 })
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

  it('rejects reuse of a routed message id with different content or structured targets', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    const plan = [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' as const }]
    storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A original', timestamp: 100, role: 'user',
      mentions: [{ type: 'participant', participantId: a.agentId, displayName: 'A', start: 0, length: 2 }],
    }, authorizedHandoffs(storage, 'room-1', plan))

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A changed', timestamp: 101, role: 'user',
      mentions: [{ type: 'participant', participantId: a.agentId, displayName: 'A', start: 0, length: 2 }],
    }, authorizedHandoffs(storage, 'room-1', plan))).toThrow(/message id conflict/i)
    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A original', timestamp: 100, role: 'user',
      mentions: [{ type: 'participant', participantId: b.agentId, displayName: 'A', start: 0, length: 2 }],
    }, authorizedHandoffs(storage, 'room-1', plan))).toThrow(/message id conflict/i)
    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A original', timestamp: 100, role: 'user',
      mentions: [{ type: 'participant', participantId: a.agentId, displayName: 'A', start: 0, length: 2 }],
    }, authorizedHandoffs(storage, 'room-1', [{
      ...plan[0], kind: 'fixed', chainOrderJson: JSON.stringify([a.agentId, b.agentId]),
    }]))).toThrow(/message id conflict/i)
    expect(storage.getMessage('human-message-1')).toMatchObject({
      content: '@A original',
      mentions: [{ type: 'participant', participantId: a.agentId }],
    })
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

  it('keeps the durable root request while a fixed successor is pending', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-fixed-retention', 'Room', 'ROOM1')
    const first = storage.addRoomAgent('room-fixed-retention', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const second = storage.addRoomAgent('room-fixed-retention', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    storage.saveMessageAndRefreshRoom({
      id: 'fixed-root', roomId: 'room-fixed-retention', senderId: 'human-1', senderName: 'Human',
      content: 'A answer ROOT-A; B answer ROOT-B', timestamp: 100, role: 'user',
      handoffChainId: 'fixed-chain', handoffDepth: 0,
    }, authorizedHandoffs(storage, 'room-fixed-retention', [{
      chainId: 'fixed-chain', targetAgentId: first.agentId, targetSessionId: first.sessionId, depth: 0, kind: 'fixed',
    }]))
    const firstJob = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    storage.saveMessageAndRefreshRoom({
      id: 'fixed-predecessor', roomId: 'room-fixed-retention', senderId: first.agentId, senderName: 'A',
      content: 'ROOT-A', timestamp: 200, role: 'assistant',
      handoffChainId: firstJob.chainId, handoffDepth: 1, sourceHandoffJobId: firstJob.id,
      sourceHandoffLeaseToken: firstJob.leaseToken, agentSessionId: first.sessionId, handoffFinal: true,
    }, {
      handoffs: [{
        chainId: firstJob.chainId, targetAgentId: second.agentId, targetSessionId: second.sessionId, depth: 1, kind: 'fixed',
      }],
      authority: { initiatorActorId: firstJob.initiatorActorId, sourceActorId: firstJob.targetActorId },
    })
    storage.addMessage({
      id: 'newer-message', roomId: 'room-fixed-retention', senderId: 'human-1', senderName: 'Human',
      content: 'newer', timestamp: 300, role: 'user',
    })
    storage.saveContextSnapshot('room-fixed-retention', 'root covered', 'fixed-root', 100, 1)
    storage.saveRoom('room-fixed-retention-other', 'Other Room', 'ROOM2')
    const other = storage.addRoomAgent('room-fixed-retention-other', 'agent-other', 'default', 'Other', '', 0, { sessionId: 'session-other' })
    storage.saveMessageAndRefreshRoom({
      id: 'other-fixed-root', roomId: 'room-fixed-retention-other', senderId: 'human-2', senderName: 'Other Human',
      content: 'other request', timestamp: 50, role: 'user',
      handoffChainId: 'fixed-chain', handoffDepth: 0,
    }, authorizedHandoffs(storage, 'room-fixed-retention-other', [{
      chainId: 'fixed-chain', targetAgentId: other.agentId, targetSessionId: other.sessionId, depth: 0, kind: 'fixed',
    }]))

    const result = storage.pruneMessages('room-fixed-retention', 1)

    expect(result.pruned).toBe(0)
    expect(storage.getHandoffChainRootMessage('room-fixed-retention', 'fixed-chain')).toMatchObject({
      id: 'fixed-root', content: 'A answer ROOT-A; B answer ROOT-B',
    })
    expect(storage.getHandoffChainRootMessage('room-fixed-retention-other', 'fixed-chain')).toMatchObject({
      id: 'other-fixed-root', content: 'other request',
    })
    expect(storage.listHandoffJobs('room-fixed-retention')).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetAgentId: second.agentId, depth: 1, kind: 'fixed', status: 'pending' }),
    ]))
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

    const replay = storage.saveMessageAndRefreshRoom({
      id: 'assistant-message-1', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'answer without any mention', timestamp: 200, role: 'assistant',
      handoffChainId: source.chainId, handoffDepth: 1, sourceHandoffJobId: source.id,
      sourceHandoffLeaseToken: source.leaseToken, agentSessionId: a.sessionId, handoffFinal: true,
    }, {
      handoffs: [{ chainId: source.chainId, targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 1, kind: 'fixed' }],
      authority: { initiatorActorId: source.initiatorActorId, sourceActorId: source.targetActorId },
    })
    expect(replay.message.id).toBe(saved.message.id)
    expect(replay.handoffJobs).toEqual(saved.handoffJobs)
    expect(storage.getHandoffJob(source.id)).toMatchObject({ status: 'completed', completedAt: 200 })

    storage.saveMessageAndRefreshRoom({
      id: 'next-human-message', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A next', timestamp: 300, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', [{
      chainId: 'next-chain', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention',
    }]))
    const nextRunning = storage.claimHandoffJobs('process-1', 400, 10, 5_000)
      .find(job => job.targetAgentId === a.agentId)!
    expect(nextRunning).toMatchObject({ targetAgentId: a.agentId, status: 'running' })
    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'assistant-message-1', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'answer without any mention', timestamp: 200, role: 'assistant',
      handoffChainId: source.chainId, handoffDepth: 1, sourceHandoffJobId: source.id,
      sourceHandoffLeaseToken: source.leaseToken, agentSessionId: a.sessionId, handoffFinal: true,
    })).toThrow(/running job|handoff publication/i)
  })

  it('rejects a leased final that substitutes another same-Room chain or depth', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 0, { sessionId: 'session-b' })
    storage.saveMessageAndRefreshRoom({
      id: 'chain-a-root', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: 'task A', timestamp: 100, role: 'user', handoffChainId: 'chain-a', handoffDepth: 0,
    }, authorizedHandoffs(storage, 'room-1', [{
      chainId: 'chain-a', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'fixed',
    }]))
    storage.saveMessageAndRefreshRoom({
      id: 'chain-b-root', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: 'task B', timestamp: 101, role: 'user', handoffChainId: 'chain-b', handoffDepth: 0,
    }, authorizedHandoffs(storage, 'room-1', [{
      chainId: 'chain-b', targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 0, kind: 'fixed',
    }]))
    const runningA = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(runningA).toMatchObject({ chainId: 'chain-a', depth: 0, status: 'running' })

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'forged-chain-final', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'forged answer', timestamp: 200, role: 'assistant',
      handoffChainId: 'chain-b', handoffDepth: 1, sourceHandoffJobId: runningA.id,
      sourceHandoffLeaseToken: runningA.leaseToken, agentSessionId: a.sessionId, handoffFinal: true,
    }, {
      handoffs: [{ chainId: 'chain-b', targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 1, kind: 'fixed' }],
      authority: { initiatorActorId: runningA.initiatorActorId, sourceActorId: runningA.targetActorId },
    })).toThrow(/handoff publication|chain|depth/i)

    expect(storage.getMessage('forged-chain-final')).toBeNull()
    expect(storage.getHandoffJob(runningA.id)).toMatchObject({ status: 'running', chainId: 'chain-a' })
    expect(storage.listHandoffJobs('room-1').filter(job => job.sourceMessageId === 'forged-chain-final')).toEqual([])
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

  it('rejects a durable assistant message that omits its job lease provenance', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const sourceActor = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'omitted-provenance-trigger', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, authorizedHandoffs(storage, 'room-1', [{ chainId: 'omission-chain', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }]))
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(running).toMatchObject({ targetAgentId: target.agentId, targetSessionId: target.sessionId, status: 'running' })

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'omitted-provenance-message', roomId: 'room-1', senderId: target.agentId, senderName: 'A',
      content: 'must not publish', timestamp: 200, role: 'assistant',
      agentSessionId: target.sessionId,
    })).toThrow(/provenance|handoff|lease/i)

    expect(storage.getMessage('omitted-provenance-message')).toBeNull()
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'running', leaseToken: running.leaseToken })
    expect(sourceActor.id).toBeTruthy()
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

  it('rejects workspace evidence when a running durable handoff omits provenance', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const sourceActor = createAuthorizedSource(storage, 'room-1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    storage.saveMessageAndRefreshRoom({
      id: 'workspace-omission-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'workspace-omission-chain', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: sourceActor.id, sourceActorId: sourceActor.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(running).toMatchObject({ targetAgentId: target.agentId, targetSessionId: target.sessionId, status: 'running' })

    expect(storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1', senderId: target.agentId, senderName: 'A', sessionId: target.sessionId,
      runId: 'workspace-omitted-run', status: 'completed', workspace: '/workspace/project',
      draft: {
        change_id: 'workspace-omitted-change', session_id: target.sessionId, run_id: 'workspace-omitted-run',
        source: 'run', workspace: '/workspace/project', started_at: 1, finished_at: 2,
        files_changed: 0, additions: 0, deletions: 0, total_patch_bytes: 0, files: [],
      },
    } as any)).toBeNull()
    expect(dbMock.current!.prepare("SELECT COUNT(*) AS total FROM gc_messages WHERE tool_name = 'workspace_diff'").get()).toEqual({ total: 0 })
    expect(dbMock.current!.prepare('SELECT COUNT(*) AS total FROM workspace_run_changes').get()).toEqual({ total: 0 })
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'running', leaseToken: running.leaseToken })
  })

  it('rejects a current durable lease reusing an existing workspace run id', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const runId = 'workspace-reused-run'
    const original = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1', senderId: target.agentId, senderName: 'A', sessionId: target.sessionId,
      runId, status: 'completed', workspace: '/workspace/project',
      draft: {
        change_id: 'original-workspace-change', session_id: target.sessionId, run_id: runId,
        source: 'run', workspace: '/workspace/project', started_at: 1, finished_at: 2,
        files_changed: 0, additions: 0, deletions: 0, total_patch_bytes: 0, files: [],
      },
    } as any)
    expect(original).not.toBeNull()
    const originalMessage = storage.getMessage(original!.message.id)
    const originalChange = dbMock.current!.prepare(
      'SELECT change_id, message_id FROM workspace_run_changes WHERE room_id = ? AND message_id = ?',
    ).get('room-1', original!.message.id)

    const sourceActor = createAuthorizedSource(storage, 'room-1')
    storage.saveMessageAndRefreshRoom({
      id: 'workspace-reuse-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'workspace-reuse-chain', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: sourceActor.id, sourceActorId: sourceActor.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(running).toMatchObject({ targetAgentId: target.agentId, targetSessionId: target.sessionId, status: 'running' })

    const overwritten = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1', senderId: target.agentId, senderName: 'A', sessionId: target.sessionId,
      runId, status: 'completed', workspace: '/workspace/project',
      sourceHandoffJobId: running.id, sourceHandoffLeaseToken: running.leaseToken,
      draft: {
        change_id: 'forged-current-workspace-change', session_id: target.sessionId, run_id: runId,
        source: 'run', workspace: '/workspace/project', started_at: 3, finished_at: 4,
        files_changed: 0, additions: 0, deletions: 0, total_patch_bytes: 0, files: [],
      },
    } as any)

    expect(overwritten).toBeNull()
    expect(storage.getMessage(original!.message.id)).toEqual(originalMessage)
    expect(dbMock.current!.prepare(
      'SELECT change_id, message_id FROM workspace_run_changes WHERE room_id = ? AND message_id = ?',
    ).get('room-1', original!.message.id)).toEqual(originalChange)
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'running', leaseToken: running.leaseToken })
  })

  it('rejects a current durable lease reusing an existing workspace change id', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const target = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const changeId = 'workspace-reused-change'
    const original = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1', senderId: target.agentId, senderName: 'A', sessionId: target.sessionId,
      runId: 'workspace-original-run', status: 'completed', workspace: '/workspace/project',
      draft: {
        change_id: changeId, session_id: target.sessionId, run_id: 'workspace-original-run',
        source: 'run', workspace: '/workspace/project', started_at: 1, finished_at: 2,
        files_changed: 1, additions: 1, deletions: 0, total_patch_bytes: 10,
        files: [{ path: 'original.txt', change_type: 'added', additions: 1, deletions: 0, patch: 'original', patch_bytes: 10 }],
      },
    } as any)
    expect(original).not.toBeNull()
    const originalMessage = storage.getMessage(original!.message.id)
    const originalChange = dbMock.current!.prepare(
      'SELECT * FROM workspace_run_changes WHERE room_id = ? AND change_id = ?',
    ).get('room-1', changeId)
    const originalFiles = dbMock.current!.prepare(
      'SELECT path, patch FROM workspace_run_change_files WHERE change_id = ? ORDER BY path',
    ).all(changeId)
    const roomTokensBefore = storage.getRoom('room-1')?.totalTokens
    const maxRoomSeqBefore = dbMock.current!.prepare(
      'SELECT MAX(roomSeq) AS maxRoomSeq FROM gc_messages WHERE roomId = ?',
    ).get('room-1')

    const sourceActor = createAuthorizedSource(storage, 'room-1')
    storage.saveMessageAndRefreshRoom({
      id: 'workspace-change-reuse-input', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{ chainId: 'workspace-change-reuse-chain', targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }],
      authority: { initiatorActorId: sourceActor.id, sourceActorId: sourceActor.id },
    })
    const running = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]
    expect(running).toMatchObject({ targetAgentId: target.agentId, targetSessionId: target.sessionId, status: 'running' })
    const roomTokensAfterHandoff = storage.getRoom('room-1')?.totalTokens
    const maxRoomSeqAfterHandoff = dbMock.current!.prepare(
      'SELECT MAX(roomSeq) AS maxRoomSeq FROM gc_messages WHERE roomId = ?',
    ).get('room-1')
    expect((maxRoomSeqAfterHandoff as any).maxRoomSeq).toBeGreaterThan((maxRoomSeqBefore as any).maxRoomSeq)
    expect(roomTokensAfterHandoff).toBeGreaterThanOrEqual(roomTokensBefore || 0)

    const overwritten = storage.saveWorkspaceDiffMessageForRun({
      roomId: 'room-1', senderId: target.agentId, senderName: 'A', sessionId: target.sessionId,
      runId: 'workspace-forged-run', status: 'completed', workspace: '/workspace/project',
      sourceHandoffJobId: running.id, sourceHandoffLeaseToken: running.leaseToken,
      draft: {
        change_id: changeId, session_id: target.sessionId, run_id: 'workspace-forged-run',
        source: 'run', workspace: '/workspace/project', started_at: 3, finished_at: 4,
        files_changed: 1, additions: 0, deletions: 1, total_patch_bytes: 9,
        files: [{ path: 'forged.txt', change_type: 'deleted', additions: 0, deletions: 1, patch: 'forged', patch_bytes: 9 }],
      },
    } as any)

    expect(overwritten).toBeNull()
    expect(storage.getMessage(original!.message.id)).toEqual(originalMessage)
    expect(dbMock.current!.prepare(
      'SELECT * FROM workspace_run_changes WHERE room_id = ? AND change_id = ?',
    ).get('room-1', changeId)).toEqual(originalChange)
    expect(dbMock.current!.prepare(
      'SELECT path, patch FROM workspace_run_change_files WHERE change_id = ? ORDER BY path',
    ).all(changeId)).toEqual(originalFiles)
    expect(dbMock.current!.prepare(
      'SELECT COUNT(*) AS total FROM gc_messages WHERE tool_call_id = ?',
    ).get('workspace_diff:workspace-forged-run')).toEqual({ total: 0 })
    expect(storage.getRoom('room-1')?.totalTokens).toBe(roomTokensAfterHandoff)
    expect(dbMock.current!.prepare(
      'SELECT MAX(roomSeq) AS maxRoomSeq FROM gc_messages WHERE roomId = ?',
    ).get('room-1')).toEqual(maxRoomSeqAfterHandoff)
    expect(storage.getHandoffJob(running.id)).toMatchObject({ status: 'running', leaseToken: running.leaseToken })
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

  it('fences successor jobs whose durable source actor is the deleted participant', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    const a = storage.addRoomAgent('room-1', 'agent-a', 'default', 'A', '', 0, { sessionId: 'session-a' })
    const b = storage.addRoomAgent('room-1', 'agent-b', 'default', 'B', '', 1, { sessionId: 'session-b' })
    const c = storage.addRoomAgent('room-1', 'agent-c', 'default', 'C', '', 1, { sessionId: 'session-c' })
    const actorA = storage.ensureAgentActor('room-1', a.agentId, a.name, a.description)
    for (const [id, target] of [['human-a', a], ['human-b', b], ['human-c', c]] as const) {
      storage.saveMessageAndRefreshRoom({
        id, roomId: 'room-1', senderId: 'human-1', senderName: 'Human', content: `@${target.name}`, timestamp: 100, role: 'user',
      }, authorizedHandoffs(storage, 'room-1', [{ chainId: `chain-${id}`, targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }]))
    }
    const jobB = storage.listHandoffJobs('room-1').find(job => job.targetAgentId === b.agentId)!
    dbMock.current!.prepare(
      `UPDATE gc_handoff_jobs
       SET sourceActorId = ?, sourceActorAuthorizationRevision = ?, sourceActorContextRevision = ?, status = 'running', leaseOwner = 'worker-1', leaseToken = 'lease-b', leaseExpiresAt = 999999
       WHERE id = ?`,
    ).run(actorA.id, actorA.authorizationRevision, actorA.contextRevision, jobB.id)

    const fenced = storage.beginParticipantRuntimeMutation('room-1', a.agentId, 'Participant is being deleted')

    expect(storage.getActorCapabilities(actorA.id)).toEqual(expect.arrayContaining(['room.read', 'agent.invoke']))
    expect(fenced.affectedTargets).toEqual([
      { targetAgentId: b.agentId, targetSessionId: b.sessionId },
    ])
    expect(() => storage.beginParticipantRuntimeMutation('room-1', a.agentId, 'Participant is being deleted'))
      .toThrow(/already in progress/i)
    expect(storage.listHandoffJobs('room-1').find(job => job.targetAgentId === a.agentId)?.status).toBe('cancelled')
    expect(storage.listHandoffJobs('room-1').find(job => job.targetAgentId === b.agentId)?.status).toBe('cancelled')
    expect(storage.listHandoffJobs('room-1').find(job => job.targetAgentId === c.agentId)?.status).toBe('pending')
    expect(storage.releaseRuntimeMutation(fenced.token, fenced.roomId, fenced.actorId)).toBe(true)
    const retry = storage.beginParticipantRuntimeMutation('room-1', a.agentId, 'Participant is being deleted')
    expect(retry.affectedTargets).toEqual([
      { targetAgentId: b.agentId, targetSessionId: b.sessionId },
    ])
    expect(storage.releaseRuntimeMutation(retry.token, retry.roomId, retry.actorId)).toBe(true)
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

  it('rejects a claimed handoff at prelaunch when a destructive lifecycle fence became active', async () => {
    const server = Object.create(GroupChatServer.prototype) as any
    const job = {
      id: 'job-prelaunch-fenced', roomId: 'room-1', chainId: 'chain-1', sourceMessageId: 'message-1',
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
      isHandoffExecutionCurrent: vi.fn(() => false),
      renewHandoffLease: vi.fn(),
      getHandoffJob: vi.fn(() => ({ ...job, status: 'authorization_revoked', leaseOwner: '', leaseToken: '' })),
      fenceHandoffJobAfterLeaseLoss: vi.fn(),
      markHandoffJobFailed: vi.fn(),
      rescheduleHandoffJobWithoutAttempt: vi.fn(),
    }
    server.agentClients = {
      processHandoffJob: vi.fn(),
      interruptAgent: vi.fn(),
    }

    await server.drainHandoffJobs()

    expect(server.storage.isHandoffExecutionCurrent).toHaveBeenCalledWith(
      job.id, job.leaseToken, job.targetAgentId, job.targetSessionId,
    )
    expect(server.agentClients.processHandoffJob).not.toHaveBeenCalled()
    expect(server.storage.markHandoffJobFailed).not.toHaveBeenCalled()
    expect(server.storage.rescheduleHandoffJobWithoutAttempt).not.toHaveBeenCalled()
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
        isHandoffExecutionCurrent: vi.fn(() => true),
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
        isHandoffExecutionCurrent: vi.fn(() => true),
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
        isHandoffExecutionCurrent: vi.fn(() => true),
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

  it('routes structured mentions by stable participant identity instead of display text', () => {
    const sameNameAgents = [
      { ...agents[0], id: 'row-a', agentId: 'participant-a', sessionId: 'session-a', name: 'Worker' },
      { ...agents[1], id: 'row-b', agentId: 'participant-b', sessionId: 'session-b', name: 'Worker' },
    ] as any[]

    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents: sameNameAgents,
      source: {
        id: 'human-structured-1', senderId: 'human', content: '@Former Name please continue', role: 'user',
        mentions: [{
          type: 'participant', participantId: 'participant-b', displayName: 'Former Name', start: 0, length: 12,
        }],
      },
    } as any)).toEqual([expect.objectContaining({
      targetAgentId: 'participant-b', targetSessionId: 'session-b', kind: 'mention',
    })])
  })

  it('does not parse mention-shaped text when a structured client explicitly sent no mentions', () => {
    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: { id: 'human-structured-empty', senderId: 'human', content: '@A plain text', role: 'user', mentions: [] },
    } as any)).toEqual([])
  })

  it('keeps the text parser only as a fallback for messages without structured mention metadata', () => {
    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: { id: 'human-legacy', senderId: 'human', content: '@Codex legacy text', role: 'user' },
    })).toEqual([expect.objectContaining({ targetAgentId: 'b', kind: 'mention' })])
  })

  it('fails closed when structured mention metadata names a participant outside the Room', () => {
    expect(() => planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        id: 'human-forged', senderId: 'human', content: '@A forged', role: 'user',
        mentions: [{ type: 'participant', participantId: 'other-room-agent', displayName: 'A', start: 0, length: 2 }],
      },
    } as any)).toThrow(/structured mention participant/i)
  })

  it('plans a message-scoped structured chain from only its first participant and stops at the final participant', () => {
    const chainRequest = {
      version: 1,
      participants: [
        { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
        { type: 'participant', participantId: 'b', displayName: 'Codex', start: 10, length: 6 },
        { type: 'participant', participantId: 'c', displayName: 'Claude Code', start: 19, length: 12 },
      ],
    }
    const root = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        id: 'human-chain-request', senderId: 'human',
        content: '@Hermes → @Codex → @Claude Code compare the result', role: 'user',
        mentions: [chainRequest.participants[0]], chainRequest,
      },
    } as any)
    expect(root).toEqual([{
      chainId: 'gcchain_human-chain-request', targetAgentId: 'a', targetSessionId: 'session-a',
      depth: 0, kind: 'fixed', chainOrderJson: '["a","b","c"]',
    }])

    const second = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: { senderId: 'a', content: 'Hermes result', role: 'assistant', handoffDepth: 1, handoffChainId: 'gcchain_human-chain-request' },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)
    expect(second).toEqual([{
      chainId: 'gcchain_human-chain-request', targetAgentId: 'b', targetSessionId: 'session-b',
      depth: 1, kind: 'fixed', chainOrderJson: '["a","b","c"]',
    }])

    const stale = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents: agents.filter(agent => agent.agentId !== 'b'),
      source: { senderId: 'a', content: 'Hermes result', role: 'assistant', handoffDepth: 1, handoffChainId: 'gcchain_human-chain-request' },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)
    expect(stale).toEqual([])

    const failed = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: { senderId: 'a', content: 'failed', role: 'assistant', finish_reason: 'error', handoffDepth: 1, handoffChainId: 'gcchain_human-chain-request' },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)
    expect(failed).toEqual([])

    const final = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: { senderId: 'c', content: 'Claude result', role: 'assistant', handoffDepth: 3, handoffChainId: 'gcchain_human-chain-request' },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)
    expect(final).toEqual([])
  })

  it('fails closed when persisted message-scoped chain metadata exceeds the admission step limit', () => {
    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        senderId: 'a', content: 'Hermes result', role: 'assistant',
        handoffDepth: 1, handoffChainId: 'gcchain-hostile-persisted-order',
      },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: JSON.stringify(Array.from({ length: 101 }, () => 'a')),
    } as any)).toEqual([])
  })

  it('fails closed when a persisted message-scoped chain contains a non-string participant id', () => {
    const agentsWithNumericLookingId = [
      ...agents,
      { agentId: '7', id: 'row-7', name: 'Seven', sessionId: 'session-7' },
    ] as any[]

    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents: agentsWithNumericLookingId,
      source: {
        senderId: 'a', content: 'Hermes result', role: 'assistant',
        handoffDepth: 1, handoffChainId: 'gcchain-non-string-persisted',
      },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: JSON.stringify(['a', 7]),
    } as any)).toEqual([])
  })

  it.each([
    ['empty', ''],
    ['missing', undefined],
  ])('fails closed when %s durable message-scoped chain metadata would otherwise fall back to text mentions', (_label, chainOrderJson) => {
    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        senderId: 'a', content: '@Codex must not become the successor', role: 'assistant',
        handoffDepth: 1, handoffChainId: 'gcchain-missing-persisted-order',
      },
      sourceJobKind: 'fixed',
      sourceJobChainOrderJson: chainOrderJson,
    } as any)).toEqual([])
  })

  it('plans an adjacent repeated participant as two finite durable steps', () => {
    const chainRequest = {
      version: 1,
      participants: [
        { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
        { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 10, length: 7 },
      ],
    }
    const root = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        id: 'human-adjacent-repeated-chain', senderId: 'human',
        content: '@Hermes → @Hermes compare the result', role: 'user',
        mentions: [chainRequest.participants[0]], chainRequest,
      },
    } as any)
    expect(root).toEqual([{
      chainId: 'gcchain_human-adjacent-repeated-chain', targetAgentId: 'a', targetSessionId: 'session-a',
      depth: 0, kind: 'fixed', chainOrderJson: '["a","a"]',
    }])

    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        senderId: 'a', content: 'first result', role: 'assistant',
        handoffDepth: 1, handoffChainId: root[0].chainId,
      },
      sourceJobKind: 'fixed', sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)).toEqual([{
      chainId: root[0].chainId, targetAgentId: 'a', targetSessionId: 'session-a',
      depth: 1, kind: 'fixed', chainOrderJson: '["a","a"]',
    }])

    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        senderId: 'a', content: 'second result', role: 'assistant',
        handoffDepth: 2, handoffChainId: root[0].chainId,
      },
      sourceJobKind: 'fixed', sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)).toEqual([])
  })

  it('plans a finite message-scoped chain by step index when a participant appears more than once', () => {
    const chainRequest = {
      version: 1,
      participants: [
        { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
        { type: 'participant', participantId: 'b', displayName: 'Codex', start: 10, length: 6 },
        { type: 'participant', participantId: 'c', displayName: 'Claude Code', start: 19, length: 12 },
        { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 34, length: 7 },
      ],
    }
    const root = planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: {
        id: 'human-repeated-chain', senderId: 'human',
        content: '@Hermes → @Codex → @Claude Code → @Hermes compare the result', role: 'user',
        mentions: [chainRequest.participants[0]], chainRequest,
      },
    } as any)
    expect(root).toEqual([{
      chainId: 'gcchain_human-repeated-chain', targetAgentId: 'a', targetSessionId: 'session-a',
      depth: 0, kind: 'fixed', chainOrderJson: '["a","b","c","a"]',
    }])

    const expected = [
      { senderId: 'a', handoffDepth: 1, targetAgentId: 'b', targetSessionId: 'session-b' },
      { senderId: 'b', handoffDepth: 2, targetAgentId: 'c', targetSessionId: 'session-c' },
      { senderId: 'c', handoffDepth: 3, targetAgentId: 'a', targetSessionId: 'session-a' },
    ]
    for (const step of expected) {
      expect(planGroupHandoffs({
        room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
        agents,
        source: {
          senderId: step.senderId, content: 'step result', role: 'assistant',
          handoffDepth: step.handoffDepth, handoffChainId: root[0].chainId,
        },
        sourceJobKind: 'fixed', sourceJobChainOrderJson: root[0].chainOrderJson,
      } as any)).toEqual([{
        chainId: root[0].chainId, targetAgentId: step.targetAgentId, targetSessionId: step.targetSessionId,
        depth: step.handoffDepth, kind: 'fixed', chainOrderJson: '["a","b","c","a"]',
      }])
    }

    expect(planGroupHandoffs({
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
      source: { senderId: 'a', content: 'final result', role: 'assistant', handoffDepth: 4, handoffChainId: root[0].chainId },
      sourceJobKind: 'fixed', sourceJobChainOrderJson: root[0].chainOrderJson,
    } as any)).toEqual([])
  })

  it('rejects malformed and cross-Room participants in a structured chain request', () => {
    const base = {
      room: { handoffMode: 'mentions', handoffOrderJson: '[]', maxAgentMentionDepth: 4 },
      agents,
    }
    expect(() => planGroupHandoffs({
      ...base,
      source: {
        id: 'reversed-chain-order', senderId: 'human', content: '@Hermes → @Codex', role: 'user',
        mentions: [{ type: 'participant', participantId: 'b', displayName: 'Codex', start: 10, length: 6 }],
        chainRequest: { version: 1, participants: [
          { type: 'participant', participantId: 'b', displayName: 'Codex', start: 10, length: 6 },
          { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
        ] },
      },
    } as any)).toThrow(/order|separator/i)
    expect(() => planGroupHandoffs({
      ...base,
      source: {
        id: 'invalid-chain-separator', senderId: 'human', content: '@Hermes and @Codex', role: 'user',
        mentions: [{ type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 }],
        chainRequest: { version: 1, participants: [
          { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
          { type: 'participant', participantId: 'b', displayName: 'Codex', start: 12, length: 6 },
        ] },
      },
    } as any)).toThrow(/separator/i)
    expect(() => planGroupHandoffs({
      ...base,
      source: {
        id: 'non-integer-chain-range', senderId: 'human', content: '@Hermes → @Codex', role: 'user',
        mentions: [{ type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 }],
        chainRequest: { version: 1, participants: [
          { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
          { type: 'participant', participantId: 'b', displayName: 'Codex', start: '10', length: 6 },
        ] },
      },
    } as any)).toThrow(/range/i)
    expect(() => planGroupHandoffs({
      ...base,
      source: {
        id: 'oversized-chain', senderId: 'human', content: '@Hermes → @Codex', role: 'user',
        mentions: [{ type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 }],
        chainRequest: { version: 1, participants: Array.from({ length: 101 }, (_, index) => ({
          type: 'participant', participantId: index === 0 ? 'a' : `unknown-${index}`,
          displayName: index === 0 ? 'Hermes' : `Unknown ${index}`, start: index * 10,
          length: index === 0 ? 7 : `@Unknown ${index}`.length,
        })) },
      },
    } as any)).toThrow(/invalid structured chain request/i)
    expect(() => planGroupHandoffs({
      ...base,
      source: {
        id: 'mismatched-chain-root', senderId: 'human', content: '@Hermes → @Codex', role: 'user',
        mentions: [{ type: 'participant', participantId: 'c', displayName: 'Claude Code', start: 0, length: 12 }],
        chainRequest: { version: 1, participants: [
          { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
          { type: 'participant', participantId: 'b', displayName: 'Codex', start: 10, length: 6 },
        ] },
      },
    } as any)).toThrow(/chain root target/i)
    expect(() => planGroupHandoffs({
      ...base,
      source: {
        id: 'cross-room-chain', senderId: 'human', content: '@Hermes → @Other', role: 'user',
        mentions: [{ type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 }],
        chainRequest: { version: 1, participants: [
          { type: 'participant', participantId: 'a', displayName: 'Hermes', start: 0, length: 7 },
          { type: 'participant', participantId: 'other-room', displayName: 'Other', start: 10, length: 6 },
        ] },
      },
    } as any)).toThrow(/structured chain participant is not an eligible Room participant/i)
  })

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

  it.each(['mentions', 'fixed'] as const)('does not broadcast an overlapping @all-B participant in %s mode', handoffMode => {
    const overlappingAgents = [
      { ...agents[0], agentId: 'hermes', id: 'row-hermes', sessionId: 'session-hermes', name: 'Hermes' },
      { ...agents[1], agentId: 'all-b', id: 'row-all-b', sessionId: 'session-all-b', name: 'all-B' },
      { ...agents[2], agentId: 'codex', id: 'row-codex', sessionId: 'session-codex', name: 'Codex' },
    ] as any[]

    expect(planGroupHandoffs({
      room: { handoffMode, handoffOrderJson: '["hermes","all-b","codex"]', maxAgentMentionDepth: 4 },
      agents: overlappingAgents,
      source: { id: `human-${handoffMode}-overlap`, senderId: 'human', content: '@all-B inspect', role: 'user', handoffDepth: 0 },
    })).toEqual([expect.objectContaining({
      targetAgentId: 'all-b',
      targetSessionId: 'session-all-b',
      kind: handoffMode === 'fixed' ? 'fixed' : 'mention',
    })])
  })

  it.each(['mentions', 'fixed'] as const)('preserves an independent @all broadcast beside @all-B in %s mode', handoffMode => {
    const overlappingAgents = [
      { ...agents[0], agentId: 'hermes', id: 'row-hermes', sessionId: 'session-hermes', name: 'Hermes' },
      { ...agents[1], agentId: 'all-b', id: 'row-all-b', sessionId: 'session-all-b', name: 'all-B' },
      { ...agents[2], agentId: 'codex', id: 'row-codex', sessionId: 'session-codex', name: 'Codex' },
    ] as any[]

    const plans = planGroupHandoffs({
      room: { handoffMode, handoffOrderJson: '["hermes","all-b","codex"]', maxAgentMentionDepth: 4 },
      agents: overlappingAgents,
      source: { id: `human-${handoffMode}-broadcast`, senderId: 'human', content: '@all compare and @all-B inspect', role: 'user', handoffDepth: 0 },
    })
    expect(plans.map(plan => plan.targetAgentId)).toEqual(['hermes', 'all-b', 'codex'])
    expect(plans.every(plan => plan.kind === 'fanout')).toBe(true)
  })
})
