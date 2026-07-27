import Router from '@koa/router'
import { randomBytes, randomUUID } from 'node:crypto'
import type { Context } from 'koa'
import type { GroupChatServer } from '../../services/hermes/group-chat'
import {
    loadActiveAuthenticatedUser,
    type AuthenticatedUser,
} from '../../middleware/user-auth'
import { isReservedMentionName } from '../../services/hermes/group-chat/mention-routing'
import { assertAllowedWorkspaceFolder } from '../../services/hermes/workspace-path'
import {
    evaluateGroupChatRequestAccess,
} from '../../services/hermes/group-chat/access'
import { setGroupChatRuntimeServer } from '../../services/hermes/group-chat/runtime'
import * as ctrl from '../../controllers/hermes/group-chat-workspace'

export const groupChatRoutes = new Router()

type GroupChatStorage = ReturnType<GroupChatServer['getStorage']>
type GroupChatRoom = NonNullable<ReturnType<GroupChatStorage['getRoom']>>
type GroupChatRouteState = {
    user?: AuthenticatedUser
    groupChatLocalSubjectId?: string
}
type GroupChatRouteContext = Context & { state: GroupChatRouteState }
type RoomPermissions = { canManage: boolean; canApprove: boolean; canLeave: boolean }
type SerializedGroupChatRoom = Omit<
    GroupChatRoom,
    'ownerAuthUserId' | 'inviteGeneration' | 'sessionSeed'
> & RoomPermissions
type RoomAccess = RoomPermissions & { room: GroupChatRoom; canDiscover: boolean; canRead: boolean }

let chatServer: GroupChatServer | null = null

export function setGroupChatServer(server: GroupChatServer | null) {
    chatServer = server
    setGroupChatRuntimeServer(server)
}

export function getGroupChatServer(): GroupChatServer | null {
    return chatServer
}

function generateId(): string {
    return randomUUID()
}

function generateInviteCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    return Array.from(randomBytes(16), value => chars[value & 31]).join('')
}

function isBlankInviteCode(value: string | undefined): boolean {
    return value === undefined || !value.trim()
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

function serializeRoom(
    room: GroupChatRoom | null | undefined,
    permissions: RoomPermissions,
): SerializedGroupChatRoom | null | undefined {
    if (!room) return room
    const {
        ownerAuthUserId: _ownerAuthUserId,
        inviteGeneration: _inviteGeneration,
        sessionSeed: _sessionSeed,
        ...rest
    } = room
    const serialized = {
        ...rest,
        canManage: permissions.canManage,
        canApprove: permissions.canApprove,
        canLeave: permissions.canLeave,
    }
    if (Object.prototype.hasOwnProperty.call(room, 'inviteCode')) {
        serialized.inviteCode = permissions.canManage ? room.inviteCode ?? null : null
    }
    if (Object.prototype.hasOwnProperty.call(room, 'workspace')) {
        serialized.workspace = permissions.canManage ? String(room.workspace || '') : ''
    }
    return serialized
}

function respondRoomNotFound(ctx: GroupChatRouteContext): void {
    ctx.status = 404
    ctx.body = { error: 'Room not found' }
}

function refreshGroupChatRouteState(state: GroupChatRouteState): GroupChatRouteState {
    if (!state.user) return state
    const userId = Number(state.user.id)
    const user = Number.isInteger(userId) && userId > 0
        ? loadActiveAuthenticatedUser(userId)
        : null
    if (!user) {
        delete state.user
        delete state.groupChatLocalSubjectId
        return state
    }
    state.user = user
    delete state.groupChatLocalSubjectId
    return state
}

function roomAccess(
    storage: GroupChatStorage,
    roomId: string,
    state: GroupChatRouteState,
    knownRoom?: GroupChatRoom,
): RoomAccess | null {
    const room = knownRoom || storage.getRoom(roomId)
    if (!room) return null
    const currentState = refreshGroupChatRouteState(state)
    const decision = evaluateGroupChatRequestAccess(
        storage,
        room.id,
        currentState.user,
        currentState.groupChatLocalSubjectId,
    )
    const authUserId = Number(currentState.user?.id ?? 0)
    const isAuthenticatedOwner = Number.isInteger(authUserId)
        && authUserId > 0
        && Number(room.ownerAuthUserId ?? 0) === authUserId
    return {
        room,
        canDiscover: Boolean(decision?.canDiscover),
        canManage: Boolean(decision?.canManage),
        canRead: Boolean(decision?.canRead),
        canApprove: Boolean(decision?.canRespondApproval),
        canLeave: decision?.actorType === 'authenticated_human' || isAuthenticatedOwner,
    }
}

function requireReadableRoom(
    ctx: GroupChatRouteContext,
    storage: GroupChatStorage,
    roomId: string,
): RoomAccess | null {
    const access = roomAccess(storage, roomId, ctx.state)
    if (!access?.canRead) {
        respondRoomNotFound(ctx)
        return null
    }
    return access
}

function requireManageRoom(
    ctx: GroupChatRouteContext,
    storage: GroupChatStorage,
    roomId: string,
): RoomAccess | null {
    const access = roomAccess(storage, roomId, ctx.state)
    if (!access?.canRead) {
        respondRoomNotFound(ctx)
        return null
    }
    if (!access.canManage) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return null
    }
    return access
}

