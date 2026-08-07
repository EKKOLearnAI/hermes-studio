import Router from '@koa/router'
import type { GroupChatServer } from '../../services/hermes/group-chat'
import { isReservedMentionName } from '../../services/hermes/group-chat/mention-routing'
import { assertAllowedWorkspaceFolder } from '../../services/hermes/workspace-path'
import {
    canManageGroupChatRoom as canManageRoom,
    canReadGroupChatRoom as canReadRoom,
    groupChatUserProfiles as userProfiles,
} from '../../services/hermes/group-chat/access'
import { setGroupChatRuntimeServer } from '../../services/hermes/group-chat/runtime'
import * as ctrl from '../../controllers/hermes/group-chat-workspace'

export const groupChatRoutes = new Router()

let chatServer: GroupChatServer | null = null

export function setGroupChatServer(server: GroupChatServer | null) {
    chatServer = server
    setGroupChatRuntimeServer(server)
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

function contentPreview(content: unknown): string {
    const value = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    return value.length > 500 ? `${value.slice(0, 500)}…` : value
}

type AgentInput = {
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude'
    profile: string
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    name?: string
    description?: string
    avatar?: string
    invited?: boolean | number
}

type RoomSummaryInput = {
    profile?: string
    provider?: string
    model?: string
    apiMode?: string
    everyTurns?: number
}

const GROUP_AGENT_REASONING_EFFORTS = new Set(['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const GROUP_AGENT_TYPES = new Set(['hermes', 'ekko', 'codex', 'claude'])
const GROUP_AGENT_API_MODES = new Set(['chat_completions', 'codex_responses', 'anthropic_messages'])
const GROUP_AGENT_AVATAR_MAX_LENGTH = 1_500_000

function normalizeRoomAgentAvatar(value: unknown): string {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value !== 'string' || value.length > GROUP_AGENT_AVATAR_MAX_LENGTH) {
        throw new Error('Invalid agent avatar')
    }
    let parsed: any
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new Error('Invalid agent avatar')
    }
    if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed.trim() && parsed.seed.length <= 200) {
        return JSON.stringify({ type: 'generated', seed: parsed.seed.trim() })
    }
    if (
        parsed?.type === 'image' &&
        typeof parsed.dataUrl === 'string' &&
        /^data:image\/(?:png|jpeg|webp);base64,/i.test(parsed.dataUrl) &&
        parsed.dataUrl.length <= GROUP_AGENT_AVATAR_MAX_LENGTH
    ) {
        return JSON.stringify({ type: 'image', dataUrl: parsed.dataUrl })
    }
    throw new Error('Invalid agent avatar')
}

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

