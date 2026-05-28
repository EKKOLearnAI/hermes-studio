import Router from '@koa/router'
import type { GroupChatServer } from '../../services/hermes/group-chat'
import { isReservedMentionName } from '../../services/hermes/group-chat/mention-routing'

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

    try {
        await server.agentClients.addAgentToRoom(roomId, client)
        return server.getStorage().addRoomAgent(roomId, agentId, profile, name, description, invited)
    } catch (err) {
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

    const { name, inviteCode, agents, compression } = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
        compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
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
    storage.saveRoom(roomId, name, inviteCode, compression)

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
    ctx.body = { room, agents: addedAgents, agentResults }
})

// Clone room roles/config without copying the conversation context.
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/clone', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const sourceRoom = chatServer.getStorage().getRoom(ctx.params.roomId)
    if (!sourceRoom) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    const { name, inviteCode } = ctx.request.body as { name?: string; inviteCode?: string }
    const roomId = generateId()
    const storage = chatServer.getStorage()
    const code = inviteCode?.trim() || generateInviteCode()
    storage.saveRoom(roomId, name?.trim() || `${sourceRoom.name} Copy`, code, {
        triggerTokens: sourceRoom.triggerTokens,
        maxHistoryTokens: sourceRoom.maxHistoryTokens,
        tailMessageCount: sourceRoom.tailMessageCount,
    })

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
    ctx.body = { room, agents: addedAgents, agentResults }
})

// Get room detail and messages
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const room = chatServer.getStorage().getRoom(ctx.params.roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    const offset = ctx.query.offset ? Math.max(0, parseInt(ctx.query.offset as string, 10) || 0) : 0
    const limit = ctx.query.limit ? Math.max(1, parseInt(ctx.query.limit as string, 10) || 300) : 300
    const messages = chatServer.getStorage().getMessages(ctx.params.roomId, limit, offset)
    const total = chatServer.getStorage().getMessageCount(ctx.params.roomId)
    const agents = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
    const members = chatServer.getStorage().getRoomMembers(ctx.params.roomId)
    ctx.body = { room, messages, agents, members, total, offset, limit, hasMore: offset + messages.length < total }
})

// List rooms
groupChatRoutes.get('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const user = ctx.state.user
    const storage = chatServer.getStorage()
    const rooms = !user || user.role === 'super_admin'
        ? storage.getAllRooms()
        : storage.getRoomsForProfiles(user.profiles || [])
    ctx.body = { rooms }
})

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

    ctx.body = { room }
})

// Update room invite code
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/invite-code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { inviteCode } = ctx.request.body as { inviteCode?: string }
    if (!inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'inviteCode is required' }
        return
    }

    chatServer.getStorage().updateRoomInviteCode(ctx.params.roomId, inviteCode)
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

    // Prevent duplicate agent in same room
    const existing = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
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

    const agents = chatServer.getStorage().getRoomAgents(ctx.params.roomId)
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
    // Disconnect all agents in room
    chatServer.agentClients.disconnectRoom(roomId)
    // Delete all data
    chatServer.getStorage().deleteRoom(roomId)
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
    if (!chatServer.getStorage().getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }

    chatServer.getStorage().clearRoomContext(roomId)
    chatServer.clearRoomRuntimeState(roomId)
    ctx.body = { success: true, room: chatServer.getStorage().getRoom(roomId) }
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

    chatServer.getStorage().updateRoomConfig(roomId, { triggerTokens, maxHistoryTokens, tailMessageCount })
    const room = chatServer.getStorage().getRoom(roomId)
    ctx.body = { room }
})

// Force compress a room's context
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/compress', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    if (!chatServer.getStorage().getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
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