const REQUEST_AUTHORIZATION_CHANGED = 'group_chat_request_authorization_changed'

function assertCurrentRoomManager(
    ctx: GroupChatRouteContext,
    storage: GroupChatStorage,
    roomId: string,
): RoomAccess {
    const access = requireManageRoom(ctx, storage, roomId)
    if (access) return access
    throw Object.assign(new Error('Group chat request authorization changed'), {
        code: REQUEST_AUTHORIZATION_CHANGED,
        status: ctx.status,
    })
}

function authenticatedRequesterId(state: GroupChatRouteState): number | null {
    const userId = Number(state.user?.id)
    return Number.isInteger(userId) && userId > 0 ? userId : null
}

function requireCurrentAgentProfile(
    ctx: GroupChatRouteContext,
    authenticatedUserId: number | null,
    profile: string,
): boolean {
    if (authenticatedUserId === null) return true
    const user = loadActiveAuthenticatedUser(authenticatedUserId)
    if (!user) {
        delete ctx.state.user
        delete ctx.state.groupChatLocalSubjectId
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return false
    }
    ctx.state.user = user
    delete ctx.state.groupChatLocalSubjectId
    if (user.role === 'super_admin' || user.profiles?.includes(profile)) return true
    ctx.status = 403
    ctx.body = { error: `Profile "${profile}" is not available for this user` }
    return false
}

function assertCurrentAgentProfile(
    ctx: GroupChatRouteContext,
    authenticatedUserId: number | null,
    profile: string,
): void {
    if (requireCurrentAgentProfile(ctx, authenticatedUserId, profile)) return
    throw Object.assign(new Error('Group chat request authorization changed'), {
        code: REQUEST_AUTHORIZATION_CHANGED,
        status: ctx.status,
    })
}

function isRequestAuthorizationChanged(error: unknown): boolean {
    return Boolean(
        error
        && typeof error === 'object'
        && 'code' in error
        && error.code === REQUEST_AUTHORIZATION_CHANGED,
    )
}

type GroupChatRoomOwner = ({
    kind: 'authenticated'
    authUserId: number
    username: string
    description?: string
    avatar?: string
} | {
    kind: 'local'
    localSubjectId: string
    username: string
    description?: string
    avatar?: string
})

