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
import { assertScopedCodingAgentProviderAllowed } from '../../services/coding-agent-provider-policy'
import {
    evaluateGroupChatRequestAccess,
} from '../../services/hermes/group-chat/access'
import { setGroupChatRuntimeServer } from '../../services/hermes/group-chat/runtime'
import { serializeRoomAgent } from '../../services/hermes/group-chat/participant-serialization'
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

type ParticipantRuntime = 'hermes' | 'coding_agent'
type ParticipantCodingAgentId = '' | 'claude-code' | 'codex'
type AgentInput = {
    profile: string
    name?: string
    description?: string
    invited?: boolean | number
    runtime?: ParticipantRuntime
    codingAgentId?: ParticipantCodingAgentId
    mode?: 'scoped' | 'global'
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    avatar?: unknown
}

const PARTICIPANT_REASONING_EFFORTS = new Set(['', 'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const PARTICIPANT_API_MODES = new Set(['', 'chat_completions', 'codex_responses', 'anthropic_messages', 'bedrock_converse', 'codex_app_server'])
const PARTICIPANT_AVATAR_ASSETS = new Set([
    '/coding-agents/hermes.png',
    '/coding-agents/codex-openai.png',
    '/coding-agents/claude-code.svg',
])
const MAX_PARTICIPANT_AVATAR_LENGTH = 1_500_000

function defaultParticipantAvatar(runtime: ParticipantRuntime, codingAgentId: ParticipantCodingAgentId): string {
    const assetUrl = runtime === 'coding_agent'
        ? (codingAgentId === 'claude-code' ? '/coding-agents/claude-code.svg' : '/coding-agents/codex-openai.png')
        : '/coding-agents/hermes.png'
    return JSON.stringify({ type: 'asset', assetUrl })
}

function normalizeParticipantAvatar(value: unknown, runtime: ParticipantRuntime, codingAgentId: ParticipantCodingAgentId): string {
    if (value == null || value === '') return defaultParticipantAvatar(runtime, codingAgentId)
    let avatar: any = value
    if (typeof avatar === 'string') {
        try { avatar = JSON.parse(avatar) } catch { throw Object.assign(new Error('avatar is invalid'), { status: 400 }) }
    }
    if (!avatar || typeof avatar !== 'object') throw Object.assign(new Error('avatar is invalid'), { status: 400 })
    if (avatar.type === 'asset' && PARTICIPANT_AVATAR_ASSETS.has(String(avatar.assetUrl || ''))) {
        return JSON.stringify({ type: 'asset', assetUrl: String(avatar.assetUrl) })
    }
    if (avatar.type === 'generated') {
        const seed = String(avatar.seed || '').trim().slice(0, 200)
        if (!seed) throw Object.assign(new Error('generated avatar seed is required'), { status: 400 })
        return JSON.stringify({ type: 'generated', seed })
    }
    if (avatar.type === 'image') {
        const dataUrl = String(avatar.dataUrl || '')
        if (!/^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(dataUrl) || dataUrl.length > MAX_PARTICIPANT_AVATAR_LENGTH) {
            throw Object.assign(new Error('image avatar is invalid or too large'), { status: 400 })
        }
        return JSON.stringify({ type: 'image', dataUrl })
    }
    throw Object.assign(new Error('avatar is invalid'), { status: 400 })
}

function normalizeAgentInput(input: AgentInput): AgentInput {
    const runtime = input.runtime || 'hermes'
    if (runtime !== 'hermes' && runtime !== 'coding_agent') throw Object.assign(new Error('runtime must be hermes or coding_agent'), { status: 400 })
    const codingAgentId = input.codingAgentId || ''
    if (runtime === 'coding_agent' && !codingAgentId) throw Object.assign(new Error('codingAgentId is required for coding_agent participants'), { status: 400 })
    if (codingAgentId && codingAgentId !== 'claude-code' && codingAgentId !== 'codex') throw Object.assign(new Error('codingAgentId must be claude-code or codex'), { status: 400 })
    if (runtime === 'hermes' && codingAgentId) throw Object.assign(new Error('codingAgentId is only valid for coding_agent participants'), { status: 400 })
    const mode = input.mode || 'scoped'
    if (mode !== 'scoped' && mode !== 'global') throw Object.assign(new Error('mode must be scoped or global'), { status: 400 })
    if (runtime === 'coding_agent' && mode !== 'scoped') throw Object.assign(new Error('Group Chat coding-agent participants require scoped mode'), { status: 400 })
    const apiMode = String(input.apiMode || '').trim()
    if (!PARTICIPANT_API_MODES.has(apiMode)) throw Object.assign(new Error('apiMode is invalid'), { status: 400 })
    if (runtime === 'coding_agent' && apiMode && !['chat_completions', 'codex_responses', 'anthropic_messages'].includes(apiMode)) {
        throw Object.assign(new Error('apiMode is not supported for coding_agent participants'), { status: 400 })
    }
    const provider = String(input.provider || '').trim()
    const model = String(input.model || '').trim()
    if (runtime === 'coding_agent' && (!provider || !model || !apiMode)) throw Object.assign(new Error('provider, model, and apiMode are required for coding_agent participants'), { status: 400 })
    if (runtime === 'coding_agent') assertScopedCodingAgentProviderAllowed(mode, provider)
    const requestedReasoningEffort = String(input.reasoningEffort || '').trim()
    const reasoningEffort = requestedReasoningEffort === 'default' ? '' : requestedReasoningEffort
    if (!PARTICIPANT_REASONING_EFFORTS.has(reasoningEffort)) throw Object.assign(new Error('reasoningEffort is invalid'), { status: 400 })
    return {
        ...input,
        profile: String(input.profile || '').trim(), name: String(input.name || '').trim(),
        description: String(input.description || '').trim(), runtime, codingAgentId, mode,
        provider, model, apiMode, reasoningEffort,
        avatar: normalizeParticipantAvatar(input.avatar, runtime, codingAgentId),
    }
}

function sanitizeAgentConnectReason(reason?: string): string {
    return (reason || 'agent runtime connection failed')
        .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
        .replace(/(api[_-]?key|token|secret|password)=([^\s]+)/gi, '$1=[REDACTED]')
        .split('\n')[0]
        .slice(0, 240)
}

function keepRuntimeMutationAlive(
    storage: GroupChatStorage,
    fence: { token: string; roomId: string; actorId: string },
): {
    assertCurrent: () => void
    stop: () => void
} {
    let failure: Error | null = null
    let stopped = false
    const renew = () => {
        if (stopped || failure) return
        try {
            if (!storage.renewRuntimeMutation(fence.token, fence.roomId, fence.actorId)) {
                failure = new Error('Group Chat runtime mutation fence expired or changed')
            }
        } catch (err) {
            failure = err instanceof Error ? err : new Error(String(err || 'Runtime mutation fence renewal failed'))
        }
    }
    const timer = setInterval(renew, 60_000)
    timer.unref?.()
    return {
        assertCurrent: () => {
            if (failure) throw Object.assign(failure, { status: 409 })
        },
        stop: () => {
            if (stopped) return
            stopped = true
            clearInterval(timer)
        },
    }
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
        handoffOrder: (() => {
            try {
                const parsed = JSON.parse(String((room as any).handoffOrderJson || '[]'))
                return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : []
            } catch {
                return []
            }
        })(),
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
    const normalized = normalizeAgentInput(input)
    const profile = normalized.profile
    const name = normalized.name || profile
    const description = normalized.description || ''
    const invited = normalized.invited ? 1 : 0
    assertAuthorized()
    const client = await server.agentClients.createAgent({
        agentId,
        profile,
        name,
        description,
        invited,
        backgroundDelegationEnabled: false,
        runtime: normalized.runtime,
        codingAgentId: normalized.codingAgentId,
        sessionId: `gc_${roomId}_${agentId}_0`,
        sessionGeneration: 0,
        mode: normalized.mode,
        provider: normalized.provider,
        model: normalized.model,
        apiMode: normalized.apiMode,
        reasoningEffort: normalized.reasoningEffort,
        avatar: normalized.avatar as string,
    })

    const storage = server.getStorage()
    let persisted: PersistedRoomAgent | null = null
    try {
        assertAuthorized()
        persisted = storage.addRoomAgent(roomId, agentId, profile, name, description, invited, {
            runtime: normalized.runtime,
            codingAgentId: normalized.codingAgentId,
            sessionId: `gc_${roomId}_${agentId}_0`,
            sessionGeneration: 0,
            mode: normalized.mode,
            provider: normalized.provider,
            model: normalized.model,
            apiMode: normalized.apiMode,
            reasoningEffort: normalized.reasoningEffort,
            avatar: normalized.avatar as string,
        })
        // addRoomAgent advances Room authority and durably fences existing jobs.
        // Stop every runtime owner only after that fence has committed.
        await server.agentClients.interruptRoom(roomId)
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
        agents?: AgentInput[]
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
        try {
            normalizedAgents.push(normalizeAgentInput({ ...agent, profile: agent.profile.trim() }))
        } catch (err: any) {
            ctx.status = Number(err?.status || 400)
            ctx.body = { error: err?.message || 'Invalid participant configuration' }
            return
        }
    }
    const reservedAgent = normalizedAgents.find(agent => isReservedMentionName(agent.name || agent.profile))
    if (reservedAgent) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }
    const normalizedMentionNames = normalizedAgents.map(agent => (agent.name || agent.profile).trim().toLocaleLowerCase())
    if (new Set(normalizedMentionNames).size !== normalizedMentionNames.length) {
        ctx.status = 409
        ctx.body = { error: 'Agent display name already in room' }
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
                runtime: agentInput.runtime,
                codingAgentId: agentInput.codingAgentId,
                mode: agentInput.mode,
                provider: agentInput.provider,
                model: agentInput.model,
                apiMode: agentInput.apiMode,
                reasoningEffort: agentInput.reasoningEffort,
                avatar: agentInput.avatar,
            }, () => {
                assertCurrentRoomManager(ctx, storage, roomId)
                for (const requestedAgent of normalizedAgents) {
                    assertCurrentAgentProfile(ctx, authenticatedUserId, requestedAgent.profile)
                }
            })
            const publicAgent = serializeRoomAgent(agent)
            addedAgents.push(publicAgent)
            agentResults.push({ profile: agentInput.profile, ok: true, agent: publicAgent })
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
                runtime: sourceAgent.runtime,
                codingAgentId: sourceAgent.codingAgentId,
                mode: sourceAgent.mode,
                provider: sourceAgent.provider,
                model: sourceAgent.model,
                apiMode: sourceAgent.apiMode,
                reasoningEffort: sourceAgent.reasoningEffort,
                avatar: sourceAgent.avatar,
            }, () => {
                assertCurrentRoomManager(ctx, storage, sourceRoom.id)
                assertCurrentRoomManager(ctx, storage, roomId)
                for (const requestedAgent of sourceAgents) {
                    assertCurrentAgentProfile(ctx, authenticatedUserId, requestedAgent.profile)
                }
            })
            const publicAgent = serializeRoomAgent(agent)
            addedAgents.push(publicAgent)
            agentResults.push({ profile: sourceAgent.profile, ok: true, agent: publicAgent })
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
    const agents = storage.getRoomAgents(ctx.params.roomId).map(serializeRoomAgent)
    const members = storage.getRoomMembers(ctx.params.roomId)
    ctx.body = { room: serializeRoom(room, access), messages, agents, members, total, offset, limit, hasMore: offset + messages.length < total }
})