async function createRoomAgentRuntimeClient(server: GroupChatServer, agentId: string, input: AgentInput) {
    const agent = String(input.agent || 'hermes').trim() as AgentInput['agent']
    const profile = input.profile.trim()
    return server.agentClients.createAgent({
        agentId,
        agent: agent || 'hermes',
        profile,
        provider: String(input.provider || '').trim(),
        model: String(input.model || '').trim(),
        apiMode: agent === 'hermes' ? '' : String(input.apiMode || '').trim(),
        reasoningEffort: String(input.reasoningEffort || '').trim(),
        name: input.name || profile,
        description: input.description || '',
        invited: input.invited ? 1 : 0,
        backgroundDelegationEnabled: false,
    })
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

function persistRoomCreator(
    storage: ReturnType<GroupChatServer['getStorage']>,
    roomId: string,
    user: any,
    memberName?: string,
    memberDescription?: string,
): void {
    if (typeof user?.id !== 'number' || user.id <= 0) return
    storage.setRoomOwnerAuthUserId?.(roomId, user.id)
    const username = memberName?.trim() || String(user.username || `User-${user.id}`)
    storage.addRoomMember(roomId, `auth:${user.id}`, username, memberDescription?.trim() || '', '', user.id)
}

function visibleRoomsForUser(storage: ReturnType<GroupChatServer['getStorage']>, user: any) {
    if (!user || user.role === 'super_admin') return storage.getAllRooms().map(room => serializeRoom(room, true))
    const byId = new Map<string, { room: any; includeWorkspace: boolean }>()
    const addRoom = (room: any, includeWorkspace: boolean) => {
        if (!room) return
        const existing = byId.get(room.id)
        if (!existing || includeWorkspace) byId.set(room.id, { room, includeWorkspace: includeWorkspace || existing?.includeWorkspace === true })
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
    return [...byId.values()]
        .sort((a, b) => Number(b.room._activityAt || 0) - Number(a.room._activityAt || 0) || a.room.id.localeCompare(b.room.id))
        .map(({ room, includeWorkspace }) => serializeRoom(room, includeWorkspace))
}

async function connectAndPersistRoomAgent(server: GroupChatServer, roomId: string, input: AgentInput, agentId = generateId()) {
    const agent = String(input.agent || 'hermes').trim() as AgentInput['agent']
    if (!GROUP_AGENT_TYPES.has(agent || '')) {
        throw new Error('Invalid agent')
    }
    const profile = input.profile.trim()
    const provider = String(input.provider || '').trim()
    const model = String(input.model || '').trim()
    const apiMode = agent === 'hermes' ? '' : String(input.apiMode || '').trim()
    const reasoningEffort = String(input.reasoningEffort || '').trim()
    const name = input.name || profile
    const description = input.description || ''
    const avatar = normalizeRoomAgentAvatar(input.avatar)
    const invited = input.invited ? 1 : 0
    const client = await createRoomAgentRuntimeClient(server, agentId, input)

    const storage = server.getStorage()
    let persisted: any
    try {
        persisted = storage.addRoomAgent(roomId, agentId, profile, name, description, invited, {
            agent: agent || 'hermes',
            provider,
            model,
            apiMode,
            reasoningEffort,
            ...(avatar ? { avatar } : {}),
        })
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

    const createInput = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: {
            agent?: 'hermes' | 'ekko' | 'codex' | 'claude'
            profile: string
            provider?: string
            model?: string
            apiMode?: string
            reasoningEffort?: string
            name?: string
            description?: string
            avatar?: string
            invited?: boolean
        }[]
        summary?: RoomSummaryInput
        workspace?: string
        memberName?: string
        memberDescription?: string
    }
    const { name, inviteCode, agents, summary, workspace, memberName, memberDescription } = createInput
    if (!name || !inviteCode) {
        ctx.status = 400
        ctx.body = { error: 'name and inviteCode are required' }
        return
    }
    const hasSummaryConfig = summary !== undefined
    const summaryProfile = String(summary?.profile || 'default').trim() || 'default'
    const summaryProvider = String(summary?.provider || '').trim()
    const summaryModel = String(summary?.model || '').trim()
    const summaryApiMode = String(summary?.apiMode || 'chat_completions').trim()
    const summaryEveryTurns = Math.floor(Number(summary?.everyTurns ?? 20))
    if (hasSummaryConfig && (!summaryProvider || !summaryModel)) {
        ctx.status = 400
        ctx.body = { error: 'summary profile, provider and model are required' }
        return
    }
    if (hasSummaryConfig && !GROUP_AGENT_API_MODES.has(summaryApiMode)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid summary apiMode' }
        return
    }
    if (hasSummaryConfig && (!Number.isFinite(summaryEveryTurns) || summaryEveryTurns < 1 || summaryEveryTurns > 1000)) {
        ctx.status = 400
        ctx.body = { error: 'summary everyTurns must be between 1 and 1000' }
        return
    }
    if (
        (memberName !== undefined && typeof memberName !== 'string') ||
        (memberDescription !== undefined && typeof memberDescription !== 'string')
    ) {
        ctx.status = 400
        ctx.body = { error: 'memberName and memberDescription must be strings' }
        return
    }
    if ((memberName?.trim().length || 0) > 120 || (memberDescription?.trim().length || 0) > 2000) {
        ctx.status = 400
        ctx.body = { error: 'Member profile is too long' }
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
    if (!normalizedWorkspace) {
        normalizedWorkspace = chatServer.ensureDefaultRoomWorkspace(roomId, summaryProfile)
    }
    const roomConfig = {
        summaryProfile,
        summaryProvider,
        summaryModel,
        summaryApiMode,
        summaryEveryTurns,
        workspace: normalizedWorkspace,
    }
    storage.saveRoom(roomId, name, inviteCode, roomConfig)
    persistRoomCreator(storage, roomId, ctx.state?.user, memberName, memberDescription)

    const addedAgents = []
    const agentResults = []
    for (const a of agents || []) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                agent: a.agent,
                profile: a.profile,
                provider: a.provider,
                model: a.model,
                apiMode: a.apiMode,
                reasoningEffort: a.reasoningEffort,
                name: a.name || a.profile,
                description: a.description || '',
                avatar: a.avatar,
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
        summaryProfile: sourceRoom.summaryProfile,
        summaryProvider: sourceRoom.summaryProvider,
        summaryModel: sourceRoom.summaryModel,
        summaryApiMode: sourceRoom.summaryApiMode,
        summaryEveryTurns: sourceRoom.summaryEveryTurns,
        workspace: sourceRoom.workspace || '',
    })
    persistRoomCreator(storage, roomId, ctx.state?.user)

    const addedAgents = []
    const agentResults = []
    for (const sourceAgent of storage.getRoomAgents(sourceRoom.id)) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                agent: sourceAgent.agent,
                profile: sourceAgent.profile,
                provider: sourceAgent.provider,
                model: sourceAgent.model,
                apiMode: sourceAgent.apiMode,
                reasoningEffort: sourceAgent.reasoningEffort,
                name: sourceAgent.name,
                description: sourceAgent.description,
                avatar: sourceAgent.avatar,
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

groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/workspace-files/list', ctrl.listWorkspaceFiles)
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/workspace-file/read', ctrl.readWorkspaceFile)
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/workspace-file/content', ctrl.readWorkspaceFileContent)
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/workspace-file/write', ctrl.writeWorkspaceFile)
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/workspace-file/mkdir', ctrl.mkdirWorkspaceFile)
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId/workspace-file/delete', ctrl.deleteWorkspaceFile)
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/workspace-file/rename', ctrl.renameWorkspaceFile)
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/workspace-file/copy', ctrl.copyWorkspaceFile)

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

    const { agent, profile, provider, model, apiMode, reasoningEffort, name, description, avatar, invited } = ctx.request.body as {
        agent?: string
        profile?: string
        provider?: string
        model?: string
        apiMode?: string
        reasoningEffort?: string
        name?: string
        description?: string
        avatar?: string
        invited?: boolean
    }
    const normalizedProfile = typeof profile === 'string' ? profile.trim() : ''
    const normalizedAgent = typeof agent === 'string' ? agent.trim() : 'hermes'
    const normalizedProvider = typeof provider === 'string' ? provider.trim() : ''
    const normalizedModel = typeof model === 'string' ? model.trim() : ''
    const normalizedApiMode = normalizedAgent === 'hermes'
        ? ''
        : typeof apiMode === 'string' ? apiMode.trim() : ''
    const normalizedReasoningEffort = typeof reasoningEffort === 'string' ? reasoningEffort.trim() : ''
    let normalizedAvatar = ''
    try {
        normalizedAvatar = normalizeRoomAgentAvatar(avatar)
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
        return
    }
    if (!normalizedProfile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    if (!GROUP_AGENT_TYPES.has(normalizedAgent)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid agent' }
        return
    }
    if (Boolean(normalizedProvider) !== Boolean(normalizedModel)) {
        ctx.status = 400
        ctx.body = { error: 'provider and model must be provided together' }
        return
    }
    if (normalizedAgent !== 'hermes' && !GROUP_AGENT_API_MODES.has(normalizedApiMode)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid apiMode' }
        return
    }
    if (!GROUP_AGENT_REASONING_EFFORTS.has(normalizedReasoningEffort)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid reasoningEffort' }
        return
    }
    if (isReservedMentionName(name || normalizedProfile)) {
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

    try {
        const agent = await connectAndPersistRoomAgent(chatServer, ctx.params.roomId, {
            agent: normalizedAgent as AgentInput['agent'],
            profile: normalizedProfile,
            provider: normalizedProvider,
            model: normalizedModel,
            apiMode: normalizedApiMode,
            reasoningEffort: normalizedReasoningEffort,
            name: name || normalizedProfile,
            description: description || '',
            avatar: normalizedAvatar,
            invited,
        })
        ctx.body = { agent }
    } catch (err: any) {
        console.error(`[GroupChat] Failed to connect agent ${normalizedProfile} to room ${ctx.params.roomId}: ${sanitizeAgentConnectReason(err.message)}`)
        ctx.status = 502
        ctx.body = agentConnectFailureBody(normalizedProfile, err)
    }
})

// Update an agent and replace only its group-chat runtime client.
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const { agent, profile, provider, model, apiMode, reasoningEffort, name, description, avatar } = ctx.request.body as {
        agent?: string
        profile?: string
        provider?: string
        model?: string
        apiMode?: string
        reasoningEffort?: string
        name?: string
        description?: string
        avatar?: string
    }
    const normalizedProfile = typeof profile === 'string' ? profile.trim() : ''
    const normalizedAgent = typeof agent === 'string' ? agent.trim() : 'hermes'
    const normalizedProvider = typeof provider === 'string' ? provider.trim() : ''
    const normalizedModel = typeof model === 'string' ? model.trim() : ''
    const normalizedApiMode = normalizedAgent === 'hermes'
        ? ''
        : typeof apiMode === 'string' ? apiMode.trim() : ''
    const normalizedReasoningEffort = typeof reasoningEffort === 'string' ? reasoningEffort.trim() : ''
    const normalizedName = typeof name === 'string' ? name.trim() : ''
    const normalizedDescription = typeof description === 'string' ? description.trim() : ''
    let normalizedAvatar = ''
    try {
        normalizedAvatar = normalizeRoomAgentAvatar(avatar)
    } catch (err: any) {
        ctx.status = 400
        ctx.body = { error: err.message }
        return
    }
    if (!normalizedProfile) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    if (!GROUP_AGENT_TYPES.has(normalizedAgent)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid agent' }
        return
    }
    if (Boolean(normalizedProvider) !== Boolean(normalizedModel)) {
        ctx.status = 400
        ctx.body = { error: 'provider and model must be provided together' }
        return
    }
    if (normalizedAgent !== 'hermes' && !GROUP_AGENT_API_MODES.has(normalizedApiMode)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid apiMode' }
        return
    }
    if (!GROUP_AGENT_REASONING_EFFORTS.has(normalizedReasoningEffort)) {
        ctx.status = 400
        ctx.body = { error: 'Invalid reasoningEffort' }
        return
    }
    if (isReservedMentionName(normalizedName || normalizedProfile)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const roomId = ctx.params.roomId
    const requestedAgentId = ctx.params.agentId
    const storage = chatServer.getStorage()
    if (typeof storage.getRoom === 'function' && !storage.getRoom(roomId)) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    if (!canManageRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const previous = storage.getRoomAgent(roomId, requestedAgentId)
    if (!previous) {
        ctx.status = 404
        ctx.body = { error: 'Agent not found' }
        return
    }

    const nextInput: AgentInput = {
        agent: normalizedAgent as AgentInput['agent'],
        profile: normalizedProfile,
        provider: normalizedProvider,
        model: normalizedModel,
        apiMode: normalizedApiMode,
        reasoningEffort: normalizedReasoningEffort,
        name: normalizedName || normalizedProfile,
        description: normalizedDescription,
        avatar: normalizedAvatar,
        invited: previous.invited,
    }
    let replacement: Awaited<ReturnType<typeof createRoomAgentRuntimeClient>> | null = null
    let runtimeSwapped = false
    try {
        // Establish the new gateway connection before interrupting the current room client.
        replacement = await createRoomAgentRuntimeClient(chatServer, previous.agentId, nextInput)
        chatServer.agentClients.removeAgentFromRoom(roomId, previous.agentId)
        runtimeSwapped = true
        await chatServer.agentClients.addAgentToRoom(roomId, replacement)
        const updated = storage.updateRoomAgent(
            roomId,
            requestedAgentId,
            nextInput.profile,
            nextInput.name || nextInput.profile,
            nextInput.description || '',
            {
                agent: nextInput.agent,
                provider: nextInput.provider,
                model: nextInput.model,
                apiMode: nextInput.apiMode,
                reasoningEffort: nextInput.reasoningEffort,
                ...(nextInput.avatar ? { avatar: nextInput.avatar } : {}),
            },
        )
        if (!updated) throw new Error('Agent persistence update failed')
        ctx.body = {
            agent: updated,
            agents: storage.getRoomAgents(roomId),
            members: storage.getRoomMembers(roomId),
        }
    } catch (err: any) {
        if (runtimeSwapped) {
            chatServer.agentClients.removeAgentFromRoom(roomId, previous.agentId)
            try {
                const restored = await createRoomAgentRuntimeClient(chatServer, previous.agentId, previous)
                await chatServer.agentClients.addAgentToRoom(roomId, restored)
            } catch (restoreErr: any) {
                console.error(`[GroupChat] Failed to restore agent ${previous.profile} in room ${roomId}: ${sanitizeAgentConnectReason(restoreErr.message)}`)
            }
        } else {
            replacement?.disconnect?.()
        }
        console.error(`[GroupChat] Failed to update agent ${normalizedProfile} in room ${roomId}: ${sanitizeAgentConnectReason(err.message)}`)
        ctx.status = 502
        ctx.body = agentConnectFailureBody(normalizedProfile, err)
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
        await chatServer.getRoomSummaryService().runExclusive(roomId, async () => {
            await chatServer!.deleteRoomRuntimeState(roomId)
            storage.deleteRoom(roomId)
        })
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
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
        await chatServer.getRoomSummaryService().runExclusive(roomId, async () => {
            await chatServer!.clearRoomRuntimeState(roomId)
            storage.clearRoomContext(roomId)
        })
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    ctx.body = { success: true, room: serializeRoom(storage.getRoom(roomId), true) }
})

// Update room name and rolling-summary config
groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/config', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const { name, summaryProfile, summaryProvider, summaryModel, summaryApiMode, summaryEveryTurns } = ctx.request.body as {
        name?: string
        summaryProfile?: string
        summaryProvider?: string
        summaryModel?: string
        summaryApiMode?: string
        summaryEveryTurns?: number
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

    const hasNameUpdate = name !== undefined
    const hasSummaryUpdate = [
        summaryProfile,
        summaryProvider,
        summaryModel,
        summaryApiMode,
        summaryEveryTurns,
    ].some(value => value !== undefined)
    if (!hasNameUpdate && !hasSummaryUpdate) {
        ctx.status = 400
        ctx.body = { error: 'No room config changes supplied' }
        return
    }

    const normalizedName = hasNameUpdate && typeof name === 'string' ? name.trim() : room.name
    if (hasNameUpdate && (typeof name !== 'string' || !normalizedName || normalizedName.length > 120)) {
        ctx.status = 400
        ctx.body = { error: 'Room name must be between 1 and 120 characters' }
        return
    }

    const profile = String(summaryProfile ?? room.summaryProfile).trim()
    const provider = String(summaryProvider ?? room.summaryProvider).trim()
    const model = String(summaryModel ?? room.summaryModel).trim()
    const apiMode = String(summaryApiMode ?? room.summaryApiMode).trim()
    const everyTurns = Math.floor(Number(summaryEveryTurns ?? room.summaryEveryTurns))
    if (hasSummaryUpdate) {
        if (!profile || !provider || !model) {
            ctx.status = 400
            ctx.body = { error: 'summary profile, provider and model are required' }
            return
        }
        if (!GROUP_AGENT_API_MODES.has(apiMode)) {
            ctx.status = 400
            ctx.body = { error: 'Invalid summary apiMode' }
            return
        }
        if (!Number.isFinite(everyTurns) || everyTurns < 1 || everyTurns > 1000) {
            ctx.status = 400
            ctx.body = { error: 'summaryEveryTurns must be between 1 and 1000' }
            return
        }
    }

    await chatServer.getRoomSummaryService().runExclusive(roomId, () => {
        if (hasNameUpdate && normalizedName !== room.name) {
            chatServer!.updateRoomName(roomId, normalizedName)
        }
        if (hasSummaryUpdate) {
            storage.updateRoomConfig(roomId, {
                summaryProfile: profile,
                summaryProvider: provider,
                summaryModel: model,
                summaryApiMode: apiMode,
                summaryEveryTurns: everyTurns,
            })
        }
    })
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

groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/summary', async (ctx) => {
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
    if (!canManageRoom(storage, roomId, ctx.state?.user) && !canReadRoom(storage, roomId, ctx.state?.user)) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }

    const summary = chatServer.getRoomSummaryService().getState(roomId)
    const anchorMessage = summary.summaryThroughMessageId
        ? storage.getMessage(summary.summaryThroughMessageId)
        : null
    ctx.body = {
        summary,
        anchor: anchorMessage ? {
            id: anchorMessage.id,
            timestamp: anchorMessage.timestamp,
            senderName: anchorMessage.senderName,
            role: anchorMessage.role,
            content: contentPreview(anchorMessage.content),
        } : null,
    }
})

groupChatRoutes.put('/api/hermes/group-chat/rooms/:roomId/summary', async (ctx) => {
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
    const text = (ctx.request.body as { summary?: string })?.summary
    if (typeof text !== 'string' || text.length > 200_000) {
        ctx.status = 400
        ctx.body = { error: 'summary must be a string no longer than 200000 characters' }
        return
    }
    const summary = await chatServer.getRoomSummaryService().updateSummaryText(roomId, text.trim())
    ctx.body = { summary }
})