function roomOwnerFromState(state: GroupChatRouteState, memberName?: string, memberDescription?: string): GroupChatRoomOwner | null {
    const currentState = refreshGroupChatRouteState(state)
    const requestedName = memberName?.trim()
    const requestedDescription = memberDescription?.trim()
    const user = currentState.user
    if (typeof user?.id === 'number' && user.id > 0) {
        return {
            kind: 'authenticated',
            authUserId: user.id,
            username: requestedName || String(user.username || `User-${user.id}`),
            description: requestedDescription || undefined,
        }
    }
    if (typeof currentState.groupChatLocalSubjectId === 'string' && currentState.groupChatLocalSubjectId) {
        return {
            kind: 'local',
            localSubjectId: currentState.groupChatLocalSubjectId,
            username: requestedName || 'Local user',
            description: requestedDescription || undefined,
        }
    }
    return null
}

function visibleRoomsForRequest(
    storage: GroupChatStorage,
    state: GroupChatRouteState,
): SerializedGroupChatRoom[] {
    const visible: SerializedGroupChatRoom[] = []
    for (const room of storage.getAllRooms()) {
        const access = roomAccess(storage, room.id, state, room)
        if (!access?.canDiscover) continue
        const serializedRoom = serializeRoom(room, access)
        if (serializedRoom) visible.push(serializedRoom)
    }
    return visible
}

type PersistedRoomAgent = ReturnType<GroupChatStorage['addRoomAgent']>

async function connectAndPersistRoomAgent(
    server: GroupChatServer,
    roomId: string,
    input: AgentInput,
    assertAuthorized: () => void,
    agentId = generateId(),
): Promise<PersistedRoomAgent> {
    const profile = input.profile
    const name = input.name || profile
    const description = input.description || ''
    const invited = input.invited ? 1 : 0
    assertAuthorized()
    const client = await server.agentClients.createAgent({
        agentId,
        profile,
        name,
        description,
        invited,
        backgroundDelegationEnabled: false,
    })

    const storage = server.getStorage()
    let persisted: PersistedRoomAgent | null = null
    try {
        assertAuthorized()
        persisted = storage.addRoomAgent(roomId, agentId, profile, name, description, invited)
        await server.agentClients.addAgentToRoom(roomId, client)
        assertAuthorized()
        return persisted
    } catch (err) {
        if (persisted) {
            storage.removeAgentActorWithRetention(roomId, persisted.id || agentId)
        }
        client.disconnect?.()
        server.agentClients.removeAgentFromRoom(roomId, client.agentId)
        throw err
    }
}

async function rollbackNewlyProvisionedRoom(
    server: GroupChatServer,
    roomId: string,
): Promise<void> {
    const storage = server.getStorage()
    const removals: Array<NonNullable<ReturnType<GroupChatStorage['removeAgentActorWithRetention']>>> = []
    for (const agent of storage.getRoomAgents(roomId)) {
        const removal = storage.removeAgentActorWithRetention(roomId, agent.id || agent.agentId)
        if (removal) removals.push(removal)
    }
    server.agentClients.disconnectRoom(roomId)
    storage.deleteRoom(roomId)
    for (const removal of removals) {
        try {
            await server.cleanupRemovedAgentRuntime(removal)
        } catch (err: unknown) {
            const reason = err instanceof Error ? err.message : String(err || '')
            console.error(`[GroupChat] Failed runtime rollback for agent ${removal.agent.agentId} in room ${roomId}: ${sanitizeAgentConnectReason(reason)}`)
        }
    }
}

groupChatRoutes.use(async (ctx, next) => {
    const state = ctx.state as GroupChatRouteState
    delete state.groupChatLocalSubjectId
    if (!state.user && chatServer) {
        const localCredential = typeof ctx.get === 'function'
            ? ctx.get('x-group-chat-local-credential')
            : ''
        const localSubjectId = await chatServer.resolveLocalCredentialSubject(localCredential)
        if (localSubjectId) state.groupChatLocalSubjectId = localSubjectId
    }
    await next()
})

