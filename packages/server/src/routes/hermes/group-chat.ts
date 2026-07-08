import Router from '@koa/router'
import type { GroupChatServer } from '../../services/hermes/group-chat'
import { isReservedMentionName } from '../../services/hermes/group-chat/mention-routing'
import { assertAllowedWorkspaceFolder } from '../../services/hermes/workspace-path'

export const groupChatRoutes = new Router()

let chatServer: GroupChatServer | null = null

export function setGroupChatServer(server: GroupChatServer) {
    chatServer = server
}

export function getGroupChatServer(): GroupChatServer | null {
    return chatServer
}

function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)]
    }
    return code
}

type AgentInput = { profile: string; name?: string; description?: string; invited?: boolean | number }

function sanitizeAgentConnectReason(reason?: string): string {
    return (reason || 'agent runtime connection failed')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, '$1=[REDACTED]')
        .split('\n')[0]
        .slice(0, 240)
}

function agentConnectFailureBody(profile: string, err: any) {
    return {
        code: 'PROFILE_AGENT_CONNECT_FAILED',
        error: `Failed to connect agent "${profile}" to room`,
        profile,
        reason: sanitizeAgentConnectReason(err?.message),
    }
}

function userProfiles(user: any): string[] {
    return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
}

function isRoomOwner(room: any, user: any): boolean {
    return typeof user?.id === 'number' && Number(room?.ownerAuthUserId || 0) === user.id
}

function hasProfileRoomAccess(storage: ReturnType<GroupChatServer['getStorage']>, roomId: string, user: any): boolean {
    const profiles = userProfiles(user)
    if (!profiles.length || typeof storage.getRoomsForProfiles !== 'function') return false
    return storage.getRoomsForProfiles(profiles).some(room => room.id === roomId)
}

function canManageRoom(storage: ReturnType<GroupChatServer['getStorage']>, roomId: string, user: any): boolean {
    if (!user || user.role === 'super_admin') return true
    const room = typeof storage.getRoom === 'function' ? storage.getRoom(roomId) : null
    if (room && isRoomOwner(room, user)) return true
    return hasProfileRoomAccess(storage, roomId, user)
}

function canReadRoom(storage: ReturnType<GroupChatServer['getStorage']>, roomId: string, user: any): boolean {
    if (canManageRoom(storage, roomId, user)) return true
    return typeof user?.id === 'number' && typeof storage.getMemberByAuthUserId === 'function' && !!storage.getMemberByAuthUserId(roomId, user.id)
}

function serializeRoom(room: any, includeManageFields: boolean) {
    if (!room) return room
    const { ownerAuthUserId: _ownerAuthUserId, ...rest } = room
    const serialized = { ...rest, canManage: includeManageFields }
    if (Object.prototype.hasOwnProperty.call(room, 'inviteCode')) {
        serialized.inviteCode = includeManageFields ? room.inviteCode ?? null : null
    }
    if (Object.prototype.hasOwnProperty.call(room, 'workspace')) {
        serialized.workspace = includeManageFields ? String(room.workspace || '') : ''
    }
    return serialized
}

function persistRoomCreator(storage: ReturnType<GroupChatServer['getStorage']>, roomId: string, user: any): void {
    if (typeof user?.id !== 'number' || user.id <= 0) return
    storage.setRoomOwnerAuthUserId?.(roomId, user.id)
    const username = String(user.username || `User-${user.id}`)
    storage.addRoomMember(roomId, `auth:${user.id}`, username, '', '', user.id)
}

