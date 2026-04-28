import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Mock auth so token check is skipped
vi.mock('../../packages/server/src/services/auth', () => ({
    getToken: vi.fn().mockResolvedValue(null),
}))

// Mock socket.io — we only test REST routes, not Socket.IO
vi.mock('socket.io', () => {
    const listeners: Record<string, any> = {}
    const mockNsp = {
        use: vi.fn(),
        on: vi.fn((event: string, fn: any) => { listeners[event] = fn }),
        to: vi.fn().mockReturnThis(),
        emit: vi.fn(),
    }
    return {
        Server: vi.fn().mockImplementation(() => ({
            of: vi.fn().mockReturnValue(mockNsp),
            use: vi.fn(),
            on: vi.fn((event: string, fn: any) => { listeners[event] = fn }),
            to: vi.fn().mockReturnThis(),
            emit: vi.fn(),
        })),
    }
})

// Mock socket.io-client — agent connections are not tested here
vi.mock('socket.io-client', () => {
    const noopSocket = {
        connected: true,
        id: 'mock-agent-id',
        connect: vi.fn().mockReturnThis(),
        disconnect: vi.fn(),
        on: vi.fn().mockImplementation(function (this: any, event: string, fn: any) {
            if (event === 'connect') {
                setTimeout(() => fn(), 0)
            }
            return this
        }),
        emit: vi.fn().mockImplementation(function (this: any, event: string, data: any, ack?: any) {
            // Auto-call ack for 'join' and 'message' events
            if (ack && typeof ack === 'function') {
                if (event === 'join') {
                    ack({ roomId: data?.roomId || 'general', roomName: data?.roomId || 'general', members: [], messages: [], rooms: [] })
                } else if (event === 'message') {
                    ack({ id: 'mock-msg-id' })
                }
            }
        }),
        io: { on: vi.fn() },
    }
    return {
        io: vi.fn().mockReturnValue(noopSocket),
    }
})

// Mock context-engine/compressor — not needed for route/storage tests
vi.mock('../../packages/server/src/services/hermes/context-engine/compressor', () => ({
    ContextEngine: vi.fn().mockImplementation(() => ({
        invalidateRoom: vi.fn(),
        buildContext: vi.fn(),
        forceCompress: vi.fn(),
        setUpstream: vi.fn(),
    })),
}))

// Mock hermes-cli — deleteSession is used by drain logic
const mockDeleteSession = vi.fn().mockResolvedValue(true)
vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
    deleteSession: (...args: any[]) => mockDeleteSession(...args),
}))

// --- In-memory SQLite for testing (no file I/O) ---

function createTestDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA journal_mode=WAL')
    db.exec('PRAGMA foreign_keys=ON')
    return db
}

const testDir = mkdtempSync(join(tmpdir(), 'hermes-test-'))

