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
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })).toMatchObject({
            status: 'admitted',
            stateVersion: 1,
        })
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('already')
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)
        storage.completeHandoffTarget(attemptId, `continuation:${attemptId}`)
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

    it('completes an acknowledged dispatch after restart and durably deduplicates target delivery', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })).toMatchObject({ status: 'admitted' })
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        storage.init()
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'admitted', attemptCount: 1 })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'delivered' })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('already')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('already')
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('already')
    })

    it('completes a target-accepted dispatch after restart without replaying the Agent', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })).toMatchObject({ status: 'admitted' })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        storage.init()
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'claimed',
            continueUsed: 0,
        })
        const admitted = storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })
        expect(admitted).toMatchObject({ status: 'already', stateVersion: 1 })
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)
        storage.completeHandoffTarget(attemptId, `continuation:${attemptId}`)
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toMatchObject({
            status: 'resumed',
            continueUsed: 1,
        })
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'completed' })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'completed' })
    })

    it('does not treat source-side acceptance as target completion after restart', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)

        // This models the crash window between a source-side delivery record
        // and the target durable inbox/terminal publication.
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })).toMatchObject({ status: 'admitted' })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        storage.init()

        expect(storage.getHandoffAttempt(attemptId)).not.toMatchObject({ status: 'completed' })
        expect(storage.getHandoffChain('room-1', 'chain-1')).not.toMatchObject({ status: 'resumed' })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).not.toEqual({ status: 'completed' })
    })

    it('deduplicates durable admission and rejects payload drift', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        const first = storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })
        const replay = storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })
        expect(first).toMatchObject({ status: 'admitted', stateVersion: 1 })
        expect(replay).toMatchObject({ status: 'already', inboxId: first?.inboxId, receipt: first?.receipt })
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', { ...payload, input: 'tampered' }, { agentId: 'agent-2' })).toBeNull()
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_inbox WHERE attemptId = ?').get(attemptId)).toEqual({ count: 1 })
    })

    it('fails manual when an invocation was in flight during restart', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)
        storage.init()
        expect(storage.getHandoffTargetStatus(attemptId)).toMatchObject({
            status: 'failed_manual',
            lastError: 'Target invocation was in flight during restart',
        })
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toBeNull()
    })

    it('reclaims an expired dispatcher lease without waiting for a process restart', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const leased = storage.claimHandoffOutbox(attemptId)
        expect(leased).toMatchObject({ attemptId, status: 'dispatching' })
        harness.db.prepare(
            `UPDATE gc_handoff_outbox SET availableAt = 0 WHERE attemptId = ?`,
        ).run(attemptId)

        expect(storage.claimHandoffOutbox(attemptId)).toMatchObject({
            attemptId,
            status: 'dispatching',
        })
    })

    it('tombstones durable attempts and outbox records when room history is cleared', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        storage.clearRoomContext('room-1')
        expect(harness.db.prepare('SELECT status, stopReason FROM gc_handoff_chains WHERE roomId = ?').get('room-1')).toMatchObject({
            status: 'stopped',
            stopReason: 'room_cleared',
        })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_attempts WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'failed_manual' })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'failed' })
    })
})