groupChatRoutes.get('/api/hermes/group-chat/rooms/:roomId/handoffs', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    const storage = chatServer.getStorage()
    const access = requireReadableRoom(ctx, storage, ctx.params.roomId)
    if (!access) return
    const limit = Math.max(1, Math.min(500, parseInt(String(ctx.query.limit || '100'), 10) || 100))
    const jobs = storage.listHandoffJobs(access.room.id, limit).map((job: any) => ({
        id: job.id,
        roomId: job.roomId,
        chainId: job.chainId,
        sourceMessageId: job.sourceMessageId,
        targetAgentId: job.targetAgentId,
        depth: job.depth,
        kind: job.kind,
        status: job.status,
        attemptCount: job.attemptCount,
        lastError: job.lastError ? sanitizeAgentConnectReason(job.lastError) : '',
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        completedAt: job.completedAt,
    }))
    ctx.body = { jobs }
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
    await chatServer.agentClients.interruptRoom(ctx.params.roomId)
    ctx.body = { success: true }
})

// Add agent to room
groupChatRoutes.post('/api/hermes/group-chat/rooms/:roomId/agents', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }

    const requested = ctx.request.body as Partial<AgentInput>
    const { profile, name, description, invited } = requested
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

    // A Profile may back several distinct participants. Mention/display names,
    // however, must remain unambiguous within one Room.
    const existing = storage.getRoomAgents(ctx.params.roomId)
    const requestedName = (name || normalizedProfile).trim()
    if (existing.some(agent => agent.name.trim().toLocaleLowerCase() === requestedName.toLocaleLowerCase())) {
        ctx.status = 409
        ctx.body = { error: 'Agent display name already in room' }
        return
    }

    try {
        const normalized = normalizeAgentInput({ ...requested, profile: normalizedProfile, name: requestedName, description: description || '', invited })
        const agent = await connectAndPersistRoomAgent(chatServer, ctx.params.roomId, normalized, () => {
            assertCurrentRoomManager(ctx, storage, ctx.params.roomId)
            assertCurrentAgentProfile(ctx, authenticatedUserId, normalizedProfile)
        })
        ctx.body = { agent: serializeRoomAgent(agent) }
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

    const agents = storage.getRoomAgents(ctx.params.roomId).map(serializeRoomAgent)
    ctx.body = { agents }
})