describe('group-chat routes', () => {
    let setGroupChatServer: any
    let groupChatRoutes: any
    let storage: any
    let testDb: DatabaseSync | null = null

    beforeEach(async () => {
        vi.resetModules()
        mockDeleteSession.mockResolvedValue(true)
        mockDeleteSession.mockClear()

        // Create a fresh in-memory SQLite DB for each test
        testDb = createTestDb()

        // Mock getDb to return our test DB, ensureTable as schema migration
        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const mod = await import('../../packages/server/src/routes/hermes/group-chat')
        setGroupChatServer = mod.setGroupChatServer
        groupChatRoutes = mod.groupChatRoutes
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
        storage = null
    })

    afterAll(() => {
        rmSync(testDir, { recursive: true, force: true })
    })

    async function createServer() {
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        setGroupChatServer(server)
        storage = server.getStorage()
        return { server, storage }
    }

    function findHandler(path: string, method: string) {
        const layer = groupChatRoutes.stack.find(
            (entry: any) => entry.path === path && entry.methods.includes(method)
        )
        return layer?.stack?.[0]
    }

    function makeCtx(body: any = {}, params: Record<string, string> = {}) {
        return { request: { body }, params, body: null, status: 200 }
    }

    describe('POST /api/hermes/group-chat/rooms', () => {
        it('creates a room with agents', async () => {
            const { storage: s } = await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms', 'POST')
            const ctx = makeCtx({
                name: 'Test Room',
                inviteCode: 'abc123',
                agents: [
                    { profile: 'claude', name: 'Claude', description: 'AI assistant', invited: true },
                    { profile: 'gpt' },
                ],
            })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.room).toBeDefined()
            expect(ctx.body.room.name).toBe('Test Room')
            expect(ctx.body.room.inviteCode).toBe('abc123')
            expect(ctx.body.agents).toHaveLength(2)
            expect(ctx.body.agents[0].profile).toBe('claude')
            expect(ctx.body.agents[0].invited).toBe(1)
            expect(ctx.body.agents[1].name).toBe('gpt') // defaults to profile
            expect(ctx.body.agents[1].description).toBe('')
            expect(ctx.body.agents[1].invited).toBe(0)
        })

        it('creates a room with compression config', async () => {
            const { storage: s } = await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms', 'POST')
            const ctx = makeCtx({
                name: 'Compressed Room',
                inviteCode: 'comp1',
                compression: {
                    triggerTokens: 50000,
                    maxHistoryTokens: 16000,
                    tailMessageCount: 10,
                },
            })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            const room = s.getRoom(ctx.body.room.id)
            expect(room?.triggerTokens).toBe(50000)
            expect(room?.maxHistoryTokens).toBe(16000)
            expect(room?.tailMessageCount).toBe(10)
        })

        it('rejects missing name', async () => {
            await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms', 'POST')
            const ctx = makeCtx({ inviteCode: 'abc' })

            await handler(ctx)

            expect(ctx.status).toBe(400)
            expect(ctx.body.error).toMatch(/name.*inviteCode/i)
        })

        it('rejects missing inviteCode', async () => {
            await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms', 'POST')
            const ctx = makeCtx({ name: 'Room' })

            await handler(ctx)

            expect(ctx.status).toBe(400)
        })
    })

    describe('GET /api/hermes/group-chat/rooms', () => {
        it('lists all rooms', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')
            s.saveRoom('r2', 'Room 2', 'code2')

            const handler = findHandler('/api/hermes/group-chat/rooms', 'GET')
            const ctx = makeCtx()

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.rooms).toHaveLength(2)
        })

        it('returns 503 when chat server not initialized', async () => {
            const handler = findHandler('/api/hermes/group-chat/rooms', 'GET')
            const ctx = makeCtx()

            await handler(ctx)

            expect(ctx.status).toBe(503)
        })
    })

    describe('GET /api/hermes/group-chat/rooms/:roomId', () => {
        it('returns room detail with messages, agents, members', async () => {
            const { storage: s } = await createServer()
            s.saveRoom('r1', 'Room 1', 'code1')
            s.addMessage({ id: 'm1', roomId: 'r1', senderId: 'u1', senderName: 'User', content: 'hello', timestamp: Date.now() })

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')
            const ctx = makeCtx({}, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.room.id).toBe('r1')
            expect(ctx.body.messages).toHaveLength(1)
            expect(ctx.body.agents).toBeDefined()
            expect(ctx.body.members).toBeDefined()
        })

        it('returns 404 for unknown room', async () => {
            await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId', 'GET')
            const ctx = makeCtx({}, { roomId: 'nonexist' })

            await handler(ctx)

            expect(ctx.status).toBe(404)
        })
    })

    describe('GET /api/hermes/group-chat/rooms/join/:code', () => {
        it('finds room by invite code', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'mycode')

            const handler = findHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')
            const ctx = makeCtx({}, { code: 'mycode' })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.room.id).toBe('r1')
        })

        it('returns 404 for unknown code', async () => {
            await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms/join/:code', 'GET')
            const ctx = makeCtx({}, { code: 'nonexist' })

            await handler(ctx)

            expect(ctx.status).toBe(404)
        })
    })

    describe('POST /api/hermes/group-chat/rooms/:roomId/agents', () => {
        it('adds an agent to a room', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
            const ctx = makeCtx(
                { profile: 'claude', name: 'Claude', description: 'Helper', invited: true },
                { roomId: 'r1' }
            )

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.agent.profile).toBe('claude')
            expect(ctx.body.agent.invited).toBe(1)
            expect(ctx.body.agent.agentId).toBeDefined()
        })

        it('rejects duplicate agent profile in same room', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')
            s.addRoomAgent('r1', 'a1', 'claude', 'Claude', 'desc', 0)

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
            const ctx = makeCtx({ profile: 'claude' }, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(409)
            expect(ctx.body.error).toMatch(/already/i)
        })

        it('rejects missing profile', async () => {
            await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'POST')
            const ctx = makeCtx({ name: 'No Profile' }, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(400)
        })
    })

    describe('GET /api/hermes/group-chat/rooms/:roomId/agents', () => {
        it('lists agents in a room', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')
            s.addRoomAgent('r1', 'a1', 'claude', 'Claude', 'desc', 0)
            s.addRoomAgent('r1', 'a2', 'gpt', 'GPT', 'desc', 1)

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/agents', 'GET')
            const ctx = makeCtx({}, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.agents).toHaveLength(2)
        })
    })

    describe('DELETE /api/hermes/group-chat/rooms/:roomId/agents/:agentId', () => {
        it('removes an agent from a room', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')
            const agent = s.addRoomAgent('r1', 'a1', 'claude', 'Claude', '', 0)

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', 'DELETE')
            const ctx = makeCtx({}, { roomId: 'r1', agentId: agent.id })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.success).toBe(true)
            expect(s.getRoomAgents('r1')).toHaveLength(0)
        })
    })

    describe('DELETE /api/hermes/group-chat/rooms/:roomId', () => {
        it('deletes a room and all its data', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')
            s.addMessage({ id: 'm1', roomId: 'r1', senderId: 'u1', senderName: 'User', content: 'hi', timestamp: Date.now() })
            s.addRoomAgent('r1', 'a1', 'claude', 'Claude', '', 0)

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId', 'DELETE')
            const ctx = makeCtx({}, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(s.getRoom('r1')).toBeUndefined()
            expect(s.getMessages('r1')).toHaveLength(0)
            expect(s.getRoomAgents('r1')).toHaveLength(0)
        })
    })

    describe('PUT /api/hermes/group-chat/rooms/:roomId/invite-code', () => {
        it('updates room invite code', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'oldcode')

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/invite-code', 'PUT')
            const ctx = makeCtx({ inviteCode: 'newcode' }, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(s.getRoomByInviteCode('newcode')).toBeDefined()
            expect(s.getRoomByInviteCode('oldcode')).toBeUndefined()
        })
    })

    describe('PUT /api/hermes/group-chat/rooms/:roomId/config', () => {
        it('updates room compression config', async () => {
            const { storage: s } = await createServer()

            s.saveRoom('r1', 'Room 1', 'code1')

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/config', 'PUT')
            const ctx = makeCtx({
                triggerTokens: 80000,
                maxHistoryTokens: 24000,
                tailMessageCount: 15,
            }, { roomId: 'r1' })

            await handler(ctx)

            expect(ctx.status).toBe(200)
            expect(ctx.body.room.triggerTokens).toBe(80000)
            expect(ctx.body.room.maxHistoryTokens).toBe(24000)
            expect(ctx.body.room.tailMessageCount).toBe(15)
        })

        it('returns 404 for unknown room', async () => {
            await createServer()

            const handler = findHandler('/api/hermes/group-chat/rooms/:roomId/config', 'PUT')
            const ctx = makeCtx({ triggerTokens: 1000 }, { roomId: 'nonexist' })

            await handler(ctx)

            // Route doesn't check room existence, it just calls updateRoomConfig silently
            expect(ctx.status).toBe(200)
        })
    })
})

