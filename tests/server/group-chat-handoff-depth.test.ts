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
        harness.groupServer.getStorage().saveRoom('room-1', 'Room', 'ROOM1', {
            agentHandoffEnabled: true,
            agentHandoffMaxDepth: 4,
            agentHandoffUnlimited: false,
        })
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

    it('returns only actionable finite depth stops with valid Room source and target records', () => {
        const storage = harness.groupServer.getStorage()
        const db = harness.db
        storage.addRoomAgent('room-1', 'agent-3', 'default', 'Other', '', 0)
        db.prepare(`INSERT INTO gc_messages
          (id, roomId, senderId, senderName, content, timestamp, persistedAt, mentions, role)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run('source-valid', 'room-1', 'agent-1', 'Source', '@Target', 200, 200,
            JSON.stringify([{ type: 'agent', participantId: 'agent-2' }]), 'assistant')
        storage.recordHandoffStop('room-1', 'valid', 'source-valid', 4, 'agent-2', {
          enabled: true, maxDepth: 4, unlimited: false,
        })
        storage.recordHandoffStop('room-1', 'sentinel', 'source-valid', Number.MAX_SAFE_INTEGER, 'agent-2', {
          enabled: true, maxDepth: 4, unlimited: false,
        })
        storage.recordHandoffStop('room-1', 'missing-target', 'source-valid', 4, '', {
          enabled: true, maxDepth: 4, unlimited: false,
        })
        storage.recordHandoffStop('room-1', 'missing-source', 'absent', 4, 'agent-2', {
          enabled: true, maxDepth: 4, unlimited: false,
        })
        storage.recordHandoffStop('room-1', 'unlimited', 'source-valid', 4, 'agent-2', {
          enabled: true, maxDepth: null, unlimited: true,
        })
        storage.recordHandoffStop('room-1', 'wrong-reason', 'source-valid', 4, 'agent-2', {
          enabled: true, maxDepth: 4, unlimited: false,
        })
        db.prepare("UPDATE gc_handoff_chains SET stopReason = 'continue_failed' WHERE chainId = 'wrong-reason'").run()

        expect(storage.getStoppedHandoffChains('room-1').map((chain: any) => chain.chainId).sort()).toEqual(['chain-1', 'valid'])
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
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)).toMatchObject({
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
        expect(storage.getStoppedHandoffChains('room-1')).toEqual([])
    })

    it('migrates the legacy unique chain index to retained history plus one active attempt', async () => {
        harness.db.exec(`
          DROP INDEX IF EXISTS idx_gc_handoff_attempts_chain_history;
          DROP INDEX IF EXISTS idx_gc_handoff_attempts_chain_active;
          CREATE UNIQUE INDEX idx_gc_handoff_attempts_chain ON gc_handoff_attempts(chainId);
        `)

        const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
        initAllHermesTables()

        const indexes = harness.db.prepare("PRAGMA index_list('gc_handoff_attempts')").all() as Array<{ name: string; unique: number }>
        expect(indexes).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'idx_gc_handoff_attempts_chain_history', unique: 0 }),
            expect.objectContaining({ name: 'idx_gc_handoff_attempts_chain_active', unique: 1 }),
        ]))
        expect(indexes.some(index => index.name === 'idx_gc_handoff_attempts_chain')).toBe(false)
    })

    it('upgrades the active-attempt index so outcome-unknown attempts block replacement', async () => {
        harness.db.exec(`
          DROP INDEX IF EXISTS idx_gc_handoff_attempts_chain_active;
          CREATE UNIQUE INDEX idx_gc_handoff_attempts_chain_active
          ON gc_handoff_attempts(chainId)
          WHERE status IN ('claimed', 'admitted', 'dispatched');
        `)

        const { initAllHermesTables } = await import('../../packages/server/src/db/hermes/schemas')
        initAllHermesTables()

        const row = harness.db.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_gc_handoff_attempts_chain_active'",
        ).get() as { sql: string }
        expect(row.sql).toContain("'outcome_unknown'")
    })

    it('records a failed delivery as retryable and allocates a new attempt', () => {
        const storage = harness.groupServer.getStorage()
        const first = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const failed = storage.failHandoffContinuation('room-1', 'chain-1', 'Agent disconnected')!
        expect(failed).toMatchObject({ status: 'stopped', stopReason: 'continue_failed', continueUsed: 0 })
        expect(storage.getHandoffAttempt(String(first.attemptId))).toMatchObject({ status: 'failed' })
        const retry = storage.claimHandoffContinuation('room-1', 'chain-1')!
        expect(retry.attemptId).not.toBe(first.attemptId)
        expect(storage.getHandoffAttempt(String(first.attemptId))).toMatchObject({ status: 'failed' })
        expect(storage.getHandoffAttempt(String(retry.attemptId))).toMatchObject({
            status: 'claimed',
            replacesAttemptId: first.attemptId,
        })
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts WHERE chainId = ?').get('chain-1')).toEqual({ count: 2 })
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
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)).toMatchObject({ status: 'admitted' })
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        storage.init()
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'claimed', attemptCount: 2 })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'pending' })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('already')
    })

    it('rejects a continuation when the stopped target execution configuration has changed', () => {
        const storage = harness.groupServer.getStorage()
        storage.updateRoomAgent('room-1', 'agent-2', 'changed-profile', 'Target', '', {
            agent: 'codex',
            provider: 'changed-provider',
            model: 'changed-model',
            apiMode: 'responses',
            reasoningEffort: 'high',
        })

        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toBeNull()
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts').get()).toEqual({ count: 0 })
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox').get()).toEqual({ count: 0 })
    })

    it('freezes the same canonical target snapshot used by target admission', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId).payload))
        const snapshot = storage.getHandoffTargetSnapshot('room-1', 'agent-2')

        expect(snapshot).toMatchObject({
            id: expect.any(String),
            agentId: 'agent-2',
            name: 'Target',
            profile: 'default',
        })
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, snapshot)).toMatchObject({
            status: 'admitted',
        })
    })

    it('completes a target-accepted dispatch after restart without replaying the Agent', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)).toMatchObject({ status: 'admitted' })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        storage.init()
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'claimed',
            continueUsed: 0,
        })
        const admitted = storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        expect(admitted).toMatchObject({ status: 'already', stateVersion: 1 })
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
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
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)).toMatchObject({ status: 'admitted' })
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
        const dispatchedPayload = { ...payload, continuationAttemptId: attemptId }
        const first = storage.admitHandoffTarget(attemptId, 'agent-2', dispatchedPayload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        const replay = storage.admitHandoffTarget(attemptId, 'agent-2', dispatchedPayload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        expect(first).toMatchObject({ status: 'admitted', stateVersion: 1 })
        expect(replay).toMatchObject({ status: 'already', inboxId: first?.inboxId, receipt: first?.receipt })
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', { ...dispatchedPayload, continuationAttemptId: 'wrong-attempt' }, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)).toBeNull()
        expect(storage.admitHandoffTarget(attemptId, 'agent-2', { ...dispatchedPayload, input: 'tampered' }, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)).toBeNull()
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_inbox WHERE attemptId = ?').get(attemptId)).toEqual({ count: 1 })
    })

    it('fails closed when a started remote invocation has an unknown outcome after restart', () => {
        const storage = harness.groupServer.getStorage()
        storage.updateRoomAgentRelayMetadata('room-1', 'agent-2', {
            connectorId: 'connector-1',
            remoteOrigin: 'https://relay.example',
        })
        storage.recordHandoffStop('room-1', 'chain-1', 'source-1', 4, 'agent-2', {
            enabled: true,
            maxDepth: 4,
            unlimited: false,
        })
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
        storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
        expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)

        storage.init()

        expect(storage.getHandoffTargetStatus(attemptId)).toMatchObject({
            status: 'outcome_unknown',
            lastError: 'Remote target invocation outcome is unknown after restart',
        })
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({
            status: 'outcome_unknown',
            lastError: 'Remote target invocation outcome is unknown after restart',
        })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({
            status: 'outcome_unknown',
        })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_deliveries WHERE attemptId = ?').get(attemptId)).toEqual({
            status: 'outcome_unknown',
        })
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'outcome_unknown',
            continueUsed: 1,
            stopReason: 'outcome_unknown',
            lastError: 'Remote target invocation outcome is unknown after restart',
        })
        expect(storage.getStoppedHandoffChains('room-1')).toEqual([
            expect.objectContaining({
                chainId: 'chain-1',
                status: 'outcome_unknown',
                stopReason: 'outcome_unknown',
            }),
        ])
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toBeNull()
        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toBeNull()
        expect(harness.db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts WHERE chainId = ?').get('chain-1')).toEqual({ count: 1 })

        storage.recordHandoffStop('room-1', 'chain-1', 'source-1', 4, 'agent-2', {
            enabled: true,
            maxDepth: 4,
            unlimited: false,
        })
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'outcome_unknown',
            stopReason: 'outcome_unknown',
            continueUsed: 1,
            attemptId,
        })
        expect(storage.getStoppedHandoffChains('room-1')).toEqual([
            expect.objectContaining({ chainId: 'chain-1', status: 'outcome_unknown' }),
        ])
    })

    it('keeps a started local invocation retryable after restart', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payloadRow = harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId) as { payload: string }
        const payload = JSON.parse(String(payloadRow.payload))
        storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        storage.claimHandoffDelivery(attemptId, 'agent-2')
        storage.acceptHandoffAttempt(attemptId, 'agent-2')
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)

        storage.init()

        expect(storage.getHandoffTargetStatus(attemptId)).toMatchObject({ status: 'failed_manual' })
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'failed' })
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'stopped',
            stopReason: 'continue_failed',
            continueUsed: 0,
        })
        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toMatchObject({
            status: 'claimed',
            attemptId: expect.not.stringMatching(new RegExp(`^${attemptId}$`)),
        })
    })

    it('reconciles a durable target failure if restart interrupts source finalization', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payloadRow = harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId) as { payload: string }
        storage.admitHandoffTarget(attemptId, 'agent-2', JSON.parse(payloadRow.payload), storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        storage.claimHandoffDelivery(attemptId, 'agent-2')
        storage.acceptHandoffAttempt(attemptId, 'agent-2')
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)
        storage.failHandoffTarget(attemptId, 'Durable target failure before source finalization')

        storage.init()

        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({
            status: 'failed',
            lastError: 'Durable target failure before source finalization',
        })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'failed' })
        expect(harness.db.prepare('SELECT status FROM gc_handoff_deliveries WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'failed' })
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'stopped',
            stopReason: 'continue_failed',
            continueUsed: 0,
            lastError: 'Durable target failure before source finalization',
        })
        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toMatchObject({
            status: 'claimed',
            attemptId: expect.not.stringMatching(new RegExp(`^${attemptId}$`)),
        })
    })

    it('fails closed even when a remote attempt is missing an audit delivery row', () => {
        const storage = harness.groupServer.getStorage()
        storage.updateRoomAgentRelayMetadata('room-1', 'agent-2', {
            connectorId: 'connector-1',
            remoteOrigin: 'https://relay.example',
        })
        storage.recordHandoffStop('room-1', 'chain-1', 'source-1', 4, 'agent-2', {
            enabled: true,
            maxDepth: 4,
            unlimited: false,
        })
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payloadRow = harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId) as { payload: string }
        storage.admitHandoffTarget(attemptId, 'agent-2', JSON.parse(payloadRow.payload), storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        storage.claimHandoffDelivery(attemptId, 'agent-2')
        storage.acceptHandoffAttempt(attemptId, 'agent-2')
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)
        harness.db.prepare('DELETE FROM gc_handoff_deliveries WHERE attemptId = ?').run(attemptId)

        expect(storage.markRemoteHandoffOutcomeUnknown(attemptId, 'Remote transport outcome is unknown')).toBeTruthy()
        expect(storage.getHandoffTargetStatus(attemptId)).toMatchObject({ status: 'outcome_unknown' })
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'outcome_unknown' })
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'outcome_unknown',
            continueUsed: 1,
        })
        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toBeNull()
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

    it('removes stopped and claimed handoff state when room history is cleared', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        storage.failHandoffContinuation('room-1', 'chain-1', 'Agent disconnected')
        storage.clearRoomContext('room-1')
        expect(storage.getStoppedHandoffChains('room-1')).toEqual([])
        expect(storage.getHandoffChain('room-1', 'chain-1')).toBeNull()
        expect(storage.getHandoffAttempt(attemptId)).toBeNull()
        expect(harness.db.prepare('SELECT * FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toBeUndefined()
        expect(harness.db.prepare('SELECT * FROM gc_handoff_inbox WHERE attemptId = ?').get(attemptId)).toBeUndefined()
        expect(harness.db.prepare('SELECT * FROM gc_handoff_deliveries WHERE attemptId = ?').get(attemptId)).toBeUndefined()
        expect(storage.claimHandoffContinuation('room-1', 'chain-1')).toBeNull()
    })

    it('removes target inbox state when a room is deleted', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payloadRow = harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId) as { payload: string }
        storage.admitHandoffTarget(attemptId, 'agent-2', JSON.parse(payloadRow.payload), storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        storage.claimHandoffDelivery(attemptId, 'agent-2')
        storage.acceptHandoffAttempt(attemptId, 'agent-2')

        storage.deleteRoom('room-1')

        for (const table of [
            'gc_handoff_chains',
            'gc_handoff_attempts',
            'gc_handoff_outbox',
            'gc_handoff_deliveries',
            'gc_handoff_inbox',
        ]) {
            expect(harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
        }
    })

    it('requires a durable target message before completing a continuation attempt', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId).payload))

        storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        storage.acceptHandoffAttempt(attemptId, 'agent-2')
        expect(storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)).toBe(true)
        expect(storage.markHandoffTargetInvocationStarted(attemptId)).toBe(true)
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toBeNull()

        expect(storage.completeHandoffTarget(attemptId, 'agent-message-1')).toBe(true)
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toMatchObject({
            status: 'resumed',
            continueUsed: 1,
        })
    })

    it('records a post-invocation failure as manual and never reports completion', () => {
        const storage = harness.groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        const payload = JSON.parse(String(harness.db.prepare(
            'SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?',
        ).get(attemptId).payload))

        storage.admitHandoffTarget(attemptId, 'agent-2', payload, storage.getHandoffTargetSnapshot('room-1', 'agent-2')!)
        storage.acceptHandoffAttempt(attemptId, 'agent-2')
        storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
        storage.markHandoffTargetInvocationStarted(attemptId)
        expect(storage.failHandoffTarget(attemptId, 'Agent run failed')).toBe(true)
        expect(storage.getHandoffTargetStatus(attemptId)).toMatchObject({
            status: 'failed_manual',
            lastError: 'Agent run failed',
        })
        expect(storage.completeHandoffContinuation('room-1', 'chain-1')).toBeNull()
    })
})
