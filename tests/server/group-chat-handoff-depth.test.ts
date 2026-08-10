import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
    DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH,
    recommendedGroupChatAgentHandoffDepth,
    resolveGroupChatAgentHandoffPolicy,
    shouldRouteGroupChatAgentHandoff,
} from '../../packages/server/src/services/hermes/group-chat/handoff-depth'
import { createTestGroupChatServer } from './group-chat-test-helpers'

describe('group chat room Agent handoff depth policy', () => {
    let harness: Awaited<ReturnType<typeof createTestGroupChatServer>>

    beforeEach(async () => {
        harness = await createTestGroupChatServer()
        harness.groupServer.getStorage().saveRoom('room-1', 'Room', 'ROOM1')
        harness.groupServer.getStorage().addRoomAgent('room-1', 'agent-2', 'default', 'Target', '', 0)
        harness.db.prepare(
            `INSERT INTO gc_messages
             (id, roomId, senderId, senderName, content, timestamp, persistedAt, mentions, role)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            'source-1', 'room-1', 'agent-1', 'Source', '@Target continue', 100, 100,
            JSON.stringify([{ type: 'agent', participantId: 'agent-2' }]), 'assistant',
        )
        harness.groupServer.getStorage().recordHandoffStop(
            'room-1',
            'chain-1',
            'source-1',
            4,
            'agent-2',
            { enabled: true, maxDepth: 4, unlimited: false },
        )
    })

    afterEach(() => harness?.cleanup())

    it('recommends at least four hops plus the active participant count', () => {
        expect(recommendedGroupChatAgentHandoffDepth(0)).toBe(4)
        expect(recommendedGroupChatAgentHandoffDepth(3)).toBe(4)
        expect(recommendedGroupChatAgentHandoffDepth(5)).toBe(6)
    })

    it('resolves explicit room values before the server default and then the legacy default', () => {
        expect(resolveGroupChatAgentHandoffPolicy({ maxDepth: 6 }, 4)).toEqual({ enabled: true, maxDepth: 6, unlimited: false })
        expect(resolveGroupChatAgentHandoffPolicy({}, 7)).toEqual({ enabled: true, maxDepth: 7, unlimited: false })
        expect(resolveGroupChatAgentHandoffPolicy({}, undefined)).toEqual({
            enabled: true,
            maxDepth: DEFAULT_GROUP_CHAT_AGENT_HANDOFF_DEPTH,
            unlimited: false,
        })
        expect(resolveGroupChatAgentHandoffPolicy({ unlimited: true }, 4)).toEqual({ enabled: true, maxDepth: null, unlimited: true })
    })

    it('stops at the effective maximum but allows the preceding depth', () => {
        expect(shouldRouteGroupChatAgentHandoff(3, { enabled: true, maxDepth: 4, unlimited: false })).toBe(true)
        expect(shouldRouteGroupChatAgentHandoff(4, { enabled: true, maxDepth: 4, unlimited: false })).toBe(false)
        expect(shouldRouteGroupChatAgentHandoff(4, { enabled: true, maxDepth: null, unlimited: true })).toBe(true)
        expect(shouldRouteGroupChatAgentHandoff(0, { enabled: false, maxDepth: 4, unlimited: false })).toBe(false)
    })

    it('claims one durable attempt, persists the outbox, and deduplicates replay', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')
        expect(claimed).toMatchObject({ status: 'claimed', attemptId: expect.any(String) })
        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toBeNull()
        const attemptId = String(claimed.attemptId)
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'pending' })
        expect(storage.acceptHandoffAttempt(attemptId, 'wrong-agent')).toBeNull()
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('already')
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toMatchObject({
            status: 'resumed',
            continueUsed: 1,
        })
    })

    it('records a failed delivery as retryable and allocates a new attempt', () => {
        const storage = harness.groupServer.getStorage()
        const first = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const failed = storage.failHandoffContinuation('room-1', 'chain-1', 'Agent disconnected')!
        expect(failed).toMatchObject({ status: 'stopped', stopReason: 'continue_failed', continueUsed: 0 })
        expect(storage.getHandoffAttempt(String(first.attemptId))).toMatchObject({ status: 'failed' })
        const retry = storage.claimHandoffContinuation('room-1', 'chain-1')!
        expect(retry.attemptId).not.toBe(first.attemptId)
    })

    it('recovers an expired claimed attempt on storage restart without consuming continuation', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        harness.db.prepare('UPDATE gc_handoff_attempts SET leaseUntil = 0 WHERE attemptId = ?').run(claimed.attemptId)
        storage.init()
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'stopped',
            continueUsed: 0,
            stopReason: 'continue_failed',
        })
        expect(storage.getHandoffAttempt(String(claimed.attemptId))).toMatchObject({ status: 'failed' })
    })

    it('requeues dispatched attempts after restart and durably deduplicates target delivery', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        storage.init()
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'claimed', attemptCount: 2 })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'pending' })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('already')
    })

    it('clears durable attempts and outbox records with room history', () => {
        const storage = harness.groupServer.getStorage()
        storage.claimHandoffContinuation('room-1', 'chain-1')
        storage.clearRoomContext('room-1')
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_chains WHERE roomId = ?').get('room-1')).toEqual({ count: 0 })
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts WHERE roomId = ?').get('room-1')).toEqual({ count: 0 })
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox WHERE roomId = ?').get('room-1')).toEqual({ count: 0 })
    })
})