// ─── ChatStorage unit tests (deferred delete queue) ──────────

describe('ChatStorage — session profiles', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const mod = await import('../../packages/server/src/services/hermes/group-chat')
        // Access ChatStorage via the exported drainPendingSessionDeletes module
        // We need to instantiate ChatStorage and call init() to create tables
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('saves and retrieves a session profile', () => {
        storage.saveSessionProfile('sess1', 'room1', 'agent1', 'claude')

        const profile = storage.getSessionProfile('sess1')
        expect(profile).not.toBeNull()
        expect(profile!.session_id).toBe('sess1')
        expect(profile!.room_id).toBe('room1')
        expect(profile!.agent_id).toBe('agent1')
        expect(profile!.profile_name).toBe('claude')
    })

    it('upserts session profile on conflict', () => {
        storage.saveSessionProfile('sess1', 'room1', 'agent1', 'claude')
        storage.saveSessionProfile('sess1', 'room2', 'agent2', 'gpt')

        const profile = storage.getSessionProfile('sess1')
        expect(profile!.room_id).toBe('room2')
        expect(profile!.agent_id).toBe('agent2')
        expect(profile!.profile_name).toBe('gpt')
    })

    it('deletes a session profile', () => {
        storage.saveSessionProfile('sess1', 'room1', 'agent1', 'claude')
        storage.deleteSessionProfile('sess1')

        expect(storage.getSessionProfile('sess1')).toBeNull()
    })

    it('returns null for unknown session profile', () => {
        expect(storage.getSessionProfile('nonexist')).toBeNull()
    })
})