// Update next-run participant settings without rotating stable identity/session.
groupChatRoutes.patch('/api/hermes/group-chat/rooms/:roomId/agents/:agentId', async (ctx) => {
    if (!chatServer) {
        ctx.status = 503
        ctx.body = { error: 'Group chat not initialized' }
        return
    }
    const storage = chatServer.getStorage()
    const roomId = ctx.params.roomId
    if (!requireManageRoom(ctx, storage, roomId)) return
    const authenticatedUserId = authenticatedRequesterId(ctx.state)
    const existing = storage.getRoomAgent(roomId, ctx.params.agentId)
    if (!existing) {
        ctx.status = 404
        ctx.body = { error: 'Agent not found' }
        return
    }
    if (!requireCurrentAgentProfile(ctx, authenticatedUserId, existing.profile)) return
    const requested = ctx.request.body as Partial<AgentInput>
    const requestedKeys = Object.keys(requested as Record<string, unknown>)
    const configOnlyUpdate = requestedKeys.length > 0 && requestedKeys.every(key => (
        key === 'provider' || key === 'model' || key === 'apiMode' || key === 'reasoningEffort'
    ))
    const name = requested.name === undefined ? existing.name : String(requested.name || '').trim()
    if (!name) {
        ctx.status = 400
        ctx.body = { error: 'name is required' }
        return
    }
    if (isReservedMentionName(name)) {
        ctx.status = 400
        ctx.body = { error: '`all` is reserved for @all mentions' }
        return
    }
    if (storage.getRoomAgents(roomId).some(agent => (
        agent.agentId !== existing.agentId
        && agent.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
    ))) {
        ctx.status = 409
        ctx.body = { error: 'Participant name already exists in this room' }
        return
    }
    try {
        const normalized = normalizeAgentInput({
            profile: existing.profile,
            name,
            description: requested.description === undefined ? existing.description : requested.description,
            runtime: existing.runtime || 'hermes',
            codingAgentId: existing.codingAgentId || '',
            mode: requested.mode === undefined ? (existing.mode || 'scoped') : requested.mode,
            provider: requested.provider === undefined ? existing.provider : requested.provider,
            model: requested.model === undefined ? existing.model : requested.model,
            apiMode: requested.apiMode === undefined ? existing.apiMode : requested.apiMode,
            reasoningEffort: requested.reasoningEffort === undefined ? existing.reasoningEffort : requested.reasoningEffort,
            avatar: requested.avatar === undefined ? existing.avatar : requested.avatar,
        })
        const agent = configOnlyUpdate
            ? storage.updateRoomAgentRuntimeConfig(roomId, ctx.params.agentId, {
                provider: normalized.provider || '',
                model: normalized.model || '',
                apiMode: normalized.apiMode || '',
                reasoningEffort: normalized.reasoningEffort || '',
            })
            : storage.updateRoomAgent(roomId, ctx.params.agentId, {
                name: normalized.name || existing.name,
                description: normalized.description || '',
                mode: normalized.mode || 'scoped',
                provider: normalized.provider || '',
                model: normalized.model || '',
                apiMode: normalized.apiMode || '',
                reasoningEffort: normalized.reasoningEffort || '',
                avatar: normalized.avatar as string,
            })
        if (!configOnlyUpdate) {
            await chatServer.agentClients.interruptRoom(roomId)
            if (agent) chatServer.agentClients.updateAgentIdentity(roomId, agent.agentId, agent.name, agent.description)
        }
        ctx.body = { agent: serializeRoomAgent(agent) }
    } catch (err: any) {
        ctx.status = Number(err?.status || 400)
        ctx.body = { error: err?.message || 'Invalid participant configuration' }
    }
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
            agents: storage.getRoomAgents(roomId).map(serializeRoomAgent),
            members: storage.getRoomMembers(roomId),
        }
        return
    }

    const deletionGuard = storage.captureParticipantDeletionGuard(roomId, requestedAgentId)
    let fence: ReturnType<typeof storage.beginParticipantRuntimeMutation>
    try {
        fence = storage.beginParticipantRuntimeMutation(roomId, agent.agentId, 'Participant is being deleted')
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Another participant runtime mutation is already in progress' }
        return
    }
    deletionGuard.runtimeMutationToken = fence.token
    deletionGuard.runtimeMutationActorId = fence.actorId
    const fenceHeartbeat = keepRuntimeMutationAlive(storage, fence)
    const releaseAdmissionPause = chatServer.agentClients.pauseRoom(roomId)
    const targets = new Map<string, string>()
    targets.set(agent.agentId, String(agent.sessionId || '').trim())
    for (const target of fence.affectedTargets) {
        targets.set(String(target.targetAgentId || ''), String(target.targetSessionId || '').trim())
    }
    try {
        for (const [targetAgentId, targetSessionId] of targets) {
            if (!targetAgentId || !targetSessionId) {
                throw new Error('Participant runtime identity is incomplete')
            }
            await chatServer.agentClients.interruptHandoffTarget(roomId, targetAgentId, targetSessionId)
            fenceHeartbeat.assertCurrent()
        }
    } catch (err: unknown) {
        releaseAdmissionPause()
        fenceHeartbeat.stop()
        storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        const reason = err instanceof Error ? err.message : String(err || '')
        ctx.status = 409
        ctx.body = { error: sanitizeAgentConnectReason(reason || 'Participant interrupt did not complete') }
        return
    }
    if (!requireManageRoom(ctx, storage, roomId)) {
        releaseAdmissionPause()
        fenceHeartbeat.stop()
        storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        return
    }
    let removal: ReturnType<typeof storage.removeAgentActorWithRetention>
    try {
        fenceHeartbeat.assertCurrent()
        removal = storage.removeAgentActorWithRetention(roomId, requestedAgentId, deletionGuard)
        fenceHeartbeat.stop()
    } catch (err: any) {
        releaseAdmissionPause()
        fenceHeartbeat.stop()
        storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Participant runtime identity changed during synchronized deletion' }
        return
    }
    const committedRemoval = removal!
    try {
        await chatServer.cleanupRemovedAgentRuntime(committedRemoval)
    } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err || '')
        console.error(`[GroupChat] Failed runtime cleanup for agent ${agent.agentId} in room ${roomId}: ${sanitizeAgentConnectReason(reason)}`)
    } finally {
        releaseAdmissionPause()
    }
    if (!requireManageRoom(ctx, storage, roomId)) return
    ctx.body = {
        success: true,
        agents: storage.getRoomAgents(roomId).map(serializeRoomAgent),
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
    await chatServer.agentClients.interruptRoom(roomId)
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
    const deletionGuard = storage.captureRoomDeletionGuard(roomId)
    let fence: ReturnType<typeof storage.beginRoomRuntimeMutation>
    try {
        fence = storage.beginRoomRuntimeMutation(roomId, 'Room is being deleted')
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Another Room runtime mutation is already in progress' }
        return
    }
    deletionGuard.runtimeMutationToken = fence.token
    const fenceHeartbeat = keepRuntimeMutationAlive(storage, fence)
    let finalizeRuntimeDeletion: ((committed: boolean) => void) | null = null
    let committed = false
    // Stop all persisted runtimes while retaining their session fence through the SQLite CAS delete.
    try {
        finalizeRuntimeDeletion = await chatServer.deleteRoomRuntimeState(roomId, () => {
            fenceHeartbeat.assertCurrent()
            assertCurrentRoomManager(ctx, storage, roomId)
        })
        fenceHeartbeat.assertCurrent()
    } catch (err: any) {
        fenceHeartbeat.stop()
        storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        if (isRequestAuthorizationChanged(err)) return
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    try {
        if (!requireManageRoom(ctx, storage, roomId)) return
        // Delete only if the exact stopped participant set is still authoritative.
        storage.deleteRoom(roomId, deletionGuard)
        committed = true
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room runtime identity changed during synchronized deletion' }
        return
    } finally {
        try {
            finalizeRuntimeDeletion?.(committed)
        } finally {
            fenceHeartbeat.stop()
            if (!committed) storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        }
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
    const access = requireManageRoom(ctx, storage, roomId)
    if (!access) {
        return
    }
    const deletionGuard = storage.captureRoomDeletionGuard(roomId)
    let fence: ReturnType<typeof storage.beginRoomRuntimeMutation>
    try {
        fence = storage.beginRoomRuntimeMutation(roomId, 'Room context is being cleared')
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Another Room runtime mutation is already in progress' }
        return
    }
    deletionGuard.runtimeMutationToken = fence.token
    const fenceHeartbeat = keepRuntimeMutationAlive(storage, fence)
    let finalizeRuntimeClear: ((committed: boolean) => void) | null = null
    let committed = false
    try {
        finalizeRuntimeClear = await chatServer.clearRoomRuntimeState(roomId, () => {
            fenceHeartbeat.assertCurrent()
            assertCurrentRoomManager(ctx, storage, roomId)
        })
        fenceHeartbeat.assertCurrent()
    } catch (err: any) {
        fenceHeartbeat.stop()
        storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        if (isRequestAuthorizationChanged(err)) return
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room interrupt did not complete' }
        return
    }
    let finalAccess: RoomAccess | null = null
    try {
        finalAccess = requireManageRoom(ctx, storage, roomId)
        if (!finalAccess) return
        storage.clearRoomContext(roomId, deletionGuard)
        committed = true
    } catch (err: any) {
        ctx.status = Number(err?.status || 409)
        ctx.body = { error: err?.message || 'Room runtime identity changed during synchronized context rotation' }
        return
    } finally {
        try {
            finalizeRuntimeClear?.(committed)
        } finally {
            fenceHeartbeat.stop()
            storage.releaseRuntimeMutation(fence.token, fence.roomId, fence.actorId)
        }
    }
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
    const body = (ctx.request.body || {}) as {
        triggerTokens?: number
        maxHistoryTokens?: number
        tailMessageCount?: number
        maxAgentMentionDepth?: number | null
        handoffMode?: 'mentions' | 'fixed'
        handoffOrder?: string[]
    }
    const {
        triggerTokens, maxHistoryTokens, tailMessageCount,
        maxAgentMentionDepth, handoffMode, handoffOrder,
    } = body
    if (Object.prototype.hasOwnProperty.call(body, 'maxAgentMentionDepth') &&
        maxAgentMentionDepth !== null &&
        (typeof maxAgentMentionDepth !== 'number' || !Number.isSafeInteger(maxAgentMentionDepth) || maxAgentMentionDepth <= 0)) {
        ctx.status = 400
        ctx.body = { error: 'maxAgentMentionDepth must be a positive integer or null' }
        return
    }

    const storage = chatServer.getStorage()
    const access = requireManageRoom(ctx, storage, roomId)
    if (!access) return
    const room = storage.getRoom(roomId)
    if (!room) {
        ctx.status = 404
        ctx.body = { error: 'Room not found' }
        return
    }
    const requestedMode = handoffMode === undefined ? String(room.handoffMode || 'mentions') : handoffMode
    if (requestedMode !== 'mentions' && requestedMode !== 'fixed') {
        ctx.status = 400
        ctx.body = { error: 'handoffMode must be mentions or fixed' }
        return
    }
    let handoffOrderJson: string | undefined
    if (requestedMode === 'fixed') {
        const order = handoffOrder === undefined
            ? (() => { try { return JSON.parse(String(room.handoffOrderJson || '[]')) } catch { return [] } })()
            : handoffOrder
        const allowed = new Set(storage.getRoomAgents(roomId).map(agent => String(agent.agentId)))
        if (!Array.isArray(order) || order.length < 2 || order.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(order).size !== order.length) {
            ctx.status = 400
            ctx.body = { error: 'fixed handoffOrder must contain at least two unique current participant agent ids' }
            return
        }
        handoffOrderJson = JSON.stringify(order)
    } else if (handoffOrder !== undefined) {
        if (!Array.isArray(handoffOrder)) {
            ctx.status = 400
            ctx.body = { error: 'handoffOrder must be an array' }
            return
        }
        handoffOrderJson = JSON.stringify(handoffOrder)
    }
    storage.updateRoomConfig(roomId, {
        triggerTokens,
        maxHistoryTokens,
        tailMessageCount,
        maxAgentMentionDepth,
        handoffMode: handoffMode === undefined ? undefined : requestedMode,
        handoffOrderJson,
    })
    await chatServer.agentClients.interruptRoom(roomId)
    const finalAccess = requireManageRoom(ctx, storage, roomId)
    if (!finalAccess) return
    ctx.body = { room: serializeRoom(storage.getRoom(roomId), finalAccess) }
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
            storage.fenceRoomHandoffJobs(roomId, 'Room workspace is changing')
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