function visibleRoomsForUser(storage: ReturnType<GroupChatServer['getStorage']>, user: any) {
    if (!user || user.role === 'super_admin') return storage.getAllRooms().map(room => serializeRoom(room, true))
    const byId = new Map<string, any>()
    const addRoom = (room: any, includeWorkspace: boolean) => {
        if (!room) return
        if (byId.has(room.id) && includeWorkspace) byId.set(room.id, serializeRoom(room, true))
        else if (!byId.has(room.id)) byId.set(room.id, serializeRoom(room, includeWorkspace))
    }
    for (const room of storage.getRoomsForProfiles(userProfiles(user))) addRoom(room, true)
    if (typeof user.id === 'number') {
        if (typeof storage.getOwnedRoomsForAuthUser === 'function') {
            for (const room of storage.getOwnedRoomsForAuthUser(user.id)) addRoom(room, true)
        }
        if (typeof storage.getRoomsForAuthUser === 'function') {
            for (const room of storage.getRoomsForAuthUser(user.id)) addRoom(room, canManageRoom(storage, room.id, user))
        }
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function connectAndPersistRoomAgent(server: GroupChatServer, roomId: string, input: AgentInput, agentId = generateId()) {
    const profile = input.profile
    const name = input.name || profile
    const description = input.description || ''
    const invited = input.invited ? 1 : 0
    const client = await server.agentClients.createAgent({
        agentId,
        profile,
        name,
        description,
        invited,
    })

    const storage = server.getStorage()
    let persisted: any
    try {
        persisted = storage.addRoomAgent(roomId, agentId, profile, name, description, invited)
        await server.agentClients.addAgentToRoom(roomId, client)
        return persisted
    } catch (err) {
        if (persisted) storage.removeRoomAgent(roomId, persisted.id || agentId)
        else client.disconnect?.()
        server.agentClients.removeAgentFromRoom(roomId, client.agentId)
        throw err
    }
}

// Create room
groupChatRoutes.post('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { name, inviteCode, agents, compression, workspace } = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
        compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
        workspace?: string
    }
    if (!name || !inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'name and inviteCode are required' }
        return
    }
    const reservedAgent = (agents || []).find(a => isReservedMentionName(a.name || a.profile))
    if (reservedAgent) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const roomId = generateId()
    const storage = chatServer.getStorage()
    let normalizedWorkspace = ''
    if (workspace !== undefined) {
        if (typeof workspace !== 'string') {
            ctx.status = 400
            ctx.body = { error: 'workspace must be a string' }
            return
        }
        const rawWorkspace = workspace.trim()
        if (rawWorkspace) {
            try {
                normalizedWorkspace = (await assertAllowedWorkspaceFolder(rawWorkspace)).fullPath
            } catch (err: any) {
                ctx.status = Number(err?.status || 403)
                ctx.body = { error: err?.message || 'Workspace folder is not allowed' }
                return
            }
        }
    }
    const compressionConfig = compression ? {
        triggerTokens: compression.triggerTokens,
        maxHistoryTokens: compression.maxHistoryTokens,
        tailMessageCount: compression.tailMessageCount,
        workspace: normalizedWorkspace,
    } : { workspace: normalizedWorkspace }
    storage.saveRoom(roomId, name, inviteCode, compressionConfig)
    persistRoomCreator(storage, roomId, ctx.state?.user)

    const addedAgents = []
    const agentResults = []
    for (const a of agents || []) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                profile: a.profile,
                name: a.name || a.profile,
                description: a.description || '',
                invited: a.invited,
            })
            addedAgents.push(agent)
            agentResults.push({ profile: a.profile, ok: true, agent })
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect agent ${a.profile} to room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(a.profile, err) })
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = { room: serializeRoom(room, true), agents: addedAgents, agentResults }
})