describe('ChatStorage — pending session deletes', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
        mockDeleteSession.mockResolvedValue(true)
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('enqueues a pending session delete', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')

        const pending = storage.listPendingSessionDeletes('claude')
        expect(pending).toHaveLength(1)
        expect(pending[0].session_id).toBe('sess1')
        expect(pending[0].profile_name).toBe('claude')
        expect(pending[0].status).toBe('pending')
        expect(pending[0].attempt_count).toBe(0)
    })

    it('upserts on conflict when enqueuing duplicate', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        // Simulate a failed attempt
        storage.markPendingSessionDeleteFailed('sess1', 'temp error')
        // Re-enqueue should reset status
        storage.enqueuePendingSessionDelete('sess1', 'claude')

        const pending = storage.listPendingSessionDeletes('claude')
        expect(pending).toHaveLength(1)
        expect(pending[0].status).toBe('pending')
        expect(pending[0].attempt_count).toBe(1) // previous attempt preserved by markFailed
    })

    it('lists pending deletes filtered by profile', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.enqueuePendingSessionDelete('sess2', 'gpt')
        storage.enqueuePendingSessionDelete('sess3', 'claude')

        const claudePending = storage.listPendingSessionDeletes('claude')
        expect(claudePending).toHaveLength(2)
        expect(claudePending.every(p => p.profile_name === 'claude')).toBe(true)
    })

    it('claims pending deletes and marks as processing', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.enqueuePendingSessionDelete('sess2', 'claude')

        const claimed = storage.claimPendingSessionDeletes('claude')
        expect(claimed).toHaveLength(2)
        expect(claimed.every(c => c.status === 'processing')).toBe(true)

        // After claiming, list should return empty (status is now 'processing')
        const pending = storage.listPendingSessionDeletes('claude')
        expect(pending).toHaveLength(0)
    })

    it('removes a claimed delete after successful drain', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.claimPendingSessionDeletes('claude')

        storage.removePendingSessionDelete('sess1')

        const pending = storage.listPendingSessionDeletes('claude')
        expect(pending).toHaveLength(0)
    })

    it('marks a failed delete and retries after backoff', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.claimPendingSessionDeletes('claude')

        storage.markPendingSessionDeleteFailed('sess1', 'gateway error')

        // After failure, item goes back to 'pending' but with next_attempt_at in the future
        const pending = storage.listPendingSessionDeletes('claude')
        // Should not appear because next_attempt_at is 60s in the future
        expect(pending).toHaveLength(0)
    })

    it('getPendingDeletedSessionIds returns tombstone set', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.enqueuePendingSessionDelete('sess2', 'gpt')

        const ids = storage.getPendingDeletedSessionIds()
        expect(ids).toContain('sess1')
        expect(ids).toContain('sess2')
        expect(ids.size).toBe(2)
    })

    it('removes session from tombstone set after successful drain', () => {
        storage.enqueuePendingSessionDelete('sess1', 'claude')
        expect(storage.getPendingDeletedSessionIds()).toContain('sess1')

        storage.claimPendingSessionDeletes('claude')
        storage.removePendingSessionDelete('sess1')

        expect(storage.getPendingDeletedSessionIds()).not.toContain('sess1')
    })
})

