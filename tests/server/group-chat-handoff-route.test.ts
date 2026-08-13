import Koa from 'koa'
import bodyParser from '@koa/bodyparser'
import { createServer, type Server as HttpServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupChatPublicRoutes, groupChatRoutes, setGroupChatServer } from '../../packages/server/src/routes/hermes/group-chat'
import { initAllHermesTables } from '../../packages/server/src/db/hermes/schemas'
import { GroupChatServer } from '../../packages/server/src/services/hermes/group-chat'

const dbState = vi.hoisted(() => ({ current: null as DatabaseSync | null }))
vi.mock('../../packages/server/src/db/index', () => ({ getDb: () => dbState.current }))
vi.mock('../../packages/server/src/middleware/user-auth', () => ({
    isAuthEnabled: vi.fn(async () => false),
    authenticateUserToken: vi.fn(async () => null),
}))

function listen(server: HttpServer): Promise<string> {
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('missing address')
            resolve(`http://127.0.0.1:${address.port}`)
        })
    })
}

describe('group chat durable continuation route', () => {
    let db: DatabaseSync
    let groupServer: GroupChatServer
    let httpServer: HttpServer
    let baseUrl: string

    beforeEach(async () => {
        db = new DatabaseSync(':memory:')
        dbState.current = db
        initAllHermesTables()
        groupServer = new GroupChatServer(createServer())
        const storage = groupServer.getStorage()
        storage.saveRoom('room-1', 'Room', 'ROOM1', {
            ownerAuthUserId: 1,
            agentHandoffEnabled: true,
            agentHandoffMaxDepth: 4,
            agentHandoffUnlimited: false,
        })
        storage.addRoomAgent('room-1', 'agent-2', 'default', 'Target', '', 0)
        db.prepare(
            `INSERT INTO gc_messages
             (id, roomId, senderId, senderName, content, timestamp, persistedAt, mentions, role)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            'source-1', 'room-1', 'agent-1', 'Source', '@Target continue', 100, 100,
            JSON.stringify([{ type: 'agent', participantId: 'agent-2' }]), 'assistant',
        )
        storage.recordHandoffStop('room-1', 'chain-1', 'source-1', 4, 'agent-2', {
            enabled: true,
            maxDepth: 4,
            unlimited: false,
        })
        setGroupChatServer(groupServer)
        const app = new Koa()
        app.use(bodyParser())
        app.use(async (ctx, next) => {
            const testUser = ctx.get('x-test-user')
            if (testUser === 'owner') ctx.state.user = { id: 1, username: 'owner', role: 'admin', profiles: [] }
            if (testUser === 'member') ctx.state.user = { id: 2, username: 'member', role: 'admin', profiles: [] }
            await next()
        })
        app.use(groupChatPublicRoutes.routes())
        app.use(groupChatRoutes.routes())
        httpServer = createServer(app.callback())
        baseUrl = await listen(httpServer)
    })

    afterEach(() => {
        httpServer?.close()
        setGroupChatServer(null)
        db?.close()
        dbState.current = null
    })

    it('allows the authenticated Room owner and rejects a non-manager without side effects', async () => {
        const endpoint = `${baseUrl}/api/hermes/group-chat/rooms/room-1/handoffs/chain-1/continue`
        const denied = await fetch(endpoint, { method: 'POST', headers: { 'x-test-user': 'member' } })
        expect(denied.status).toBe(403)
        expect(db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts').get()).toEqual({ count: 0 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox').get()).toEqual({ count: 0 })
        expect(groupServer.getStorage().getHandoffChain('room-1', 'chain-1')).toMatchObject({ status: 'stopped' })

        const allowed = await fetch(endpoint, { method: 'POST', headers: { 'x-test-user': 'owner' } })
        expect(allowed.status).toBe(202)
        expect(db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts').get()).toEqual({ count: 1 })
        expect(db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_outbox').get()).toEqual({ count: 1 })
    })

    it('returns a stable asynchronous continuation acknowledgement', async () => {
        const endpoint = `${baseUrl}/api/hermes/group-chat/rooms/room-1/handoffs/chain-1/continue`
        const response = await fetch(endpoint, { method: 'POST' })
        expect(response.status).toBe(202)
        const body = await response.json() as any
        expect(body).toMatchObject({
            success: true,
            status: 'continuing',
            chain: { status: 'claimed', continueUsed: 0 },
        })

        const retry = await fetch(endpoint, { method: 'POST' })
        expect(retry.status).toBe(202)
        expect(db.prepare('SELECT COUNT(*) AS count FROM gc_handoff_attempts').get()).toEqual({ count: 1 })
    })

    it('replays a pending outbox through the dispatcher after the request path has returned', async () => {
        const storage = groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        expect(await groupServer.dispatchPendingHandoffs()).toBe(1)
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'stopped',
            stopReason: 'continue_failed',
        })
        expect(storage.getHandoffAttempt(String(claimed.attemptId))).toMatchObject({ status: 'failed' })
    })

    it('completes a claimed route through target acknowledgement and outbox finalization', async () => {
        const storage = groupServer.getStorage()
        vi.spyOn(groupServer.agentClients, 'processMentions').mockImplementation(async (_roomId, message: any) => {
            const attemptId = String(message.continuationAttemptId)
            expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
            const payload = JSON.parse(String(db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
            storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })
            expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
            storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
            storage.markHandoffTargetInvocationStarted(attemptId)
            storage.completeHandoffTarget(attemptId, `continuation:${attemptId}`)
            return { targetCount: 1, deliveredCount: 1, errors: [] }
        })
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        expect(await groupServer.dispatchPendingHandoffs()).toBe(1)
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'resumed',
            continueUsed: 1,
        })
        expect(db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(claimed.attemptId)).toEqual({ status: 'completed' })
    })

    it('replays a dispatching outbox after restart through the real dispatcher path', async () => {
        const storage = groupServer.getStorage()
        const claimed = storage.claimHandoffContinuation('room-1', 'chain-1')!
        const attemptId = String(claimed.attemptId)
        expect(storage.claimHandoffOutbox(attemptId)).toMatchObject({
            attemptId,
            status: 'dispatching',
        })

        storage.init()
        expect(storage.getHandoffAttempt(attemptId)).toMatchObject({ status: 'claimed' })
        expect(db.prepare('SELECT status FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId)).toEqual({ status: 'pending' })

        const processMentions = vi.spyOn(groupServer.agentClients, 'processMentions').mockImplementation(async (_roomId, message: any) => {
            expect(message.continuationAttemptId).toBe(attemptId)
            expect(storage.claimHandoffDelivery(attemptId, 'agent-2')).toBe('accepted')
            const payload = JSON.parse(String(db.prepare('SELECT payload FROM gc_handoff_outbox WHERE attemptId = ?').get(attemptId).payload))
            storage.admitHandoffTarget(attemptId, 'agent-2', payload, { agentId: 'agent-2' })
            expect(storage.acceptHandoffAttempt(attemptId, 'agent-2')).toBe('accepted')
            storage.markHandoffTargetRunning(attemptId, `handoff:${attemptId}`, Date.now() + 60_000)
            storage.markHandoffTargetInvocationStarted(attemptId)
            storage.completeHandoffTarget(attemptId, `continuation:${attemptId}`)
            return { targetCount: 1, deliveredCount: 1, errors: [] }
        })

        expect(await groupServer.dispatchPendingHandoffs()).toBe(1)
        expect(processMentions).toHaveBeenCalledTimes(1)
        expect(storage.getHandoffChain('room-1', 'chain-1')).toMatchObject({
            status: 'resumed',
            continueUsed: 1,
        })
    })
})