// Clone room roles/config without copying the conversation context.
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/clone', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const sourceRoom = storage.getRoom(ctx.params.roomId)
    if (!sourceRoom) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, sourceRoom.id, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const { name, inviteCode } = ctx.request.body as { name?: string; inviteCode?: string }
    const roomId = generateId()
    const code = inviteCode?.trim() || generateInviteCode()
    storage.saveRoom(roomId, name?.trim() || `${sourceRoom.name} Copy`, code, {
        triggerTokens: sourceRoom.triggerTokens,
        maxHistoryTokens: sourceRoom.maxHistoryTokens,
        tailMessageCount: sourceRoom.tailMessageCount,
        workspace: sourceRoom.workspace || '',
    })
    persistRoomCreator(storage, roomId, ctx.state?.user)

    const addedAgents = []
    const agentResults = []
    for (const sourceAgent of storage.getRoomAgents(sourceRoom.id)) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                profile: sourceAgent.profile,
                name: sourceAgent.name,
                description: sourceAgent.description,
                invited: sourceAgent.invited,
            })
            addedAgents.push(agent)
            agentResults.push({ profile: sourceAgent.profile, ok: true, agent })
        } catch (err: any) {
            console.error(`[GroupChat] Failed to connect cloned agent ${sourceAgent.profile} to room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(sourceAgent.profile, err) })
        }
    }

    const room = storage.getRoom(roomId)
    ctx.body = { room: serializeRoom(room, true), agents: addedAgents, agentResults }
})

// Get room detail and messages
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    const canManage = canManageRoom(storage, room.id, ctx.state?.user)
    if (!canManage && !canReadRoom(storage, room.id, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const offset = ctx.query.offset ? Math.max(0, parseInt(ctx.query.offset as string, 10) || 0) : 0
    const limit = ctx.query.limit ? Math.max(1, parseInt(ctx.query.limit as string, 10) || 150) : 150
    const messages = storage.getRecentMessagesForUI(ctx.params.roomId, limit, offset)
    const total = storage.getMessageCount(ctx.params.roomId)
    const agents = storage.getRoomAgents(ctx.params.roomId)
    const members = storage.getRoomMembers(ctx.params.roomId)
    ctx.body = { room: serializeRoom(room, canManage), messages, agents, members, total, offset, limit, hasMore: offset + messages.length < total }
})

// List rooms
groupChatRoutes.get('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const user = ctx.state?.user
    const storage = chatServer.getStorage()
    const rooms = visibleRoomsForUser(storage, user)
    ctx.body = { rooms }
})

function roomWithoutWorkspace(room: any) {
    return serializeRoom(room, false)
}

// Get room by invite code
groupChatRoutes.get('/api/hermes/group-chat/rooms/join/:code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const room = chatServer.getStorage().getRoomByInviteCode(ctx.params.code)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    ctx.body = { room: roomWithoutWorkspace(room) }
})

// Update room invite code
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/invite-code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const room = storage.getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, ctx.params.roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const { inviteCode } = ctx.request.body as { inviteCode?: string }
    if (!inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'inviteCode is required' }
        return
    }

    storage.updateRoomInviteCode(ctx.params.roomId, inviteCode)
    ctx.body = { success: true }
})

// Add agent to room
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { profile, name, description, invited } = ctx.request.body as { profile?: string; name?: string; description?: string; invited?: boolean }
    if (!profile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    if (isReservedMentionName(name || profile)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const storage = chatServer.getStorage()
    if (typeof storage.getRoom === 'function' && !storage.getRoom(ctx.params.roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, ctx.params.roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    // Prevent duplicate agent in same room
    const existing = storage.getRoomAgents(ctx.params.roomId)
    if (existing.find(a => a.profile === profile)) {
        ctx.status = 409
        ctx.body = { error: 'Agent already in room' }
        return
    }

    try {
        const agent = await connectAndPersistRoomAgent(chatServer, ctx.params.roomId, {
            profile,
            name: name || profile,
            description: description || '',
            invited,
        })
        ctx.body = { agent }
    } catch (err: any) {
        console.error(`[GroupChat] Failed to connect agent ${profile} to room ${ctx.params.roomId}: ${sanitizeAgentConnectReason(err.message)}`)
        ctx.status = 502
        ctx.body = agentConnectFailureBody(profile, err)
    }
})

// List agents in room
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    if (typeof storage.getRoom === 'function' && !storage.getRoom(ctx.params.roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canReadRoom(storage, ctx.params.roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const agents = storage.getRoomAgents(ctx.params.roomId)
    ctx.body = { agents }
})

// Remove agent from room
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const requestedAgentId = ctx.params.agentId
    const storage = chatServer.getStorage()
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const agent = storage.getRoomAgent(roomId, requestedAgentId)
    if (!agent) {
        ctx.status = 404
        ctx.body = { error: 'Agent not found' }
        return
    }

    storage.removeRoomMembersForAgent(roomId, agent)
    storage.removeRoomAgent(roomId, requestedAgentId)
    chatServer.agentClients.removeAgentFromRoom(roomId, agent.agentId)
    ctx.body = {
        success: true,
        agents: storage.getRoomAgents(roomId),
        members: storage.getRoomMembers(roomId),
    }
})

// Delete room
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    if (!storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    // Interrupt active bridge runs, then evict sockets and disconnect agents before deleting persisted data.
    try {
        await chatServer.deleteRoomRuntimeState(roomId)
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    // Delete all data
    storage.deleteRoom(roomId)
    ctx.body = { success: true }
})

// Clear current room context while keeping members, agents, and room config.
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/clear-context', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    try {
        await chatServer.clearRoomRuntimeState(roomId)
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    storage.clearRoomContext(roomId)
    ctx.body = { success: true, room: serializeRoom(storage.getRoom(roomId), true) }
})

// Update room compression config
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/config', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const { triggerTokens, maxHistoryTokens, tailMessageCount } = ctx.request.body as {
        triggerTokens?: number
        maxHistoryTokens?: number
        tailMessageCount?: number
    }

    const storage = chatServer.getStorage()
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    storage.updateRoomConfig(roomId, { triggerTokens, maxHistoryTokens, tailMessageCount })
    ctx.body = { room: serializeRoom(storage.getRoom(roomId), true) }
})

// Update room workspace
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/workspace', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const roomId = ctx.params.roomId
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const { workspace } = ctx.request.body as { workspace: string }
    if (typeof workspace !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'workspace must be a string' }
        return
    }

    try {
        const rawWorkspace = workspace.trim()
        const normalized = rawWorkspace ? (await assertAllowedWorkspaceFolder(rawWorkspace)).fullPath : ''
        if (normalized !== String(room.workspace || '')) {
            const releaseSessionFence = chatServer.fenceCurrentRoomAgentSessions(roomId)
            try {
                await chatServer.agentClients.interruptRoom(roomId)
            } catch (err) {
                releaseSessionFence()
                throw err
            }
        }
        ctx.body = { room: serializeRoom(storage.updateRoomWorkspace(roomId, normalized), true) }
    } catch (err: any) {
        ctx.status = Number(err?.status || 403)
        ctx.body = { error: err?.message || 'Workspace folder is not allowed' }
    }
})

// Force compress a room's context
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/compress', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    if (!storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const engine = chatServer.getContextEngine()
    if (!engine) {
        ctx.status = 503
        ctx.body = { error: 'Context engine not available' }
        return
    }

    try {
        const result = await engine.forceCompress(roomId)
        ctx.body = { success: true, summary: result }
    } catch (err: any) {
        ctx.status = 500
        ctx.body = { error: err.message }
    }
})