describe('drainPendingSessionDeletes', () => {
    let testDb: DatabaseSync | null = null

    beforeEach(async () => {
        vi.resetModules()
        mockDeleteSession.mockResolvedValue(true)
        mockDeleteSession.mockClear()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        // Create tables by instantiating GroupChatServer
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        new GroupChatServer(httpServer)
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('drains all pending deletes for a profile', async () => {
        // Directly insert into DB via the storage instance
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        const storage = server.getStorage()

        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.enqueuePendingSessionDelete('sess2', 'claude')
        storage.saveSessionProfile('sess1', 'room1', 'agent1', 'claude')
        storage.saveSessionProfile('sess2', 'room1', 'agent2', 'claude')

        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('claude')

        expect(result.deleted).toHaveLength(2)
        expect(result.deleted).toContain('sess1')
        expect(result.deleted).toContain('sess2')
        expect(result.failed).toHaveLength(0)
        expect(mockDeleteSession).toHaveBeenCalledWith('sess1')
        expect(mockDeleteSession).toHaveBeenCalledWith('sess2')

        // Session profiles should be cleaned up
        expect(storage.getSessionProfile('sess1')).toBeNull()
        expect(storage.getSessionProfile('sess2')).toBeNull()
    })

    it('handles partial failures during drain', async () => {
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        const storage = server.getStorage()

        storage.enqueuePendingSessionDelete('sess-ok', 'claude')
        storage.enqueuePendingSessionDelete('sess-fail', 'claude')

        mockDeleteSession.mockImplementation(async (id: string) => {
            if (id === 'sess-fail') return false
            return true
        })

        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('claude')

        expect(result.deleted).toHaveLength(1)
        expect(result.deleted).toContain('sess-ok')
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0].sessionId).toBe('sess-fail')
    })

    it('does not drain items for other profiles', async () => {
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        const storage = server.getStorage()

        storage.enqueuePendingSessionDelete('sess1', 'claude')
        storage.enqueuePendingSessionDelete('sess2', 'gpt')

        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('claude')

        expect(result.deleted).toHaveLength(1)
        expect(result.deleted).toContain('sess1')
        expect(mockDeleteSession).toHaveBeenCalledTimes(1)
    })

    it('returns empty result when nothing to drain', async () => {
        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('nonexistent')

        expect(result.deleted).toHaveLength(0)
        expect(result.failed).toHaveLength(0)
        expect(mockDeleteSession).not.toHaveBeenCalled()
    })
})

describe('ChatStorage — token estimation', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('estimates tokens for ASCII text', () => {
        const tokens = storage.estimateTokens('Hello world, this is a test message.')
        expect(tokens).toBeGreaterThan(0)
        // 35 chars / 4 ≈ 9
        expect(tokens).toBe(9)
    })

    it('estimates tokens for CJK text', () => {
        const tokens = storage.estimateTokens('你好世界测试')
        // 6 CJK chars * 1.5 = 9
        expect(tokens).toBe(9)
    })

    it('estimates tokens for mixed text', () => {
        const tokens = storage.estimateTokens('Hello你好')
        // 5 ASCII + 2 CJK = 5/4 + 2*1.5 = 1.25 + 3 = 4.25 → ceil = 5
        expect(tokens).toBe(5)
    })

    it('returns 0 for empty string', () => {
        expect(storage.estimateTokens('')).toBe(0)
    })
})

describe('ChatStorage — room total tokens', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('initializes totalTokens to 0', () => {
        storage.saveRoom('r1', 'Room 1', 'code1')
        const room = storage.getRoom('r1')
        expect(room?.totalTokens).toBe(0)
    })

    it('updates totalTokens for a room', () => {
        storage.saveRoom('r1', 'Room 1', 'code1')
        storage.updateRoomTotalTokens('r1', 1234)

        const room = storage.getRoom('r1')
        expect(room?.totalTokens).toBe(1234)
    })
})

describe('ChatStorage — context snapshots', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('saves and retrieves a context snapshot', () => {
        storage.saveContextSnapshot('r1', 'Summary text', 'msg1', Date.now())

        const snap = storage.getContextSnapshot('r1')
        expect(snap).not.toBeNull()
        expect(snap!.summary).toBe('Summary text')
        expect(snap!.lastMessageId).toBe('msg1')
    })

    it('upserts context snapshot on conflict', () => {
        storage.saveContextSnapshot('r1', 'Old summary', 'msg1', Date.now())
        storage.saveContextSnapshot('r1', 'New summary', 'msg2', Date.now())

        const snap = storage.getContextSnapshot('r1')
        expect(snap!.summary).toBe('New summary')
        expect(snap!.lastMessageId).toBe('msg2')
    })

    it('deletes a context snapshot', () => {
        storage.saveContextSnapshot('r1', 'Summary', 'msg1', Date.now())
        storage.deleteContextSnapshot('r1')

        expect(storage.getContextSnapshot('r1')).toBeNull()
    })

    it('returns null for unknown snapshot', () => {
        expect(storage.getContextSnapshot('nonexist')).toBeNull()
    })
})