// Create room
groupChatRoutes.post('/api/hermes/group-chat/rooms', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const authenticatedUserId = authenticatedRequesterId(ctx.state)
    const { name, inviteCode, agents, compression, workspace, memberName, memberDescription } = ctx.request.body as {
        name?: string
        inviteCode?: string
        agents?: { profile: string; name?: string; description?: string; invited?: boolean }[]
        compression?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }
        workspace?: string
        memberName?: string
        memberDescription?: string
    }
    if (typeof name !== 'string' || !name.trim()) {
        ctx.status = 400
        ctx.body = { error: 'name is required' }
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
    const owner = roomOwnerFromState(ctx.state, memberName, memberDescription)
    if (!owner) {
        ctx.status = 401
        ctx.body = { error: 'Group chat identity required' }
        return
    }
    if (inviteCode !== undefined && typeof inviteCode !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'inviteCode must be a string' }
        return
    }
    const resolvedInviteCode = isBlankInviteCode(inviteCode)
        ? generateInviteCode()
        : inviteCode
    if (agents !== undefined && !Array.isArray(agents)) {
        ctx.status = 400
        ctx.body = { error: 'agents must be an array' }
        return
    }
    const normalizedAgents: AgentInput[] = []
    for (const agent of agents || []) {
        if (!agent || typeof agent.profile !== 'string' || !agent.profile.trim()) {
            ctx.status = 400
            ctx.body = { error: 'agent profile is required' }
            return
        }
        if (agent.name !== undefined && typeof agent.name !== 'string') {
            ctx.status = 400
            ctx.body = { error: 'agent name must be a string' }
            return
        }
        if (agent.description !== undefined && typeof agent.description !== 'string') {
            ctx.status = 400
            ctx.body = { error: 'agent description must be a string' }
            return
        }
        if (agent.invited !== undefined && typeof agent.invited !== 'boolean') {
            ctx.status = 400
            ctx.body = { error: 'agent invited must be a boolean' }
            return
        }
        normalizedAgents.push({
            profile: agent.profile.trim(),
            name: agent.name,
            description: agent.description,
            invited: agent.invited,
        })
    }
    const reservedAgent = normalizedAgents.find(agent => isReservedMentionName(agent.name || agent.profile))
    if (reservedAgent) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }
    for (const agent of normalizedAgents) {
        if (!requireCurrentAgentProfile(ctx, authenticatedUserId, agent.profile)) return
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
            } catch (err: unknown) {
                const status = typeof err === 'object' && err !== null && 'status' in err
                    ? Number(err.status)
                    : 403
                ctx.status = Number.isFinite(status) ? status : 403
                ctx.body = { error: err instanceof Error ? err.message : 'Workspace folder is not allowed' }
                return
            }
        }
    }
    const refreshedOwner = roomOwnerFromState(ctx.state, memberName, memberDescription)
    if (!refreshedOwner) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    for (const agent of normalizedAgents) {
        if (!requireCurrentAgentProfile(ctx, authenticatedUserId, agent.profile)) return
    }
    const compressionConfig = compression ? {
        triggerTokens: compression.triggerTokens,
        maxHistoryTokens: compression.maxHistoryTokens,
        tailMessageCount: compression.tailMessageCount,
        workspace: normalizedWorkspace,
    } : { workspace: normalizedWorkspace }
    if (typeof storage.createRoomWithOwner === 'function') {
        storage.createRoomWithOwner({
            id: roomId,
            name,
            inviteCode: resolvedInviteCode,
            config: compressionConfig,
            owner: refreshedOwner,
        })
    } else {
        storage.saveRoom(roomId, name, resolvedInviteCode, compressionConfig)
        if (refreshedOwner.kind === 'authenticated') {
            storage.setRoomOwnerAuthUserId?.(roomId, refreshedOwner.authUserId)
            storage.addRoomMember?.(
                roomId,
                `auth:${refreshedOwner.authUserId}`,
                refreshedOwner.username,
                refreshedOwner.description || '',
                refreshedOwner.avatar || '',
                refreshedOwner.authUserId,
            )
        } else {
            storage.addRoomMember?.(
                roomId,
                refreshedOwner.localSubjectId,
                refreshedOwner.username,
                refreshedOwner.description || '',
                refreshedOwner.avatar || '',
            )
        }
    }

    const addedAgents = []
    const agentResults = []
    for (const agentInput of normalizedAgents) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                profile: agentInput.profile,
                name: agentInput.name || agentInput.profile,
                description: agentInput.description || '',
                invited: agentInput.invited,
            }, () => {
                assertCurrentRoomManager(ctx, storage, roomId)
                for (const requestedAgent of normalizedAgents) {
                    assertCurrentAgentProfile(ctx, authenticatedUserId, requestedAgent.profile)
                }
            })
            addedAgents.push(agent)
            agentResults.push({ profile: agentInput.profile, ok: true, agent })
        } catch (err: unknown) {
            if (isRequestAuthorizationChanged(err)) {
                await rollbackNewlyProvisionedRoom(chatServer, roomId)
                return
            }
            const reason = err instanceof Error ? err.message : String(err || '')
            console.error(`[GroupChat] Failed to connect agent ${agentInput.profile} to room ${roomId}: ${sanitizeAgentConnectReason(reason)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(agentInput.profile, err) })
        }
    }

    let finalAccess: RoomAccess
    try {
        finalAccess = assertCurrentRoomManager(ctx, storage, roomId)
        for (const requestedAgent of normalizedAgents) {
            assertCurrentAgentProfile(ctx, authenticatedUserId, requestedAgent.profile)
        }
    } catch (err: unknown) {
        if (!isRequestAuthorizationChanged(err)) throw err
        await rollbackNewlyProvisionedRoom(chatServer, roomId)
        return
    }
    const room = storage.getRoom(roomId)
    ctx.body = {
        room: serializeRoom(room, finalAccess),
        agents: addedAgents,
        agentResults,
    }
})

// Clone room roles/config without copying the conversation context.
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/clone', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const authenticatedUserId = authenticatedRequesterId(ctx.state)
    const storage = chatServer.getStorage()
    const access = requireManageRoom(ctx, storage, ctx.params.roomId)
    if (!access) {
        return
    }
    const sourceRoom = access.room

    const owner = roomOwnerFromState(ctx.state)
    if (!owner) {
        ctx.status = 403
        ctx.body = { error: 'Access denied' }
        return
    }
    const sourceAgents = storage.getRoomAgents(sourceRoom.id)
    for (const sourceAgent of sourceAgents) {
        if (!requireCurrentAgentProfile(ctx, authenticatedUserId, sourceAgent.profile)) return
    }
    const { name, inviteCode } = ctx.request.body as { name?: string; inviteCode?: string }
    const roomId = generateId()
    if (inviteCode !== undefined && typeof inviteCode !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'inviteCode must be a string' }
        return
    }
    const code = isBlankInviteCode(inviteCode) ? generateInviteCode() : inviteCode
    const cloneConfig = {
        triggerTokens: sourceRoom.triggerTokens,
        maxHistoryTokens: sourceRoom.maxHistoryTokens,
        tailMessageCount: sourceRoom.tailMessageCount,
        workspace: sourceRoom.workspace || '',
    }
    storage.createRoomWithOwner({
        id: roomId,
        name: name?.trim() || `${sourceRoom.name} Copy`,
        inviteCode: code,
        config: cloneConfig,
        owner,
    })

    const addedAgents = []
    const agentResults = []
    for (const sourceAgent of sourceAgents) {
        try {
            const agent = await connectAndPersistRoomAgent(chatServer, roomId, {
                profile: sourceAgent.profile,
                name: sourceAgent.name,
                description: sourceAgent.description,
                invited: sourceAgent.invited,
            }, () => {
                assertCurrentRoomManager(ctx, storage, sourceRoom.id)
                assertCurrentRoomManager(ctx, storage, roomId)
                for (const requestedAgent of sourceAgents) {
                    assertCurrentAgentProfile(ctx, authenticatedUserId, requestedAgent.profile)
                }
            })
            addedAgents.push(agent)
            agentResults.push({ profile: sourceAgent.profile, ok: true, agent })
        } catch (err: unknown) {
            if (isRequestAuthorizationChanged(err)) {
                await rollbackNewlyProvisionedRoom(chatServer, roomId)
                return
            }
            const reason = err instanceof Error ? err.message : String(err || '')
            console.error(`[GroupChat] Failed to connect cloned agent ${sourceAgent.profile} to room ${roomId}: ${sanitizeAgentConnectReason(reason)}`)
            agentResults.push({ ok: false, ...agentConnectFailureBody(sourceAgent.profile, err) })
        }
    }

    let finalTargetAccess: RoomAccess
    try {
        assertCurrentRoomManager(ctx, storage, sourceRoom.id)
        finalTargetAccess = assertCurrentRoomManager(ctx, storage, roomId)
        for (const requestedAgent of sourceAgents) {
            assertCurrentAgentProfile(ctx, authenticatedUserId, requestedAgent.profile)
        }
    } catch (err: unknown) {
        if (!isRequestAuthorizationChanged(err)) throw err
        await rollbackNewlyProvisionedRoom(chatServer, roomId)
        return
    }
    const room = storage.getRoom(roomId)
    ctx.body = {
        room: serializeRoom(room, finalTargetAccess),
        agents: addedAgents,
        agentResults,
    }
})

// Get room detail and messages
groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const storage = chatServer.getStorage()
    const access = requireReadableRoom(ctx, storage, ctx.params.roomId)
    if (!access) {
        return
    }
    const { room } = access

    const offset = ctx.query.offset ? Math.max(0, parseInt(ctx.query.offset as string, 10) || 0) : 0
    const limit = ctx.query.limit ? Math.max(1, parseInt(ctx.query.limit as string, 10) || 150) : 150
    const messages = storage.getRecentMessagesForUI(ctx.params.roomId, limit, offset)
    const total = storage.getMessageCount(ctx.params.roomId)
    const agents = storage.getRoomAgents(ctx.params.roomId)
    const members = storage.getRoomMembers(ctx.params.roomId)
    ctx.body = { room: serializeRoom(room, access), messages, agents, members, total, offset, limit, hasMore: offset + messages.length < total }
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

    const storage = chatServer.getStorage()
    const rooms = visibleRoomsForRequest(storage, ctx.state)
    ctx.body = { rooms }
})

function roomWithoutWorkspace(room: GroupChatRoom | null | undefined) {
    return serializeRoom(room, { canManage: false, canApprove: false, canLeave: false })
}

// Get room by invite code
groupChatRoutes.get('/api/hermes/group-chat/rooms/join/:code', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const limiter = chatServer.getInviteAttemptLimiter()
    const localCredential = typeof ctx.get === 'function'
        ? ctx.get('x-group-chat-local-credential')
        : ''
    const attemptKey = await chatServer.resolveInviteAttemptSubjectKey(
        ctx.state?.user?.id,
        ctx.ip,
        localCredential,
    )
    if (!limiter.isAllowed(attemptKey)) {
        respondRoomNotFound(ctx)
        return
    }

    const room = chatServer.getStorage().getRoomByInviteCode(ctx.params.code)
    if (!room) {
        limiter.recordFailure(attemptKey)
        respondRoomNotFound(ctx)
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
    if (!requireManageRoom(ctx, storage, ctx.params.roomId)) {
        return
    }

    const { inviteCode } = ctx.request.body as { inviteCode?: string }
    if (typeof inviteCode !== 'string' || !inviteCode.trim()) {
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
    if (typeof profile !== 'string' || !profile.trim()) {
        ctx.status = 400
        ctx.body = { error: 'profile is required' }
        return
    }
    const normalizedProfile = profile.trim()
    if (name !== undefined && typeof name !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'name must be a string' }
        return
    }
    if (description !== undefined && typeof description !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'description must be a string' }
        return
    }
    if (invited !== undefined && typeof invited !== 'boolean') {
        ctx.status = 400
        ctx.body = { error: 'invited must be a boolean' }
        return
    }
    if (isReservedMentionName(name || normalizedProfile)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }

    const authenticatedUserId = authenticatedRequesterId(ctx.state)
    const storage = chatServer.getStorage()
    if (!requireManageRoom(ctx, storage, ctx.params.roomId)) {
        return
    }
    if (!requireCurrentAgentProfile(ctx, authenticatedUserId, normalizedProfile)) return

    // Prevent duplicate agent in same room
    const existing = storage.getRoomAgents(ctx.params.roomId)
    if (existing.find(agent => agent.profile === normalizedProfile)) {
        ctx.status = 409
        ctx.body = { error: 'Agent already in room' }
        return
    }

    try {
        const agent = await connectAndPersistRoomAgent(chatServer, ctx.params.roomId, {
            profile: normalizedProfile,
            name: name || normalizedProfile,
            description: description || '',
            invited,
        }, () => {
            assertCurrentRoomManager(ctx, storage, ctx.params.roomId)
            assertCurrentAgentProfile(ctx, authenticatedUserId, normalizedProfile)
        })
        ctx.body = { agent }
    } catch (err: unknown) {
        if (isRequestAuthorizationChanged(err)) return
        const reason = err instanceof Error ? err.message : String(err || '')
        console.error(`[GroupChat] Failed to connect agent ${normalizedProfile} to room ${ctx.params.roomId}: ${sanitizeAgentConnectReason(reason)}`)
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
    if (!requireReadableRoom(ctx, storage, ctx.params.roomId)) {
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
    if (!requireManageRoom(ctx, storage, roomId)) {
        return
    }
    const agent = storage.getRoomAgent(roomId, requestedAgentId)
    if (!agent) {
        ctx.body = {
            success: true,
            agents: storage.getRoomAgents(roomId),
            members: storage.getRoomMembers(roomId),
        }
        return
    }

    const removal = storage.removeAgentActorWithRetention(roomId, requestedAgentId)
    try {
        await chatServer.cleanupRemovedAgentRuntime(removal)
    } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err || '')
        console.error(`[GroupChat] Failed runtime cleanup for agent ${agent.agentId} in room ${roomId}: ${sanitizeAgentConnectReason(reason)}`)
    }
    if (!requireManageRoom(ctx, storage, roomId)) return
    ctx.body = {
        success: true,
        agents: storage.getRoomAgents(roomId),
        members: storage.getRoomMembers(roomId),
    }
})

// Leave current room membership without deleting the room.
groupChatRoutes.delete('/api/hermes/group-chat/rooms/:roomId/members/me', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const roomId = ctx.params.roomId
    const storage = chatServer.getStorage()
    if (!requireReadableRoom(ctx, storage, roomId)) {
        return
    }
    const authUserId = authenticatedRequesterId(ctx.state)
    if (authUserId === null) {
        ctx.status = 401
        ctx.body = { error: 'Authenticated user required' }
        return
    }
    const existingMember = storage.getMemberByAuthUserId(roomId, authUserId)
    const room = storage.getRoom(roomId)
    const isOwner = Number(room?.ownerAuthUserId ?? 0) === authUserId
    if (!existingMember && !isOwner) {
        ctx.body = { success: true, left: false }
        return
    }
    storage.deactivateAuthenticatedHumanActorWithRetention(roomId, authUserId)
    storage.clearRoomOwnerAuthUserId(roomId, authUserId)
    chatServer.leaveAuthenticatedUserRoom(roomId, authUserId)
    ctx.body = { success: true, left: true }
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
    if (!requireManageRoom(ctx, storage, roomId)) {
        return
    }
    // Interrupt active bridge runs, then evict sockets and disconnect agents before deleting persisted data.
    try {
        await chatServer.deleteRoomRuntimeState(roomId, () => {
            assertCurrentRoomManager(ctx, storage, roomId)
        })
    } catch (err: any) {
        if (isRequestAuthorizationChanged(err)) return
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    if (!requireManageRoom(ctx, storage, roomId)) return
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
    const access = requireManageRoom(ctx, storage, roomId)
    if (!access) {
        return
    }
    try {
        await chatServer.clearRoomRuntimeState(roomId, () => {
            assertCurrentRoomManager(ctx, storage, roomId)
        })
    } catch (err: any) {
        if (isRequestAuthorizationChanged(err)) return
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    const finalAccess = requireManageRoom(ctx, storage, roomId)
    if (!finalAccess) return
    storage.clearRoomContext(roomId)
    ctx.body = { success: true, room: serializeRoom(storage.getRoom(roomId), finalAccess) }
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
    const access = requireManageRoom(ctx, storage, roomId)
    if (!access) {
        return
    }
    storage.updateRoomConfig(roomId, { triggerTokens, maxHistoryTokens, tailMessageCount })
    ctx.body = { room: serializeRoom(storage.getRoom(roomId), access) }
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
    const access = requireManageRoom(ctx, storage, roomId)
    if (!access) {
        return
    }

    const { workspace } = ctx.request.body as { workspace: string }
    if (typeof workspace !== 'string') {
        ctx.status = 400
        ctx.body = { error: 'workspace must be a string' }
        return
    }

    let releaseSessionFence: (() => void) | null = null
    try {
        const rawWorkspace = workspace.trim()
        const normalized = rawWorkspace ? (await assertAllowedWorkspaceFolder(rawWorkspace)).fullPath : ''
        let currentAccess = requireManageRoom(ctx, storage, roomId)
        if (!currentAccess) return
        if (normalized !== String(currentAccess.room.workspace || '')) {
            releaseSessionFence = chatServer.fenceCurrentRoomAgentSessions(roomId)
            try {
                await chatServer.agentClients.interruptRoom(roomId)
            } catch (err) {
                releaseSessionFence()
                releaseSessionFence = null
                throw err
            }
            currentAccess = requireManageRoom(ctx, storage, roomId)
            if (!currentAccess) {
                releaseSessionFence()
                return
            }
        }
        const updatedRoom = storage.updateRoomWorkspace(roomId, normalized)
        releaseSessionFence = null
        ctx.body = { room: serializeRoom(updatedRoom, currentAccess) }
    } catch (err: unknown) {
        releaseSessionFence?.()
        const status = typeof err === 'object' && err !== null && 'status' in err
            ? Number(err.status)
            : 403
        ctx.status = Number.isFinite(status) ? status : 403
        ctx.body = { error: err instanceof Error ? err.message : 'Workspace folder is not allowed' }
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
    if (!requireManageRoom(ctx, storage, roomId)) {
        return
    }

    const engine = chatServer.getContextEngine()
    if (!engine) {
        ctx.status = 503
        ctx.body = { error: 'Context engine not available' }
        return
    }

    const summarySessionContext = chatServer.agentClients.getSummarySessionContext(roomId)
    if (!summarySessionContext) {
        ctx.status = 409
        ctx.body = { error: 'No active room agent is authorized to compress context' }
        return
    }

    const requestAuthorizationGuard = () => Boolean(roomAccess(storage, roomId, ctx.state)?.canManage)
    const sessionRegistrar = () => {
        const session = summarySessionContext.sessionRegistrar()
        return {
            ...session,
            authorizationGuard: () => requestAuthorizationGuard() && session.authorizationGuard(),
        }
    }

    try {
        const result = await engine.forceCompress(
            roomId,
            summarySessionContext.profile,
            sessionRegistrar,
        )
        if (!requireManageRoom(ctx, storage, roomId)) return
        ctx.body = { success: true, summary: result }
    } catch (err: unknown) {
        if (!requireManageRoom(ctx, storage, roomId)) return
        ctx.status = 500
        ctx.body = { error: err instanceof Error ? err.message : 'Compression failed' }
    }
})
