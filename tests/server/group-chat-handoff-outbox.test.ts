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
  planGroupHandoffs,
} from '../../packages/server/src/services/hermes/group-chat'

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
      'id', 'roomId', 'chainId', 'sourceMessageId', 'targetAgentId', 'targetSessionId',
      'depth', 'kind', 'status', 'attemptCount', 'availableAt', 'leaseOwner',
      'leaseToken', 'leaseExpiresAt', 'lastError', 'createdAt', 'updatedAt', 'completedAt',
    ]))
    const indexes = db.prepare(`PRAGMA index_list("${GC_HANDOFF_JOBS_TABLE}")`).all() as Array<{ name: string; unique: number }>
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'uniq_gc_handoff_source_target', unique: 1 }))
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

    const first = storage.saveMessageAndRefreshRoom(msg, { handoffs: plans })
    const replay = storage.saveMessageAndRefreshRoom(msg, { handoffs: plans })

    expect(first.handoffJobs).toHaveLength(2)
    expect(replay.handoffJobs).toHaveLength(2)
    const rows = dbMock.current!.prepare('SELECT * FROM gc_handoff_jobs ORDER BY targetAgentId').all() as any[]
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.targetAgentId)).toEqual(['agent-a', 'agent-b'])
    expect(storage.getMessage('human-message-1')?.roomSeq).toBe(1)
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
    }, { handoffs: plan })

    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-1', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@A changed', timestamp: 101, role: 'user',
    }, { handoffs: plan })).toThrow(/message id conflict/i)
    expect(storage.getMessage('human-message-1')?.content).toBe('@A original')
  })

  it('rolls back the message when a handoff target violates the durable contract', () => {
    const storage = new ChatStorage()
    storage.init()
    storage.saveRoom('room-1', 'Room', 'ROOM1')
    expect(() => storage.saveMessageAndRefreshRoom({
      id: 'human-message-bad', roomId: 'room-1', senderId: 'human-1', senderName: 'Human',
      content: '@Missing hello', timestamp: 100, role: 'user',
    }, {
      handoffs: [{
        chainId: 'chain-bad', targetAgentId: 'missing', targetSessionId: 'missing-session',
        depth: 0, kind: 'mention',
      }],
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
    }, { handoffs: [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }] })

    const first = storage.claimHandoffJobs('process-old', 1_000, 1, 5_000)
    expect(first).toHaveLength(1)
    expect(storage.claimHandoffJobs('process-old', 1_001, 1, 5_000)).toHaveLength(0)

    expect(storage.claimHandoffJobs('process-new', 7_000, 1, 5_000)).toHaveLength(0)
    expect(storage.getHandoffJob(first[0].id)).toMatchObject({ status: 'running', leaseOwner: 'process-old', attemptCount: 1 })
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
    }, { handoffs: [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'fixed' }] })
    const source = storage.claimHandoffJobs('process-1', 1_000, 1, 5_000)[0]

    const saved = storage.saveMessageAndRefreshRoom({
      id: 'assistant-message-1', roomId: 'room-1', senderId: a.agentId, senderName: 'A',
      content: 'answer without any mention', timestamp: 200, role: 'assistant',
      handoffChainId: source.chainId, handoffDepth: 1, sourceHandoffJobId: source.id,
      sourceHandoffLeaseToken: source.leaseToken, agentSessionId: a.sessionId, handoffFinal: true,
    }, { handoffs: [{ chainId: source.chainId, targetAgentId: b.agentId, targetSessionId: b.sessionId, depth: 1, kind: 'fixed' }] })

    expect(saved.handoffJobs).toHaveLength(1)
    expect(storage.getHandoffJob(source.id)).toMatchObject({ status: 'completed', completedAt: 200 })
    expect(saved.handoffJobs[0]).toMatchObject({ targetAgentId: b.agentId, depth: 1, kind: 'fixed', status: 'pending' })
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
      }, { handoffs: [{ chainId: `chain-${id}`, targetAgentId: target.agentId, targetSessionId: target.sessionId, depth: 0, kind: 'mention' }] })
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
      }, { handoffs: [{ chainId: `chain-${id}`, targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }] })
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
    }, { handoffs: [{ chainId: 'chain-1', targetAgentId: a.agentId, targetSessionId: a.sessionId, depth: 0, kind: 'mention' }] })
    const claimed = storage.claimHandoffJobs('process-old', 1_000, 1, 5_000)[0]

    expect(storage.recoverInterruptedHandoffJobs('process-new', 7_000)).toBe(1)
    expect(storage.getHandoffJob(claimed.id)).toMatchObject({ status: 'interrupted', leaseOwner: '', leaseToken: '' })
    expect(storage.claimHandoffJobs('process-new', 7_000, 1, 5_000)).toEqual([])
  })
})

describe('fixed-order group-chat handoff planning', () => {
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