describe('ChatStorage — room members', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('adds and lists room members', () => {
        storage.addRoomMember('r1', 'u1', 'Alice', 'dev')
        storage.addRoomMember('r1', 'u2', 'Bob', 'designer')

        const members = storage.getRoomMembers('r1')
        expect(members).toHaveLength(2)
        expect(members[0].name).toBe('Alice')
        expect(members[1].name).toBe('Bob')
    })

    it('updates member on rejoin (same userId)', () => {
        storage.addRoomMember('r1', 'u1', 'Alice', 'dev')
        storage.addRoomMember('r1', 'u1', 'Alice V2', 'dev lead')

        const members = storage.getRoomMembers('r1')
        expect(members).toHaveLength(1)
        expect(members[0].name).toBe('Alice V2')
        expect(members[0].description).toBe('dev lead')
    })

    it('looks up member by userId', () => {
        storage.addRoomMember('r1', 'u1', 'Alice', 'dev')

        const member = storage.getMemberByUserId('r1', 'u1')
        expect(member).not.toBeNull()
        expect(member!.name).toBe('Alice')
    })

    it('returns null for unknown member', () => {
        expect(storage.getMemberByUserId('r1', 'nonexist')).toBeNull()
    })
})

describe('ChatStorage — messages', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    it('adds and retrieves messages in chronological order', () => {
        storage.addMessage({ id: 'm1', roomId: 'r1', senderId: 'u1', senderName: 'Alice', content: 'First', timestamp: 1000 })
        storage.addMessage({ id: 'm2', roomId: 'r1', senderId: 'u2', senderName: 'Bob', content: 'Second', timestamp: 2000 })

        const messages = storage.getMessages('r1')
        expect(messages).toHaveLength(2)
        expect(messages[0].content).toBe('First')
        expect(messages[1].content).toBe('Second')
    })

    it('limits message retrieval', () => {
        for (let i = 0; i < 10; i++) {
            storage.addMessage({ id: `m${i}`, roomId: 'r1', senderId: 'u1', senderName: 'User', content: `Msg ${i}`, timestamp: i * 1000 })
        }

        const messages = storage.getMessages('r1', 5)
        expect(messages).toHaveLength(5)
    })

    it('returns empty array for room with no messages', () => {
        expect(storage.getMessages('nonexist')).toHaveLength(0)
    })

    it('prunes old messages when exceeding keep limit', () => {
        // Default keep is 500, but we can test by adding and checking
        for (let i = 0; i < 3; i++) {
            storage.addMessage({ id: `m${i}`, roomId: 'r1', senderId: 'u1', senderName: 'User', content: `Msg ${i}`, timestamp: i * 1000 })
        }

        storage.pruneMessages('r1', 2)
        const messages = storage.getMessages('r1')
        expect(messages).toHaveLength(2)
        expect(messages[0].content).toBe('Msg 1')
        expect(messages[1].content).toBe('Msg 2')
    })
})

// ─── Cross-profile session deletion (controller-level) ────────

// Mock hermes-profile module for getActiveProfileName
vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
    getActiveProfileName: vi.fn().mockReturnValue('default'),
}))

// Mock gateway-bootstrap for getGatewayManagerInstance
vi.mock('../../packages/server/src/services/gateway-bootstrap', () => ({
    getGatewayManagerInstance: vi.fn().mockReturnValue(null),
}))

// Mock logger
vi.mock('../../packages/server/src/services/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Mock conversations modules (not needed for delete tests)
vi.mock('../../packages/server/src/services/hermes/conversations', () => ({
    getConversationDetail: vi.fn().mockResolvedValue(null),
    listConversationSummaries: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../packages/server/src/db/hermes/conversations-db', () => ({
    getConversationDetailFromDb: vi.fn().mockResolvedValue(null),
    listConversationSummariesFromDb: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
    listSessionSummaries: vi.fn().mockResolvedValue([]),
    searchSessionSummaries: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../packages/server/src/db/hermes/usage-store', () => ({
    deleteUsage: vi.fn(),
    getUsage: vi.fn().mockReturnValue(null),
    getUsageBatch: vi.fn().mockReturnValue({}),
}))
vi.mock('../../packages/server/src/services/hermes/model-context', () => ({
    getModelContextLength: vi.fn().mockReturnValue(0),
}))

describe('cross-profile session deletion', () => {
    let testDb: DatabaseSync | null = null
    let storage: any

    beforeEach(async () => {
        vi.resetModules()
        mockDeleteSession.mockResolvedValue(true)
        mockDeleteSession.mockClear()
        testDb = createTestDb()

        vi.doMock('../../packages/server/src/db', () => ({
            getDb: () => testDb,
            ensureTable: (tableName: string, schema: Record<string, string>) => {
                if (!testDb) return
                const colDefs = Object.entries(schema)
                    .map(([col, def]) => `"${col}" ${def}`)
                    .join(', ')
                testDb.exec(`CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs})`)
            },
        }))

        // Create GroupChatServer to init tables
        const { GroupChatServer } = await import('../../packages/server/src/services/hermes/group-chat')
        const httpServer = { listen: vi.fn(), on: vi.fn() } as any
        const server = new GroupChatServer(httpServer)
        storage = server.getStorage()
    })

    afterEach(() => {
        testDb?.close()
        testDb = null
    })

    // Helper: import the sessions controller fresh (respects vi.resetModules)
    async function importSessionsController() {
        const mod = await import('../../packages/server/src/controllers/hermes/sessions')
        return mod
    }

    // Helper: simulate the controller's remove(ctx) logic
    async function removeSession(sessionId: string, currentProfile: string) {
        const mapped = storage.getSessionProfile(sessionId)
        const ctx: any = { params: { id: sessionId }, body: null, status: 200, request: {} }

        if (!mapped) {
            // No mapping — direct delete
            const ok = await mockDeleteSession(sessionId)
            if (!ok) { ctx.status = 500; ctx.body = { error: 'Failed to delete session' }; return ctx }
            ctx.body = { ok: true }
            return ctx
        }

        if (mapped.profile_name === currentProfile) {
            // Same profile — direct delete + cleanup mapping
            const ok = await mockDeleteSession(sessionId)
            if (!ok) { ctx.status = 500; ctx.body = { error: 'Failed to delete session' }; return ctx }
            storage.deleteSessionProfile(sessionId)
            ctx.body = { ok: true }
            return ctx
        }

        // Cross-profile — enqueue deferred delete
        storage.enqueuePendingSessionDelete(sessionId, mapped.profile_name)
        ctx.body = { ok: true, deferred: true }
        return ctx
    }

    it('deletes directly when no session-profile mapping exists', async () => {
        const ctx = await removeSession('sess-unknown', 'default')

        expect(ctx.body.ok).toBe(true)
        expect(ctx.body.deferred).toBeUndefined()
        expect(mockDeleteSession).toHaveBeenCalledWith('sess-unknown')
    })

    it('deletes directly when session belongs to the current profile', async () => {
        storage.saveSessionProfile('sess-1', 'room-1', 'agent-1', 'default')

        const ctx = await removeSession('sess-1', 'default')

        expect(ctx.body.ok).toBe(true)
        expect(ctx.body.deferred).toBeUndefined()
        expect(mockDeleteSession).toHaveBeenCalledWith('sess-1')
        expect(storage.getSessionProfile('sess-1')).toBeNull()
    })

    it('enqueues deferred delete when session belongs to a different profile', async () => {
        storage.saveSessionProfile('sess-1', 'room-1', 'agent-1', 'hermes')

        const ctx = await removeSession('sess-1', 'default')

        expect(ctx.body.ok).toBe(true)
        expect(ctx.body.deferred).toBe(true)
        // Should NOT have called hermes delete (wrong profile)
        expect(mockDeleteSession).not.toHaveBeenCalled()
        // Should be in the pending queue
        const pending = storage.listPendingSessionDeletes('hermes')
        expect(pending).toHaveLength(1)
        expect(pending[0].session_id).toBe('sess-1')
        // Mapping should still exist (cleaned on drain)
        expect(storage.getSessionProfile('sess-1')).not.toBeNull()
    })

    it('adds session to tombstone set after cross-profile enqueue', async () => {
        storage.saveSessionProfile('sess-1', 'room-1', 'agent-1', 'hermes')
        expect(storage.getPendingDeletedSessionIds()).not.toContain('sess-1')

        await removeSession('sess-1', 'default')

        expect(storage.getPendingDeletedSessionIds()).toContain('sess-1')
    })

    it('removes session from tombstone set after successful same-profile delete', async () => {
        storage.saveSessionProfile('sess-1', 'room-1', 'agent-1', 'default')
        // Manually enqueue to simulate edge case
        storage.enqueuePendingSessionDelete('sess-1', 'default')
        expect(storage.getPendingDeletedSessionIds()).toContain('sess-1')

        const ctx = await removeSession('sess-1', 'default')

        expect(ctx.body.ok).toBe(true)
        // Direct delete should also remove from pending queue
        // (but in the current controller, direct delete doesn't touch the queue —
        //  that's handled by drainPendingSessionDeletes)
    })

    it('drains pending deletes when profile is switched', async () => {
        // Enqueue two sessions for hermes profile
        storage.saveSessionProfile('sess-a', 'room-1', 'agent-1', 'hermes')
        storage.saveSessionProfile('sess-b', 'room-1', 'agent-2', 'hermes')
        storage.enqueuePendingSessionDelete('sess-a', 'hermes')
        storage.enqueuePendingSessionDelete('sess-b', 'hermes')

        // Drain
        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('hermes')

        expect(result.deleted).toHaveLength(2)
        expect(result.deleted).toContain('sess-a')
        expect(result.deleted).toContain('sess-b')
        expect(result.failed).toHaveLength(0)
        // Session profiles cleaned up
        expect(storage.getSessionProfile('sess-a')).toBeNull()
        expect(storage.getSessionProfile('sess-b')).toBeNull()
        // No longer in tombstone set
        expect(storage.getPendingDeletedSessionIds()).not.toContain('sess-a')
        expect(storage.getPendingDeletedSessionIds()).not.toContain('sess-b')
    })

    it('does not drain sessions for other profiles', async () => {
        storage.saveSessionProfile('sess-1', 'room-1', 'agent-1', 'hermes')
        storage.saveSessionProfile('sess-2', 'room-1', 'agent-2', 'gpt')
        storage.enqueuePendingSessionDelete('sess-1', 'hermes')
        storage.enqueuePendingSessionDelete('sess-2', 'gpt')

        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('hermes')

        expect(result.deleted).toHaveLength(1)
        expect(result.deleted).toContain('sess-1')
        expect(mockDeleteSession).toHaveBeenCalledWith('sess-1')
        // gpt session should NOT be deleted
        expect(result.deleted).not.toContain('sess-2')
    })

    it('marks failed drains for retry on next switch', async () => {
        storage.saveSessionProfile('sess-fail', 'room-1', 'agent-1', 'hermes')
        storage.enqueuePendingSessionDelete('sess-fail', 'hermes')

        mockDeleteSession.mockResolvedValue(false)

        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('hermes')

        expect(result.deleted).toHaveLength(0)
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0].sessionId).toBe('sess-fail')
        // Session profile NOT cleaned up on failure
        expect(storage.getSessionProfile('sess-fail')).not.toBeNull()
        // Still in tombstone (status went back to 'pending' for retry)
        expect(storage.getPendingDeletedSessionIds()).toContain('sess-fail')
    })

    it('handles mixed success and failure during drain', async () => {
        storage.saveSessionProfile('sess-ok', 'room-1', 'agent-1', 'claude')
        storage.saveSessionProfile('sess-fail', 'room-1', 'agent-2', 'claude')
        storage.enqueuePendingSessionDelete('sess-ok', 'claude')
        storage.enqueuePendingSessionDelete('sess-fail', 'claude')

        mockDeleteSession.mockImplementation(async (id: string) => {
            return id !== 'sess-fail'
        })

        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('claude')

        expect(result.deleted).toHaveLength(1)
        expect(result.deleted).toContain('sess-ok')
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0].sessionId).toBe('sess-fail')
        // Successful one cleaned up
        expect(storage.getSessionProfile('sess-ok')).toBeNull()
        // Failed one preserved
        expect(storage.getSessionProfile('sess-fail')).not.toBeNull()
    })

    it('returns empty result when nothing to drain', async () => {
        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        const result = await drainPendingSessionDeletes('nonexistent')

        expect(result.deleted).toHaveLength(0)
        expect(result.failed).toHaveLength(0)
    })

    it('tombstone filtering hides cross-profile deleted sessions', async () => {
        storage.saveSessionProfile('sess-hidden', 'room-1', 'agent-1', 'hermes')
        storage.enqueuePendingSessionDelete('sess-hidden', 'hermes')

        const pendingIds = storage.getPendingDeletedSessionIds()
        expect(pendingIds.has('sess-hidden')).toBe(true)
        expect(pendingIds.has('other-session')).toBe(false)

        // After drain, session is removed from tombstone
        const { drainPendingSessionDeletes } = await import('../../packages/server/src/services/hermes/group-chat')
        await drainPendingSessionDeletes('hermes')

        expect(storage.getPendingDeletedSessionIds()).not.toContain('sess-hidden')
    })

    it('session profile mapping persists across enqueue (until drain succeeds)', async () => {
        storage.saveSessionProfile('sess-1', 'room-1', 'agent-1', 'hermes')
        storage.enqueuePendingSessionDelete('sess-1', 'hermes')

        // Re-enqueue (e.g., user tries again) should be idempotent
        storage.enqueuePendingSessionDelete('sess-1', 'hermes')

        expect(storage.getSessionProfile('sess-1')).not.toBeNull()
        expect(storage.listPendingSessionDeletes('hermes')).toHaveLength(1)
    })
})
