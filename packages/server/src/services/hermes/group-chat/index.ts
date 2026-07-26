import { Server, Socket, Namespace } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { DatabaseSync } from 'node:sqlite'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { basename } from 'path'
import { createHash, randomBytes } from 'crypto'
import { logger } from '../../../services/logger'
import { getDb } from '../../../db'
import { normalizeMessageContentForStorage, normalizeMessageContentForStorageRole } from '../../../db/hermes/message-content'
import { AgentClients, GROUP_CHAT_AGENT_SOCKET_SECRET, groupBridgeSessionId } from './agent-clients'
import { ContextEngine } from '../context-engine/compressor'
import { SessionDeleter } from '../session-deleter'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { AgentBridgeClient } from '../agent-bridge'
import { insertWorkspaceRunChange, deleteWorkspaceRunChangesForRoom, type SaveWorkspaceRunChangeInput, type WorkspaceRunChangeSummary } from '../../../db/hermes/workspace-run-changes-store'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../../../middleware/user-auth'
import { findUserById, findUserByUsername, getUserAvatar, listUserProfiles } from '../../../db/hermes/users-store'
import { config } from '../../../config'
import { createSocketIoCorsOrigin, shouldRejectUpgradeOrigin } from '../../../security'
import { getGroupChatLocalIdentitySecret } from '../../auth'
import { paginateRecentGroupMessagesCanonical, sliceGroupMessagesCanonical, sliceGroupMessagesForSnapshotTail, type GroupMessageCursorCutoff } from './group-message-ordering'
import {
    createAgentGroupChatSubject,
    createAuthenticatedGroupChatSubject,
    createLocalGroupChatSubject,
    evaluateGroupChatAccessPolicy,
    groupChatInviteCodeMatches,
} from './access-policy'
import {
    deactivateAgentActorWithRetention as deactivatePersistedAgentActorWithRetention,
    ensureAgentActor as persistAgentActor,
    ensureAuthenticatedHumanActor as persistAuthenticatedHumanActor,
    ensureLocalActor as persistLocalActor,
    ensureSystemActor as persistSystemActor,
    findActiveActorByAgentIdentity as readActiveActorByAgentIdentity,
    findActiveActorByAuthUserId as readActiveActorByAuthUserId,
    findActiveActorByLocalSubjectId as readActiveActorByLocalSubjectId,
    findActiveActorBySystemKey as readActiveActorBySystemKey,
    getActorCapabilities as readPersistedActorCapabilities,
} from './identity/actor-store'
import type { GroupActor } from './identity/types'
import {
    GroupChatInviteAttemptLimiter,
    groupChatInviteAttemptSubjectKey,
} from './invite-attempt-limiter'

// ─── Types ────────────────────────────────────────────────────

interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    roomSeq?: number
    role?: string
    tool_call_id?: string | null
    tool_calls?: any[] | null
    tool_name?: string | null
    finish_reason?: string | null
    reasoning?: string | null
    reasoning_details?: string | null
    reasoning_content?: string | null
    mentionDepth?: number
    agentSessionId?: string
    handoffChainId?: string
    handoffDepth?: number
    sourceHandoffJobId?: string
    sourceHandoffLeaseToken?: string
    handoffFinal?: boolean
}

function contentToStorageString(content: unknown): string {
    if (typeof content === 'string') return content
    return JSON.stringify(content ?? '')
}

function messageContentForStorage(role: string | undefined, content: string): string {
    return normalizeMessageContentForStorageRole(role, content)
}

function contentToText(content: unknown): string {
    if (typeof content === 'string') {
        const trimmed = content.trim()
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                return contentToText(JSON.parse(trimmed))
            } catch {
                return content
            }
        }
        return content
    }
    if (Array.isArray(content)) {
        return content.map((block: any) => {
            if (block?.type === 'text') return block.text || ''
            if (block?.type === 'image') return `[Image: ${block.name || block.path || ''}]`
            if (block?.type === 'file') return `[File: ${block.name || block.path || ''}]`
            return ''
        }).filter(Boolean).join('\n')
    }
    return content == null ? '' : String(content)
}

const APPROVAL_CHOICES = ['once', 'session', 'always', 'deny'] as const
type ApprovalChoice = typeof APPROVAL_CHOICES[number]
const APPROVAL_CHOICE_SET = new Set<string>(APPROVAL_CHOICES)

interface PendingApprovalBinding {
    roomId: string
    agentId: string
    agentSessionId: string
    allowedChoices: ApprovalChoice[]
    allowPermanent: boolean
    responding: boolean
    responded: boolean
    conflicted: boolean
}

const MAX_PENDING_APPROVAL_BINDINGS = 1_000

interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    profile: string
    name: string
    description: string
    invited: number
    runtime: 'hermes' | 'coding_agent'
    codingAgentId: '' | 'claude-code' | 'codex'
    sessionId: string
    sessionGeneration: number
    mode: 'scoped' | 'global'
    provider: string
    model: string
    apiMode: string
    reasoningEffort: string
    avatar: string
    lastSeenRoomSeq: number
    lastSuccessfulRunId: string
    checkpoint: string
    checkpointSourceMessageIds: string
    checkpointFromRoomSeq: number
    checkpointThroughRoomSeq: number
}

export function participantSessionId(roomId: string, agentId: string, generation = 0): string {
    return `gc_${roomId}_${agentId}_${generation}`
}

export interface RoomAgentBindingInput {
    runtime?: 'hermes' | 'coding_agent'
    codingAgentId?: '' | 'claude-code' | 'codex'
    sessionId?: string
    sessionGeneration?: number
    mode?: 'scoped' | 'global'
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    avatar?: string
    lastSeenRoomSeq?: number
    lastSuccessfulRunId?: string
    checkpoint?: string
    checkpointSourceMessageIds?: string
    checkpointFromRoomSeq?: number
    checkpointThroughRoomSeq?: number
}

interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    inviteGeneration: number
    triggerTokens: number
    maxHistoryTokens: number
    tailMessageCount: number
    maxAgentMentionDepth: number | null
    handoffMode: 'mentions' | 'fixed'
    handoffOrderJson: string
    totalTokens: number
    sessionSeed: string
    messageSeq: number
    contextStartRoomSeq: number
    prunedThroughRoomSeq: number
    workspace: string
    ownerAuthUserId: number | null
    authorizationRevision: number
}

interface SaveWorkspaceDiffMessageArgs {
    roomId: string
    senderId: string
    senderName: string
    sessionId: string
    runId: string
    status: 'completed' | 'failed' | 'aborted'
    workspace: string
    draft: SaveWorkspaceRunChangeInput
    parentMessageId?: string | null
}

interface CreateRoomWithOwnerArgs {
    id: string
    name: string
    inviteCode?: string
    config?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number; workspace?: string; ownerAuthUserId?: number | null }
    owner?: ({
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
    }) | null
}

interface Member {
    id: string
    userId: string
    name: string
    description: string
    joinedAt: number
    online: boolean
    socketId: string
    source?: 'human' | 'agent'
    avatar: string
    authUserId?: number | null
}

function authenticatedGroupUserId(authUserId: number): string {
    return `auth:${authUserId}`
}

function authenticatedUserProfiles(user: AuthenticatedUser | undefined): string[] {
    return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
}

const GROUP_CHAT_LOCAL_CREDENTIAL_CONTEXT = 'group-chat-local-identity-v1\0'
const GROUP_CHAT_LOCAL_ROUTING_CONTEXT = 'group-chat-local-routing-v1\0'
const GROUP_CHAT_LOCAL_SUBJECT_ID_RE = /^local:[0-9a-f]{32}$/

function createLocalGroupChatSubjectId(): string {
    return `local:${randomBytes(16).toString('hex')}`
}

function localGroupUserId(secret: string, localSubjectId: string): string {
    const digest = createHmac('sha256', secret)
        .update(GROUP_CHAT_LOCAL_ROUTING_CONTEXT, 'utf8')
        .update(localSubjectId, 'utf8')
        .digest('hex')
    return `local-user:${digest}`
}

function localCredentialSignature(secret: string, payload: string): Buffer {
    return createHmac('sha256', secret)
        .update(GROUP_CHAT_LOCAL_CREDENTIAL_CONTEXT, 'utf8')
        .update(payload, 'utf8')
        .digest()
}

function encodeLocalCredential(secret: string, localSubjectId: string): string {
    const payload = Buffer.from(JSON.stringify({ sub: localSubjectId }), 'utf8').toString('base64url')
    const signature = localCredentialSignature(secret, payload).toString('base64url')
    return `${payload}.${signature}`
}

function decodeLocalCredential(secret: string, credential: string): string | null {
    const trimmed = credential.trim()
    const separator = trimmed.indexOf('.')
    if (separator <= 0 || separator === trimmed.length - 1) return null
    const payload = trimmed.slice(0, separator)
    const signature = trimmed.slice(separator + 1)
    let localSubjectId = ''
    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: unknown }
        localSubjectId = typeof parsed?.sub === 'string' ? parsed.sub : ''
    } catch {
        return null
    }
    if (!GROUP_CHAT_LOCAL_SUBJECT_ID_RE.test(localSubjectId)) {
        return null
    }
    const expected = localCredentialSignature(secret, payload)
    const provided = Buffer.from(signature, 'base64url')
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
        return null
    }
    return localSubjectId
}

function noAccessPolicyDecision(roomId: string, room: RoomInfo | null | undefined) {
    return {
        roomId,
        roomExists: Boolean(room),
        canDiscover: false,
        canJoin: false,
        canInvokeAgent: false,
        canRespondApproval: false,
        actorId: null,
        actorType: null,
        actorAuthorizationRevision: 0,
        actorContextRevision: 0,
        roomAuthorizationRevision: Number(room?.authorizationRevision || 0),
        capabilities: [],
        canRead: false,
        canWrite: false,
        canType: false,
        canManage: false,
        canInvokeAgents: false,
        canApprove: false,
        isReadOnly: false,
    }
}

let _tablesEnsured = false

interface PendingSessionDelete {
    session_id: string
    profile_name: string
    status: string
    attempt_count: number
    last_error: string | null
    created_at: number
    updated_at: number
    next_attempt_at: number
}

interface GroupChatSessionProfile {
    session_id: string
    room_id: string
    agent_id: string
    profile_name: string
    created_at: number
}

interface RemovedAgentRetention {
    agent: RoomAgent
    actorId: string | null
    sessionProfiles: GroupChatSessionProfile[]
}

interface HumanRoomAdmissionArgs {
    roomId: string
    userId: string
    localSubjectId?: string | null
    inviteCode?: string
    requestedName: string
    requestedDescription: string
    avatar: string
    authUser?: AuthenticatedUser
}

interface AdmittedHumanRoomAdmission {
    status: 'admitted'
    room: RoomInfo
    userName: string
    description: string
    avatar: string
}

type HumanRoomAdmissionResult =
    | AdmittedHumanRoomAdmission
    | {
        status: 'not_found'
      }

export interface PendingSessionDeleteDrainResult {
    deleted: string[]
    failed: Array<{ sessionId: string; error: string }>
}

function parseJsonArray(value: unknown): any[] | null {
    if (value == null || value === '') return null
    if (Array.isArray(value)) return value
    if (typeof value !== 'string') return null
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

function normalizeMessageRole(role: unknown): string {
    const value = String(role || '').trim()
    return ['user', 'assistant', 'tool', 'command'].includes(value) ? value : 'user'
}

function normalizeMentionDepth(depth: unknown): number {
    const value = Number(depth)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function isUnknownBridgeSessionError(err: unknown): boolean {
    const message = String((err as { message?: unknown } | null)?.message || err || '').toLowerCase()
    return message.includes('unknown session') || message.includes('session not found')
}

function maxAgentMentionDepth(): number {
    const value = Number(process.env.HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH)
    if (!Number.isFinite(value) || value <= 0) return 4
    return Math.min(10, Math.floor(value))
}

export type GroupHandoffKind = 'mention' | 'fixed' | 'fanout'

export interface GroupHandoffPlan {
    chainId: string
    targetAgentId: string
    targetSessionId: string
    depth: number
    kind: GroupHandoffKind
}

export interface GroupHandoffJob extends GroupHandoffPlan {
    id: string
    roomId: string
    sourceMessageId: string
    status: 'pending' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
    attemptCount: number
    availableAt: number
    leaseOwner: string
    leaseToken: string
    leaseExpiresAt: number
    lastError: string
    createdAt: number
    updatedAt: number
    completedAt: number
}

function parseFixedHandoffOrder(value: unknown, agents: RoomAgent[]): RoomAgent[] {
    const allowed = new Map(agents.map(agent => [agent.agentId, agent]))
    let ids: unknown = value
    if (typeof value === 'string') {
        try { ids = JSON.parse(value) } catch { ids = [] }
    }
    if (!Array.isArray(ids)) return []
    const seen = new Set<string>()
    const ordered: RoomAgent[] = []
    for (const rawId of ids) {
        const id = String(rawId || '')
        const agent = allowed.get(id)
        if (!agent || seen.has(id)) continue
        seen.add(id)
        ordered.push(agent)
    }
    return ordered
}

export function planGroupHandoffs(args: {
    room: Pick<RoomInfo, 'handoffMode' | 'handoffOrderJson' | 'maxAgentMentionDepth'> | Record<string, unknown>
    agents: RoomAgent[]
    source: Partial<ChatMessage> & Pick<ChatMessage, 'senderId' | 'content'>
    sourceJobKind?: GroupHandoffKind
}): GroupHandoffPlan[] {
    const sourceId = String(args.source.id || '')
    const chainId = String(args.source.handoffChainId || '') || (sourceId ? `gcchain_${sourceId}` : '')
    if (!chainId) return []
    const depth = normalizeMentionDepth(args.source.handoffDepth ?? args.source.mentionDepth)
    const role = args.source.role === 'assistant' ? 'assistant' : 'user'
    const allMentioned = isAllAgentsMentioned(String(args.source.content || ''))
    if (role === 'user' && allMentioned) {
        return args.agents
            .filter(agent => agent.agentId !== args.source.senderId)
            .map(agent => ({ chainId, targetAgentId: agent.agentId, targetSessionId: agent.sessionId, depth: 0, kind: 'fanout' }))
    }
    if (role === 'assistant' && args.sourceJobKind === 'fanout') return []
    if (role === 'assistant' && args.source.finish_reason === 'error') return []
    if (role === 'assistant' && !allowsAgentMentionRelay(depth, args.room.maxAgentMentionDepth)) return []

    if (args.room.handoffMode === 'fixed') {
        if (role === 'user') {
            const mentioned = resolveMentionTargets(args.agents, String(args.source.content || ''), String(args.source.senderId || ''))
            const kind: GroupHandoffKind = mentioned.length === 1 ? 'fixed' : 'fanout'
            return mentioned.map(agent => ({
                chainId, targetAgentId: agent.agentId, targetSessionId: agent.sessionId, depth: 0, kind,
            }))
        }
        if (args.sourceJobKind !== 'fixed') return []
        const ordered = parseFixedHandoffOrder(args.room.handoffOrderJson, args.agents)
        const senderIndex = ordered.findIndex(agent => agent.agentId === args.source.senderId)
        if (senderIndex < 0 || ordered.length < 2) return []
        const target = ordered[(senderIndex + 1) % ordered.length]
        return [{ chainId, targetAgentId: target.agentId, targetSessionId: target.sessionId, depth, kind: 'fixed' }]
    }

    return resolveMentionTargets(args.agents, String(args.source.content || ''), String(args.source.senderId || ''))
        .map(agent => ({ chainId, targetAgentId: agent.agentId, targetSessionId: agent.sessionId, depth, kind: 'mention' as const }))
}

export class ChatStorage {
    private retentionBlockedHandler: ((roomId: string, blockedAgentIds: string[], throughRoomSeq: number) => void) | null = null
    private db() { return getDb() }

    setRetentionBlockedHandler(handler: ((roomId: string, blockedAgentIds: string[], throughRoomSeq: number) => void) | null): void {
        this.retentionBlockedHandler = handler
    }

    private notifyRetentionBlocked(roomId: string, result: { blockedAgentIds: string[]; throughRoomSeq: number }): void {
        if (!result.blockedAgentIds.length || result.throughRoomSeq <= 0 || !this.retentionBlockedHandler) return
        const handler = this.retentionBlockedHandler
        queueMicrotask(() => handler(roomId, result.blockedAgentIds, result.throughRoomSeq))
    }

    private mapStoredMessageRow(row: any): ChatMessage {
        return {
            ...row,
            tool_calls: parseJsonArray(row.tool_calls),
        }
    }

    init(): void {
        if (_tablesEnsured) return
        const db = this.db()
        if (!db) return
        // Tables are now created centrally in initAllHermesTables()
        // Only create indexes here
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_messages_room ON gc_messages(roomId, timestamp)') } catch { /* ignore */ }
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_room_agents_room ON gc_room_agents(roomId)') } catch { /* ignore */ }
        try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_gc_room_members_unique ON gc_room_members(roomId, userId)') } catch { /* ignore */ }
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_pending_session_deletes_profile ON gc_pending_session_deletes(profile_name, status, next_attempt_at, created_at)') } catch { /* ignore */ }
        try { db.exec('CREATE INDEX IF NOT EXISTS idx_gc_session_profiles_profile ON gc_session_profiles(profile_name, created_at)') } catch { /* ignore */ }
        _tablesEnsured = true
    }

    saveSessionProfile(sessionId: string, roomId: string, agentId: string, profileName: string): void {
        const db = this.db()
        if (!db) throw new Error('Group chat database is unavailable')
        db.prepare(
            'INSERT INTO gc_session_profiles (session_id, room_id, agent_id, profile_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET room_id = excluded.room_id, agent_id = excluded.agent_id, profile_name = excluded.profile_name'
        ).run(sessionId, roomId, agentId, profileName, Date.now())
    }

    registerSessionProfileForActiveAgent(args: {
        sessionId: string
        roomId: string
        agentId: string
        profileName: string
        agentName: string
        sessionSeed: string
        roomAuthorizationRevision: number
        actorId: string
        actorAuthorizationRevision: number
        actorContextRevision: number
        requireRunCapabilities?: boolean
        cleanupAfterMs?: number
    }): boolean {
        const db = this.db()
        if (!db) throw new Error('Group chat database is unavailable')
        return this.withImmediateTransaction(db, () => {
            const now = Date.now()
            const requestedCleanupDelay = Number(args.cleanupAfterMs)
            const cleanupDelay = Number.isFinite(requestedCleanupDelay) && requestedCleanupDelay >= 0
                ? Math.floor(requestedCleanupDelay)
                : null
            const scheduleCrashCleanup = () => {
                if (cleanupDelay === null) return
                db.prepare(
                    `INSERT INTO gc_pending_session_deletes (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
                     VALUES (?, ?, 'pending', 0, NULL, ?, ?, ?)
                     ON CONFLICT(session_id) DO UPDATE SET
                       profile_name = excluded.profile_name,
                       status = 'pending',
                       updated_at = excluded.updated_at,
                       next_attempt_at = excluded.next_attempt_at`
                ).run(args.sessionId, args.profileName, now, now, now + cleanupDelay)
            }
            const room = db.prepare(
                'SELECT sessionSeed, authorizationRevision FROM gc_rooms WHERE id = ?'
            ).get(args.roomId) as { sessionSeed: string; authorizationRevision: number } | undefined
            const agent = db.prepare(
                'SELECT 1 AS present FROM gc_room_agents WHERE roomId = ? AND agentId = ? AND profile = ? AND name = ?'
            ).get(args.roomId, args.agentId, args.profileName, args.agentName)
            const actor = db.prepare(
                `SELECT id, authorizationRevision, contextRevision
                 FROM gc_room_actors
                 WHERE roomId = ? AND agentId = ? AND active = 1`
            ).get(args.roomId, args.agentId) as {
                id: string
                authorizationRevision: number
                contextRevision: number
            } | undefined
            const requiredCapabilityCount = actor
                ? Number((db.prepare(
                    `SELECT COUNT(DISTINCT capability) AS count
                     FROM gc_room_actor_capabilities
                     WHERE actorId = ? AND active = 1 AND capability IN ('room.read', 'room.write')`
                ).get(actor.id) as { count: number }).count || 0)
                : 0
            if (
                !/^gc_h_[0-9a-f]{32}$/.test(args.sessionId)
                || !room
                || !agent
                || !actor
                || (args.requireRunCapabilities !== false && requiredCapabilityCount !== 2)
                || room.sessionSeed !== args.sessionSeed
                || Number(room.authorizationRevision || 0) !== args.roomAuthorizationRevision
                || actor.id !== args.actorId
                || Number(actor.authorizationRevision || 0) !== args.actorAuthorizationRevision
                || Number(actor.contextRevision || 0) !== args.actorContextRevision
            ) {
                return false
            }
            const existing = db.prepare(
                'SELECT room_id, agent_id, profile_name FROM gc_session_profiles WHERE session_id = ?'
            ).get(args.sessionId) as {
                room_id: string
                agent_id: string
                profile_name: string
            } | undefined
            if (existing) {
                const matches = existing.room_id === args.roomId
                    && existing.agent_id === args.agentId
                    && existing.profile_name === args.profileName
                if (matches) scheduleCrashCleanup()
                return matches
            }
            db.prepare(
                'INSERT INTO gc_session_profiles (session_id, room_id, agent_id, profile_name, created_at) VALUES (?, ?, ?, ?, ?)'
            ).run(args.sessionId, args.roomId, args.agentId, args.profileName, now)
            scheduleCrashCleanup()
            return true
        })
    }

    getSessionProfile(sessionId: string): GroupChatSessionProfile | null {
        return (this.db()?.prepare(
            'SELECT session_id, room_id, agent_id, profile_name, created_at FROM gc_session_profiles WHERE session_id = ?'
        ).get(sessionId) as GroupChatSessionProfile | undefined) ?? null
    }

    getSessionProfilesForRoomAgent(roomId: string, agentId: string): GroupChatSessionProfile[] {
        return (this.db()?.prepare(
            'SELECT session_id, room_id, agent_id, profile_name, created_at FROM gc_session_profiles WHERE room_id = ? AND agent_id = ? ORDER BY created_at ASC'
        ).all(roomId, agentId) as GroupChatSessionProfile[] | undefined) ?? []
    }

    deleteSessionProfile(sessionId: string): void {
        this.db()?.prepare('DELETE FROM gc_session_profiles WHERE session_id = ?').run(sessionId)
    }

    listPendingSessionDeletes(profileName: string, limit = 50): PendingSessionDelete[] {
        const rows = this.db()?.prepare(
            `SELECT session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at
             FROM gc_pending_session_deletes
             WHERE profile_name = ? AND status = 'pending' AND next_attempt_at <= ?
             ORDER BY created_at ASC
             LIMIT ?`
        ).all(profileName, Date.now(), limit) || []
        return rows.map((row: any) => ({
            session_id: String(row.session_id || ''),
            profile_name: String(row.profile_name || ''),
            status: String(row.status || 'pending'),
            attempt_count: Number(row.attempt_count || 0),
            last_error: row.last_error == null ? null : String(row.last_error),
            created_at: Number(row.created_at || 0),
            updated_at: Number(row.updated_at || 0),
            next_attempt_at: Number(row.next_attempt_at || 0),
        }))
    }

    enqueuePendingSessionDelete(sessionId: string, profileName: string): void {
        const now = Date.now()
        this.db()?.prepare(
            `INSERT INTO gc_pending_session_deletes (session_id, profile_name, status, attempt_count, last_error, created_at, updated_at, next_attempt_at)
             VALUES (?, ?, 'pending', 0, NULL, ?, ?, 0)
             ON CONFLICT(session_id) DO UPDATE SET
               profile_name = excluded.profile_name,
               status = 'pending',
               updated_at = excluded.updated_at,
               next_attempt_at = 0`
        ).run(sessionId, profileName, now, now)
    }


    markPendingSessionDeleteFailed(sessionId: string, error: string): void {
        const now = Date.now()
        this.db()?.prepare(
            `UPDATE gc_pending_session_deletes
             SET status = 'pending',
                 attempt_count = attempt_count + 1,
                 last_error = ?,
                 updated_at = ?,
                 next_attempt_at = ?
             WHERE session_id = ?`
        ).run(error, now, now + 60_000, sessionId)
    }

    removePendingSessionDelete(sessionId: string): void {
        this.db()?.prepare('DELETE FROM gc_pending_session_deletes WHERE session_id = ?').run(sessionId)
    }

    getPendingDeletedSessionIds(): Set<string> {
        const rows = (this.db()?.prepare(
            `SELECT session_id FROM gc_pending_session_deletes WHERE status IN ('pending', 'processing')`
        ).all() || []) as Array<{ session_id: string }>
        return new Set(rows.map(row => row.session_id))
    }

    // ─── Rooms ────────────────────────────────────────────────

    getRoom(roomId: string): RoomInfo | undefined {
        return this.db()?.prepare('SELECT id, name, inviteCode, inviteGeneration, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens, sessionSeed, workspace, ownerAuthUserId, authorizationRevision FROM gc_rooms WHERE id = ?').get(roomId) as RoomInfo | undefined
    }

    getRoomByInviteCode(code: string): RoomInfo | undefined {
        let matchingRoom: RoomInfo | undefined
        for (const room of this.getAllRooms()) {
            const matches = groupChatInviteCodeMatches(code, room.inviteCode)
            if (matches && !matchingRoom) matchingRoom = room
        }
        return matchingRoom
    }

    getAllRooms(): RoomInfo[] {
        return (this.db()?.prepare('SELECT id, name, inviteCode, inviteGeneration, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens, sessionSeed, workspace, ownerAuthUserId, authorizationRevision FROM gc_rooms ORDER BY id').all() || []) as unknown as RoomInfo[]
    }

    getRoomsForProfiles(profiles: string[]): RoomInfo[] {
        const uniqueProfiles = [...new Set(profiles.map(profile => profile.trim()).filter(Boolean))]
        if (!uniqueProfiles.length) return []
        const placeholders = uniqueProfiles.map(() => '?').join(', ')
        return (this.db()?.prepare(
            `SELECT DISTINCT r.id, r.name, r.inviteCode, r.inviteGeneration, r.triggerTokens, r.maxHistoryTokens, r.tailMessageCount, r.totalTokens, r.sessionSeed, r.workspace, r.ownerAuthUserId, r.authorizationRevision
             FROM gc_rooms r
             INNER JOIN gc_room_agents a ON a.roomId = r.id
             WHERE a.profile IN (${placeholders})
             ORDER BY r.id`
        ).all(...uniqueProfiles) || []) as any[]
    }

    getRoomsForAuthUser(authUserId: number): RoomInfo[] {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return []
        return (this.db()?.prepare(
            `SELECT DISTINCT r.id, r.name, r.inviteCode, r.inviteGeneration, r.triggerTokens, r.maxHistoryTokens, r.tailMessageCount, r.totalTokens, r.sessionSeed, r.workspace, r.ownerAuthUserId, r.authorizationRevision
             FROM gc_rooms r
             INNER JOIN gc_room_members m ON m.roomId = r.id
             WHERE m.authUserId = ?
             ORDER BY r.id`
        ).all(authUserId) || []) as any[]
    }

    getOwnedRoomsForAuthUser(authUserId: number): RoomInfo[] {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return []
        return (this.db()?.prepare(
            `SELECT id, name, inviteCode, inviteGeneration, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens, sessionSeed, workspace, ownerAuthUserId, authorizationRevision
             FROM gc_rooms
             WHERE ownerAuthUserId = ?
             ORDER BY id`
        ).all(authUserId) || []) as any[]
    }

    saveRoom(id: string, name: string, inviteCode?: string, config?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number; maxAgentMentionDepth?: number | null; handoffMode?: 'mentions' | 'fixed'; handoffOrderJson?: string; workspace?: string; ownerAuthUserId?: number | null }): void {
        const rawOwnerAuthUserId = Number(config?.ownerAuthUserId ?? 0)
        const ownerAuthUserId = Number.isFinite(rawOwnerAuthUserId) && rawOwnerAuthUserId > 0 ? Math.floor(rawOwnerAuthUserId) : null
        const sessionSeed = this.newRoomSessionSeed()
        this.db()?.prepare(
            'INSERT OR IGNORE INTO gc_rooms (id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, sessionSeed, workspace, ownerAuthUserId, authorizationRevision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
        ).run(id, name, inviteCode || null, config?.triggerTokens ?? 100000, config?.maxHistoryTokens ?? 32000, config?.tailMessageCount ?? 10, sessionSeed, config?.workspace || '', ownerAuthUserId)
    }

    createRoomWithOwner(args: CreateRoomWithOwnerArgs): void {
        const db = this.db()
        const owner = args.owner
        const ownerAuthUserId = owner?.kind === 'authenticated' ? owner.authUserId : undefined
        if (!db) {
            this.saveRoom(args.id, args.name, args.inviteCode, {
                ...args.config,
                ownerAuthUserId,
            })
            return
        }
        this.withImmediateTransaction(db, () => {
            this.saveRoom(args.id, args.name, args.inviteCode, {
                ...args.config,
                ownerAuthUserId,
            })
            if (!owner) return
            if (owner.kind === 'authenticated') {
                this.ensureAuthenticatedHumanActor({
                    roomId: args.id,
                    authUserId: owner.authUserId,
                    userId: authenticatedGroupUserId(owner.authUserId),
                    userName: owner.username,
                    description: owner.description || '',
                    avatar: owner.avatar || '',
                    capabilities: ['room.read', 'room.write', 'room.type', 'room.manage', 'agent.invoke', 'approval.respond'],
                })
                return
            }
            this.ensureLocalActor({
                roomId: args.id,
                localSubjectId: owner.localSubjectId,
                userName: owner.username,
                description: owner.description || '',
                avatar: owner.avatar || '',
                grantDefaultCapabilities: true,
            })
        })
    }

    setRoomOwnerAuthUserId(roomId: string, authUserId: number): void {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return
        this.db()?.prepare(
            `UPDATE gc_rooms
             SET ownerAuthUserId = ?, authorizationRevision = authorizationRevision + 1
             WHERE id = ? AND COALESCE(ownerAuthUserId, -1) <> ?`
        ).run(authUserId, roomId, authUserId)
    }

    clearRoomOwnerAuthUserId(roomId: string, authUserId: number): void {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return
        this.db()?.prepare(
            `UPDATE gc_rooms
             SET ownerAuthUserId = NULL, authorizationRevision = authorizationRevision + 1
             WHERE id = ? AND ownerAuthUserId = ?`
        ).run(roomId, authUserId)
    }

    updateRoomConfig(roomId: string, config: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number; maxAgentMentionDepth?: number | null; handoffMode?: 'mentions' | 'fixed'; handoffOrderJson?: string }): void {
        const sets: string[] = []
        const vals: any[] = []
        if (config.triggerTokens !== undefined) { sets.push('triggerTokens = ?'); vals.push(config.triggerTokens) }
        if (config.maxHistoryTokens !== undefined) { sets.push('maxHistoryTokens = ?'); vals.push(config.maxHistoryTokens) }
        if (config.tailMessageCount !== undefined) { sets.push('tailMessageCount = ?'); vals.push(config.tailMessageCount) }
        if (config.maxAgentMentionDepth !== undefined) { sets.push('maxAgentMentionDepth = ?'); vals.push(config.maxAgentMentionDepth) }
        if (config.handoffMode !== undefined) { sets.push('handoffMode = ?'); vals.push(config.handoffMode) }
        if (config.handoffOrderJson !== undefined) { sets.push('handoffOrderJson = ?'); vals.push(config.handoffOrderJson) }
        if (sets.length === 0) return
        sets.push('authorizationRevision = authorizationRevision + 1')
        vals.push(roomId)
        this.db()?.prepare(`UPDATE gc_rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    updateRoomInviteCode(roomId: string, inviteCode: string): void {
        this.db()?.prepare(
            'UPDATE gc_rooms SET inviteCode = ?, inviteGeneration = inviteGeneration + 1, authorizationRevision = authorizationRevision + 1 WHERE id = ?'
        ).run(inviteCode, roomId)
    }

    incrementRoomAuthorizationRevision(roomId: string): number {
        this.db()?.prepare('UPDATE gc_rooms SET authorizationRevision = authorizationRevision + 1 WHERE id = ?').run(roomId)
        return Number(this.getRoom(roomId)?.authorizationRevision || 0)
    }

    updateRoomTotalTokens(roomId: string, tokens: number): void {
        this.db()?.prepare('UPDATE gc_rooms SET totalTokens = ? WHERE id = ?').run(tokens, roomId)
    }

    getRoomWorkspace(roomId: string): string {
        return String(this.getRoom(roomId)?.workspace || '')
    }

    updateRoomWorkspace(roomId: string, workspace: string): RoomInfo | null {
        const room = this.getRoom(roomId)
        if (!room) return null
        const nextWorkspace = String(workspace || '')
        if (String(room.workspace || '') === nextWorkspace) return room
        const db = this.db()
        if (!db) return null
        const seed = this.newRoomSessionSeed()
        this.withImmediateTransaction(db, () => {
            db.prepare('UPDATE gc_rooms SET workspace = ?, sessionSeed = ? WHERE id = ?').run(nextWorkspace, seed, roomId)
            this.rotateParticipantSessions(roomId)
        })
        return this.getRoom(roomId) || null
    }

    private newRoomSessionSeed(): string {
        return randomBytes(16).toString('hex')
    }

    rotateRoomSessionSeed(roomId: string): string {
        const seed = this.newRoomSessionSeed()
        this.db()?.prepare('UPDATE gc_rooms SET sessionSeed = ? WHERE id = ?').run(seed, roomId)
        return seed
    }

    estimateTokens(text: string): number {
        const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
        const other = text.length - cjk
        return Math.ceil(cjk * 1.5 + other / 4)
    }

    private contentToUsageText(content: unknown): string {
        if (typeof content === 'string') return content
        if (!content) return ''
        if (Array.isArray(content)) {
            return content.map((block: any) => {
                if (typeof block?.text === 'string') return block.text
                if (typeof block?.type === 'string') return `[${block.type}]`
                return String(block || '')
            }).join('\n')
        }
        return String(content)
    }

    private estimateUsageTokensFromMessages(messages: ChatMessage[]): { inputTokens: number; outputTokens: number } {
        const inputTokens = messages
            .filter(m => (m.role || 'user') === 'user')
            .reduce((sum, m) => sum + countTokens(this.contentToUsageText(m.content)), 0)
        const outputTokens = messages
            .filter(m => m.role === 'assistant' || m.role === 'tool')
            .reduce((sum, m) => sum + countTokens(this.contentToUsageText(m.content)) + countTokens(String(m.tool_calls || '')), 0)
        return { inputTokens, outputTokens }
    }

    private estimateRoomTotalTokens(roomId: string, messages: ChatMessage[]): number {
        const snapshot = this.getContextSnapshot(roomId)
        if (snapshot) {
            const snapshotTail = messages.length
                ? (Number(snapshot.lastRoomSeq || 0) > 0
                    ? {
                        messages: messages.filter(message => Number(message.roomSeq || 0) > Number(snapshot.lastRoomSeq || 0)),
                        snapshotCursorFound: true,
                    }
                    : sliceGroupMessagesForSnapshotTail(messages, snapshot.lastMessageId))
                : { messages: [], snapshotCursorFound: true }
            const newUsage = this.estimateUsageTokensFromMessages(snapshotTail.messages)
            // Missing cursor usually means pruneMessages() removed the anchor row while leaving
            // the snapshot. The summary still covers the older conversation, and without the
            // exact boundary we conservatively treat the retained transcript as the verbatim
            // post-summary tail instead of guessing with timestamps.
            return countTokens(SUMMARY_PREFIX + snapshot.summary) + newUsage.inputTokens + newUsage.outputTokens
        }
        const usage = this.estimateUsageTokensFromMessages(messages)
        return usage.inputTokens + usage.outputTokens
    }

    // ─── Messages ─────────────────────────────────────────────

    getRecentMessagesForUI(roomId: string, limit = 150, offset = 0): ChatMessage[] {
        const rows = (this.db()?.prepare(
            'SELECT roomSeq, id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content, handoffChainId, handoffDepth, sourceHandoffJobId FROM gc_messages WHERE roomId = ?'
        ).all(roomId) || []) as any[]
        return paginateRecentGroupMessagesCanonical(rows.map(row => this.mapStoredMessageRow(row)), { limit, offset })
    }

    getMessagesForContext(roomId: string, cutoff?: GroupMessageCursorCutoff): ChatMessage[] {
        const rows = (this.db()?.prepare(
            `SELECT roomSeq, id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content, handoffChainId, handoffDepth, sourceHandoffJobId
             FROM gc_messages
             WHERE roomId = ? AND COALESCE(tool_name, '') <> 'workspace_diff'`
        ).all(roomId) || []) as any[]
        return sliceGroupMessagesCanonical(rows.map(row => this.mapStoredMessageRow(row)), cutoff).messages
    }

    getMessageCount(roomId: string): number {
        const row = this.db()?.prepare(
            'SELECT COUNT(*) as total FROM gc_messages WHERE roomId = ?'
        ).get(roomId) as { total: number } | undefined
        return row?.total || 0
    }

    getMessage(messageId: string): ChatMessage | null {
        const row = this.db()?.prepare(
            'SELECT roomSeq, id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content, handoffChainId, handoffDepth, sourceHandoffJobId FROM gc_messages WHERE id = ?'
        ).get(messageId) as any
        if (!row) return null
        return this.mapStoredMessageRow(row)
    }

    private mapHandoffJob(row: any): GroupHandoffJob {
        return {
            id: String(row.id),
            roomId: String(row.roomId),
            chainId: String(row.chainId),
            sourceMessageId: String(row.sourceMessageId),
            targetAgentId: String(row.targetAgentId),
            targetSessionId: String(row.targetSessionId),
            depth: normalizeMentionDepth(row.depth),
            kind: String(row.kind || 'mention') as GroupHandoffKind,
            status: String(row.status || 'pending') as GroupHandoffJob['status'],
            attemptCount: Math.max(0, Math.floor(Number(row.attemptCount) || 0)),
            availableAt: Math.max(0, Math.floor(Number(row.availableAt) || 0)),
            leaseOwner: String(row.leaseOwner || ''),
            leaseToken: String(row.leaseToken || ''),
            leaseExpiresAt: Math.max(0, Math.floor(Number(row.leaseExpiresAt) || 0)),
            lastError: String(row.lastError || ''),
            createdAt: Math.max(0, Math.floor(Number(row.createdAt) || 0)),
            updatedAt: Math.max(0, Math.floor(Number(row.updatedAt) || 0)),
            completedAt: Math.max(0, Math.floor(Number(row.completedAt) || 0)),
        }
    }

    getHandoffJob(jobId: string): GroupHandoffJob | null {
        const row = this.db()?.prepare('SELECT * FROM gc_handoff_jobs WHERE id = ?').get(jobId)
        return row ? this.mapHandoffJob(row) : null
    }

    listHandoffJobs(roomId: string, limit = 100): GroupHandoffJob[] {
        return ((this.db()?.prepare(
            'SELECT * FROM gc_handoff_jobs WHERE roomId = ? ORDER BY createdAt DESC, id DESC LIMIT ?'
        ).all(roomId, Math.max(1, Math.min(500, Math.floor(limit)))) || []) as any[]).map(row => this.mapHandoffJob(row))
    }

    private handoffJobId(sourceMessageId: string, targetAgentId: string): string {
        return `gch_${createHash('sha256').update(`${sourceMessageId}\0${targetAgentId}`).digest('hex').slice(0, 32)}`
    }

    private upsertHandoffJobs(roomId: string, sourceMessageId: string, plans: GroupHandoffPlan[], now: number): GroupHandoffJob[] {
        const db = this.db()
        if (!db || plans.length === 0) return []
        const insert = db.prepare(
            `INSERT INTO gc_handoff_jobs (
               id, roomId, chainId, sourceMessageId, targetAgentId, targetSessionId,
               depth, kind, status, attemptCount, availableAt, leaseOwner, leaseToken,
               leaseExpiresAt, lastError, createdAt, updatedAt, completedAt
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, '', '', 0, '', ?, ?, 0)
             ON CONFLICT(sourceMessageId, targetAgentId) DO NOTHING`
        )
        const getTarget = db.prepare('SELECT sessionId FROM gc_room_agents WHERE roomId = ? AND agentId = ?')
        for (const plan of plans) {
            const target = getTarget.get(roomId, plan.targetAgentId) as { sessionId?: string } | undefined
            if (!target || String(target.sessionId || '') !== plan.targetSessionId) {
                throw new Error(`Handoff target participant ${plan.targetAgentId} is missing or stale`)
            }
            insert.run(
                this.handoffJobId(sourceMessageId, plan.targetAgentId), roomId, plan.chainId, sourceMessageId,
                plan.targetAgentId, plan.targetSessionId, normalizeMentionDepth(plan.depth), plan.kind, now, now, now,
            )
        }
        return (db.prepare(
            'SELECT * FROM gc_handoff_jobs WHERE sourceMessageId = ? ORDER BY targetAgentId'
        ).all(sourceMessageId) as any[]).map(row => this.mapHandoffJob(row))
    }

    recoverInterruptedHandoffJobs(owner: string, now = Date.now()): number {
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_jobs
             SET status = 'interrupted', availableAt = 0, leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
                 lastError = 'Dispatcher stopped after the agent run may have started; automatic replay was blocked',
                 updatedAt = ?, completedAt = ?
             WHERE status = 'running' AND leaseOwner <> ? AND leaseExpiresAt <= ?`
        ).run(now, now, owner, now)
        return Number(result?.changes || 0)
    }

    claimHandoffJobs(owner: string, now = Date.now(), limit = 10, leaseMs = 10 * 60_000): GroupHandoffJob[] {
        const db = this.db()
        if (!db || !owner || limit <= 0) return []
        const claimed: GroupHandoffJob[] = []
        this.withImmediateTransaction(db, () => {
            const rows = db.prepare(
                `SELECT job.id
                 FROM gc_handoff_jobs AS job
                 WHERE job.status = 'pending' AND job.availableAt <= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM gc_handoff_jobs AS active
                       WHERE active.roomId = job.roomId
                         AND active.targetAgentId = job.targetAgentId
                         AND active.status = 'running'
                   )
                   AND job.id = (
                       SELECT queued.id FROM gc_handoff_jobs AS queued
                       WHERE queued.roomId = job.roomId
                         AND queued.targetAgentId = job.targetAgentId
                         AND queued.status = 'pending' AND queued.availableAt <= ?
                       ORDER BY queued.createdAt ASC, queued.id ASC LIMIT 1
                   )
                 ORDER BY job.createdAt ASC, job.id ASC LIMIT ?`
            ).all(now, now, Math.max(1, Math.floor(limit))) as Array<{ id: string }>
            const update = db.prepare(
                `UPDATE gc_handoff_jobs
                 SET status = 'running', attemptCount = attemptCount + 1,
                     leaseOwner = ?, leaseToken = ?, leaseExpiresAt = ?, updatedAt = ?
                 WHERE id = ? AND status = 'pending'`
            )
            for (const row of rows) {
                const leaseToken = randomBytes(16).toString('hex')
                const result = update.run(owner, leaseToken, now + Math.max(1, leaseMs), now, row.id)
                if (!result.changes) continue
                const job = this.getHandoffJob(row.id)
                if (job) claimed.push(job)
            }
        })
        return claimed
    }

    renewHandoffLease(jobId: string, leaseToken: string, owner: string, now = Date.now(), leaseMs = 60_000): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_jobs SET leaseExpiresAt = ?, updatedAt = ?
             WHERE id = ? AND status = 'running' AND leaseToken = ? AND leaseOwner = ?`
        ).run(now + Math.max(1, leaseMs), now, jobId, leaseToken, owner)
        return Boolean(result?.changes)
    }

    cancelHandoffJobs(roomId: string, targetAgentId?: string, reason = 'Cancelled by user'): number {
        const now = Date.now()
        const targetClause = targetAgentId ? ' AND targetAgentId = ?' : ''
        const params = targetAgentId
            ? [reason.slice(0, 2000), now, now, roomId, targetAgentId]
            : [reason.slice(0, 2000), now, now, roomId]
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_jobs
             SET status = 'cancelled', leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
                 lastError = ?, updatedAt = ?, completedAt = ?
             WHERE roomId = ?${targetClause} AND status IN ('pending', 'running')`
        ).run(...params)
        return Number(result?.changes || 0)
    }

    rescheduleHandoffJobWithoutAttempt(jobId: string, leaseToken: string, error: string, retryAt: number): boolean {
        const now = Date.now()
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_jobs
             SET status = 'pending', attemptCount = MAX(0, attemptCount - 1), availableAt = ?,
                 leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
                 lastError = ?, updatedAt = ?, completedAt = 0
             WHERE id = ? AND status = 'running' AND leaseToken = ?`
        ).run(retryAt, error.slice(0, 2000), now, jobId, leaseToken)
        return Boolean(result?.changes)
    }

    markHandoffJobFailed(jobId: string, leaseToken: string, error: string, retryAt: number, maxAttempts = 3): boolean {
        const job = this.getHandoffJob(jobId)
        if (!job || job.status !== 'running' || job.leaseToken !== leaseToken) return false
        const terminal = job.attemptCount >= maxAttempts
        const now = Date.now()
        const result = this.db()?.prepare(
            `UPDATE gc_handoff_jobs
             SET status = ?, availableAt = ?, leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
                 lastError = ?, updatedAt = ?, completedAt = ?
             WHERE id = ? AND status = 'running' AND leaseToken = ?`
        ).run(terminal ? 'failed' : 'pending', terminal ? 0 : retryAt, error.slice(0, 2000), now, terminal ? now : 0, jobId, leaseToken)
        return Boolean(result?.changes)
    }

    addMessage(msg: ChatMessage): void {
        this.upsertMessage(msg)
    }

    upsertMessage(msg: ChatMessage): void {
        const db = this.db()
        if (!db) return
        const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
        this.withImmediateTransaction(db, () => {
            const existing = db.prepare('SELECT roomId, roomSeq FROM gc_messages WHERE id = ?').get(msg.id) as { roomId: string; roomSeq: number } | undefined
            let roomSeq = existing?.roomId === msg.roomId ? Number(existing.roomSeq || 0) : 0
            if (roomSeq <= 0) {
                const allocated = db.prepare(
                    `UPDATE gc_rooms
                     SET messageSeq = MAX(
                       messageSeq,
                       (SELECT COALESCE(MAX(roomSeq), 0) FROM gc_messages WHERE roomId = ?)
                     ) + 1
                     WHERE id = ?
                     RETURNING messageSeq`
                ).get(msg.roomId, msg.roomId) as { messageSeq: number } | undefined
                if (!allocated) throw new Error(`Cannot persist group message for missing room ${msg.roomId}`)
                roomSeq = Number(allocated.messageSeq)
            }
            db.prepare(
                `INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content, handoffChainId, handoffDepth, sourceHandoffJobId, roomSeq)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                + ` ON CONFLICT(id) DO UPDATE SET
                    roomId = excluded.roomId,
                    senderId = excluded.senderId,
                    senderName = excluded.senderName,
                    content = excluded.content,
                    timestamp = excluded.timestamp,
                    role = excluded.role,
                    tool_call_id = excluded.tool_call_id,
                    tool_calls = excluded.tool_calls,
                    tool_name = excluded.tool_name,
                    finish_reason = excluded.finish_reason,
                    reasoning = excluded.reasoning,
                    reasoning_details = excluded.reasoning_details,
                    reasoning_content = excluded.reasoning_content,
                    handoffChainId = excluded.handoffChainId,
                    handoffDepth = excluded.handoffDepth,
                    sourceHandoffJobId = excluded.sourceHandoffJobId,
                    roomSeq = excluded.roomSeq`
            ).run(
                msg.id, msg.roomId, msg.senderId, msg.senderName, messageContentForStorage(msg.role, msg.content), msg.timestamp,
                msg.role || 'user',
                msg.tool_call_id ?? null,
                toolCallsJson,
                msg.tool_name ?? null,
                msg.finish_reason ?? null,
                msg.reasoning ?? null,
                msg.reasoning_details ?? null,
                msg.reasoning_content ?? null,
                msg.handoffChainId || '',
                normalizeMentionDepth(msg.handoffDepth),
                msg.sourceHandoffJobId || '',
                roomSeq,
            )
        })
    }

    saveWorkspaceDiffMessageForRun(args: SaveWorkspaceDiffMessageArgs): { message: ChatMessage; totalTokens: number; change: WorkspaceRunChangeSummary } | null {
        const db = this.db()
        if (!db) return null
        const idPrefix = 'gcmsg_workspace_diff_'
        const runIdPart = args.runId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-64) || 'run'
        const roomIdBudget = Math.max(24, 180 - idPrefix.length - runIdPart.length - 1)
        const roomIdPart = args.roomId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, roomIdBudget) || 'room'
        const messageId = `${idPrefix}${roomIdPart}_${runIdPart}`
        db.exec('BEGIN IMMEDIATE')
        try {
            const roomExists = db.prepare('SELECT 1 FROM gc_rooms WHERE id = ?').get(args.roomId)
            if (!roomExists) {
                db.exec('ROLLBACK')
                return null
            }
            const workspaceLabel = basename(args.workspace) || 'workspace'
            const redactedDraft: SaveWorkspaceRunChangeInput = {
                ...args.draft,
                room_id: args.roomId,
                message_id: messageId,
                assistant_message_id: args.parentMessageId || '',
                workspace: workspaceLabel,
            }
            const change = insertWorkspaceRunChange(db, redactedDraft)
            if (!change) {
                db.exec('ROLLBACK')
                return null
            }
            const files = change.files.map((file) => {
                const draftFile = redactedDraft.files.find(candidate => candidate.path === file.path && candidate.change_type === file.change_type)
                return {
                    id: file.id,
                    path: file.path,
                    change_type: file.change_type,
                    additions: file.additions,
                    deletions: file.deletions,
                    patch: draftFile?.patch || null,
                    binary: file.binary,
                    truncated: file.truncated,
                }
            })
            const payload = {
                kind: 'workspace_diff',
                version: 1,
                room_id: args.roomId,
                session_id: args.sessionId,
                run_id: args.runId,
                status: args.status,
                change_id: change.change_id,
                workspace_basename: workspaceLabel,
                files_changed: change.files_changed,
                additions: change.additions,
                deletions: change.deletions,
                truncated: change.truncated,
                files,
                ...(args.parentMessageId ? { parent_message_id: args.parentMessageId } : {}),
            }
            const message: ChatMessage = {
                id: messageId,
                roomId: args.roomId,
                senderId: args.senderId,
                senderName: args.senderName,
                content: JSON.stringify(payload),
                timestamp: Date.now(),
                role: 'tool',
                tool_call_id: `workspace_diff:${args.runId}`,
                tool_calls: null,
                tool_name: 'workspace_diff',
            }
            this.upsertMessage(message)
            const retention = this.pruneMessages(args.roomId)
            this.notifyRetentionBlocked(args.roomId, retention)
            const messages = this.getMessagesForContext(args.roomId)
            const totalTokens = this.estimateRoomTotalTokens(args.roomId, messages)
            this.updateRoomTotalTokens(args.roomId, totalTokens)
            db.exec('COMMIT')
            return { message, totalTokens, change }
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    saveMessageAndRefreshRoom(
        msg: ChatMessage,
        options: { handoffs?: GroupHandoffPlan[] } = {},
    ): { message: ChatMessage; totalTokens: number; handoffJobs: GroupHandoffJob[] } {
        const db = this.db()
        if (!db) return { message: msg, totalTokens: 0, handoffJobs: [] }
        db.exec('BEGIN IMMEDIATE')
        try {
            const existing = this.getMessage(msg.id)
            if (existing?.tool_name === 'workspace_diff') {
                const messages = this.getMessagesForContext(existing.roomId)
                const totalTokens = this.estimateRoomTotalTokens(existing.roomId, messages)
                db.exec('COMMIT')
                return { message: existing, totalTokens, handoffJobs: [] }
            }
            if (existing) {
                const linkedHandoffCount = Number((db.prepare(
                    'SELECT COUNT(*) AS total FROM gc_handoff_jobs WHERE sourceMessageId = ? OR id = ?'
                ).get(existing.id, existing.sourceHandoffJobId || '') as { total?: number } | undefined)?.total || 0)
                const protectedByHandoff = linkedHandoffCount > 0 || Boolean(existing.sourceHandoffJobId)
                if (protectedByHandoff) {
                    const incomingContent = messageContentForStorage(msg.role, contentToStorageString(msg.content))
                    const sameMessage = existing.roomId === msg.roomId &&
                        existing.senderId === msg.senderId &&
                        existing.senderName === msg.senderName &&
                        existing.role === (msg.role || 'user') &&
                        existing.content === incomingContent &&
                        String(existing.tool_name || '') === String(msg.tool_name || '') &&
                        String(existing.handoffChainId || '') === String(msg.handoffChainId || '') &&
                        normalizeMentionDepth(existing.handoffDepth) === normalizeMentionDepth(msg.handoffDepth) &&
                        String(existing.sourceHandoffJobId || '') === String(msg.sourceHandoffJobId || '')
                    if (!sameMessage) throw new Error(`Group message id conflict for ${msg.id}`)
                    const messages = this.getMessagesForContext(existing.roomId)
                    const totalTokens = this.estimateRoomTotalTokens(existing.roomId, messages)
                    const handoffJobs = this.listHandoffJobs(existing.roomId, 500).filter(job => job.sourceMessageId === existing.id)
                    db.exec('COMMIT')
                    return { message: existing, totalTokens, handoffJobs }
                }
            }
            const safeMsg = msg.tool_name === 'workspace_diff'
                ? { ...msg, role: 'user', tool_call_id: null, tool_calls: null, tool_name: null }
                : msg
            const message = safeMsg
            this.upsertMessage(message)
            if (message.handoffFinal && message.sourceHandoffJobId) {
                const failed = message.finish_reason === 'error'
                const completed = db.prepare(
                    `UPDATE gc_handoff_jobs
                     SET status = ?, leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
                         lastError = ?, updatedAt = ?, completedAt = ?
                     WHERE id = ? AND status = 'running' AND leaseToken = ? AND targetAgentId = ? AND targetSessionId = ?`
                ).run(
                    failed ? 'failed' : 'completed', failed ? contentToText(message.content).slice(0, 2000) : '',
                    message.timestamp, message.timestamp, message.sourceHandoffJobId,
                    message.sourceHandoffLeaseToken || '', message.senderId, message.agentSessionId || '',
                )
                if (!completed.changes) throw new Error(`Handoff completion rejected for ${message.sourceHandoffJobId}`)
            }
            const handoffJobs = this.upsertHandoffJobs(msg.roomId, message.id, options.handoffs || [], message.timestamp)
            const retention = this.pruneMessages(msg.roomId)
            this.notifyRetentionBlocked(msg.roomId, retention)
            const messages = this.getMessagesForContext(msg.roomId)
            const totalTokens = this.estimateRoomTotalTokens(msg.roomId, messages)
            this.updateRoomTotalTokens(msg.roomId, totalTokens)
            db.exec('COMMIT')
            return { message, totalTokens, handoffJobs }
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    private deleteWorkspaceDiffChanges(roomId: string, throughRoomSeq?: number): void {
        const db = this.db()
        if (!db) return
        deleteWorkspaceRunChangesForRoom(db, roomId, throughRoomSeq)
    }

    private withImmediateTransaction<T>(
        db: DatabaseSync & { readonly inTransaction?: boolean; readonly isTransaction?: boolean },
        fn: () => T,
    ): T {
        if (db.inTransaction || db.isTransaction) {
            return fn()
        }
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = fn()
            db.exec('COMMIT')
            return result
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    clearRoomContext(roomId: string): void {
        const db = this.db()
        if (!db) return
        const contextBaseline = Math.max(0, Math.floor(Number(this.getRoom(roomId)?.messageSeq) || 0))
        this.withImmediateTransaction(db, () => {
            this.deleteWorkspaceDiffChanges(roomId)
            db.prepare('DELETE FROM gc_handoff_jobs WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
            db.prepare('UPDATE gc_rooms SET totalTokens = 0, sessionSeed = ? WHERE id = ?').run(this.newRoomSessionSeed(), roomId)
        })
    }

    pruneMessages(roomId: string, keep = 500): { pruned: number; blockedAgentIds: string[]; throughRoomSeq: number } {
        const db = this.db()
        if (!db) return { pruned: 0, blockedAgentIds: [], throughRoomSeq: 0 }
        const normalizedKeep = Math.max(1, Math.floor(Number(keep) || 0))
        const count = Number((db.prepare('SELECT COUNT(*) as c FROM gc_messages WHERE roomId = ?').get(roomId) as any)?.c || 0)
        if (count <= normalizedKeep) return { pruned: 0, blockedAgentIds: [], throughRoomSeq: 0 }

        const boundary = db.prepare(
            `SELECT roomSeq, timestamp
             FROM gc_messages
             WHERE roomId = ? AND roomSeq > 0
             ORDER BY roomSeq DESC
             LIMIT 1 OFFSET ?`
        ).get(roomId, normalizedKeep - 1) as { roomSeq: number; timestamp: number } | undefined
        if (!boundary?.roomSeq) return { pruned: 0, blockedAgentIds: [], throughRoomSeq: 0 }
        let throughRoomSeq = Math.max(0, Math.floor(Number(boundary.roomSeq) || 0) - 1)
        const activeHandoff = db.prepare(
            `SELECT MIN(message.roomSeq) AS minRoomSeq
             FROM gc_handoff_jobs AS job
             JOIN gc_messages AS message ON message.id = job.sourceMessageId AND message.roomId = job.roomId
             WHERE job.roomId = ? AND job.status IN ('pending', 'running')`
        ).get(roomId) as { minRoomSeq?: number | null } | undefined
        const activeHandoffRoomSeq = Math.max(0, Math.floor(Number(activeHandoff?.minRoomSeq) || 0))
        if (activeHandoffRoomSeq > 0) throughRoomSeq = Math.min(throughRoomSeq, activeHandoffRoomSeq - 1)
        if (throughRoomSeq <= 0) return { pruned: 0, blockedAgentIds: [], throughRoomSeq: 0 }
        const semanticBoundary = db.prepare(
            `SELECT COALESCE(MAX(roomSeq), 0) AS roomSeq
             FROM gc_messages
             WHERE roomId = ? AND roomSeq > 0 AND roomSeq <= ?
               AND COALESCE(tool_name, '') <> 'workspace_diff'`
        ).get(roomId, throughRoomSeq) as { roomSeq: number } | undefined
        const coverageRoomSeq = Math.max(0, Math.floor(Number(semanticBoundary?.roomSeq) || 0))

        const sharedSnapshot = this.getContextSnapshot(roomId)
        const sharedSnapshotCovered = coverageRoomSeq <= 0 || Boolean(
            sharedSnapshot?.summary &&
            Math.max(0, Math.floor(Number(sharedSnapshot.lastRoomSeq) || 0)) >= coverageRoomSeq,
        )
        const blockedAgentIds = [
            ...(sharedSnapshotCovered ? [] : ['__room_snapshot__']),
            ...this.getRoomAgents(roomId)
                .filter(agent => agent.runtime === 'coding_agent')
                .filter((agent) => {
                    const lastSeen = Math.max(0, Math.floor(Number(agent.lastSeenRoomSeq) || 0))
                    if (lastSeen >= coverageRoomSeq) return false
                    const checkpointFrom = Math.max(0, Math.floor(Number(agent.checkpointFromRoomSeq) || 0))
                    const checkpointThrough = Math.max(0, Math.floor(Number(agent.checkpointThroughRoomSeq) || 0))
                    return !agent.checkpoint || checkpointFrom > lastSeen + 1 || checkpointThrough < coverageRoomSeq
                })
                .map(agent => agent.agentId),
        ]
        if (blockedAgentIds.length > 0) {
            logger.info({ roomId, count, keep: normalizedKeep, throughRoomSeq, coverageRoomSeq, blockedAgentIds }, '[GroupChat] retention prune blocked pending participant checkpoints')
            return { pruned: 0, blockedAgentIds, throughRoomSeq: coverageRoomSeq }
        }

        let pruned = 0
        this.withImmediateTransaction(db, () => {
            this.deleteWorkspaceDiffChanges(roomId, throughRoomSeq)
            db.prepare(
                `DELETE FROM gc_handoff_jobs
                 WHERE roomId = ? AND status NOT IN ('pending', 'running')
                   AND sourceMessageId IN (
                     SELECT id FROM gc_messages WHERE roomId = ? AND roomSeq > 0 AND roomSeq <= ?
                   )`
            ).run(roomId, roomId, throughRoomSeq)
            const result = db.prepare(
                'DELETE FROM gc_messages WHERE roomId = ? AND roomSeq > 0 AND roomSeq <= ?'
            ).run(roomId, throughRoomSeq)
            pruned = Number(result.changes || 0)
            db.prepare(
                'UPDATE gc_rooms SET prunedThroughRoomSeq = MAX(prunedThroughRoomSeq, ?) WHERE id = ?'
            ).run(throughRoomSeq, roomId)
            const retainedMessages = this.getMessagesForContext(roomId)
            this.updateRoomTotalTokens(roomId, this.estimateRoomTotalTokens(roomId, retainedMessages))
            logger.info(`[GroupChat] pruned ${pruned} messages from room ${roomId} (had ${count}, keeping ${normalizedKeep})`)
        })
        return { pruned, blockedAgentIds: [], throughRoomSeq }
    }

    // ─── Room Agents ──────────────────────────────────────────

    getRoomAgents(roomId: string): RoomAgent[] {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited, runtime, codingAgentId, sessionId, sessionGeneration, mode, provider, model, apiMode, reasoningEffort, avatar, lastSeenRoomSeq, lastSuccessfulRunId, checkpoint, checkpointSourceMessageIds, checkpointFromRoomSeq, checkpointThroughRoomSeq FROM gc_room_agents WHERE roomId = ?'
        ).all(roomId) || []) as unknown as RoomAgent[]
    }

    addRoomAgent(roomId: string, agentId: string, profile: string, name: string, description: string, invited: number): RoomAgent {
        const id = randomBytes(12).toString('hex')
        const db = this.db()
        if (!db) return { id, roomId, agentId, profile, name, description, invited }
        this.withImmediateTransaction(db, () => {
            const createdAt = Date.now()
            db.prepare(
                'INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(id, roomId, agentId, profile, name, description, invited, createdAt)
            this.ensureAgentActor(roomId, agentId, name, description)
            this.incrementRoomAuthorizationRevision(roomId)
        })
        return { id, roomId, agentId, profile, name, description, invited }
    }

    getRoomAgent(roomId: string, agentRef: string): RoomAgent | null {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited, runtime, codingAgentId, sessionId, sessionGeneration, mode, provider, model, apiMode, reasoningEffort, avatar, lastSeenRoomSeq, lastSuccessfulRunId, checkpoint, checkpointSourceMessageIds, checkpointFromRoomSeq, checkpointThroughRoomSeq FROM gc_room_agents WHERE roomId = ? AND (id = ? OR agentId = ?)'
        ).get(roomId, agentRef, agentRef) as any) ?? null
    }

    getRoomAgentByAgentId(roomId: string, agentId: string): RoomAgent | null {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited, runtime, codingAgentId, sessionId, sessionGeneration, mode, provider, model, apiMode, reasoningEffort, avatar, lastSeenRoomSeq, lastSuccessfulRunId, checkpoint, checkpointSourceMessageIds, checkpointFromRoomSeq, checkpointThroughRoomSeq FROM gc_room_agents WHERE roomId = ? AND agentId = ?'
        ).get(roomId, agentId) as any) ?? null
    }

    updateRoomAgent(roomId: string, agentRef: string, patch: Pick<RoomAgent, 'name' | 'description' | 'mode' | 'provider' | 'model' | 'apiMode' | 'reasoningEffort' | 'avatar'>): RoomAgent | null {
        this.db()?.prepare(
            `UPDATE gc_room_agents
             SET name = ?, description = ?, mode = ?, provider = ?, model = ?, apiMode = ?, reasoningEffort = ?, avatar = ?
             WHERE roomId = ? AND (id = ? OR agentId = ?)`
        ).run(
            patch.name,
            patch.description,
            patch.mode,
            patch.provider,
            patch.model,
            patch.apiMode,
            patch.reasoningEffort,
            patch.avatar,
            roomId,
            agentRef,
            agentRef,
        )
        return this.getRoomAgent(roomId, agentRef)
    }

    saveParticipantCheckpointIfCurrent(args: {
        roomId: string
        agentId: string
        expectedSessionSeed: string
        expectedLastSeenRoomSeq: number
        expectedSessionGeneration: number
        summary: string
        sourceMessageIds: string[]
        fromRoomSeq: number
        throughRoomSeq: number
    }): boolean {
        const result = this.db()?.prepare(
            `UPDATE gc_room_agents
             SET checkpoint = ?, checkpointSourceMessageIds = ?, checkpointFromRoomSeq = ?, checkpointThroughRoomSeq = ?
             WHERE roomId = ? AND agentId = ? AND runtime = 'coding_agent'
               AND lastSeenRoomSeq = ? AND sessionGeneration = ?
               AND EXISTS (SELECT 1 FROM gc_rooms r WHERE r.id = gc_room_agents.roomId AND r.sessionSeed = ?)`
        ).run(
            args.summary,
            JSON.stringify(args.sourceMessageIds),
            Math.max(0, Math.floor(Number(args.fromRoomSeq) || 0)),
            Math.max(0, Math.floor(Number(args.throughRoomSeq) || 0)),
            args.roomId,
            args.agentId,
            Math.max(0, Math.floor(Number(args.expectedLastSeenRoomSeq) || 0)),
            Math.max(0, Math.floor(Number(args.expectedSessionGeneration) || 0)),
            args.expectedSessionSeed,
        )
        return Number(result?.changes || 0) === 1
    }

    updateRoomAgentContinuity(
        roomId: string,
        agentId: string,
        patch: {
            lastSeenRoomSeq: number
            lastSuccessfulRunId: string
            checkpoint?: string
            checkpointSourceMessageIds?: string
            checkpointFromRoomSeq?: number
            checkpointThroughRoomSeq?: number
        },
    ): RoomAgent | null {
        const lastSeenRoomSeq = Math.max(0, Math.floor(Number(patch.lastSeenRoomSeq) || 0))
        this.db()?.prepare(
            `UPDATE gc_room_agents
             SET lastSeenRoomSeq = ?, lastSuccessfulRunId = ?,
                 checkpoint = CASE
                   WHEN ? IS NOT NULL THEN ?
                   WHEN ? >= checkpointThroughRoomSeq THEN ''
                   ELSE checkpoint
                 END,
                 checkpointSourceMessageIds = CASE
                   WHEN ? IS NOT NULL THEN ?
                   WHEN ? >= checkpointThroughRoomSeq THEN '[]'
                   ELSE checkpointSourceMessageIds
                 END,
                 checkpointFromRoomSeq = CASE
                   WHEN ? IS NOT NULL THEN ?
                   WHEN ? >= checkpointThroughRoomSeq THEN 0
                   ELSE checkpointFromRoomSeq
                 END,
                 checkpointThroughRoomSeq = CASE
                   WHEN ? IS NOT NULL THEN ?
                   WHEN ? >= checkpointThroughRoomSeq THEN 0
                   ELSE checkpointThroughRoomSeq
                 END
             WHERE roomId = ? AND agentId = ?`
        ).run(
            lastSeenRoomSeq,
            patch.lastSuccessfulRunId,
            patch.checkpoint ?? null, patch.checkpoint ?? '', lastSeenRoomSeq,
            patch.checkpointSourceMessageIds ?? null, patch.checkpointSourceMessageIds ?? '[]', lastSeenRoomSeq,
            patch.checkpointFromRoomSeq ?? null, Math.max(0, Math.floor(Number(patch.checkpointFromRoomSeq) || 0)), lastSeenRoomSeq,
            patch.checkpointThroughRoomSeq ?? null, Math.max(0, Math.floor(Number(patch.checkpointThroughRoomSeq) || 0)), lastSeenRoomSeq,
            roomId,
            agentId,
        )
        return this.getRoomAgentByAgentId(roomId, agentId)
    }

    removeRoomAgent(roomId: string, agentRef: string): void {
        const db = this.db()
        if (!db) return
        this.withImmediateTransaction(db, () => {
            const agent = db.prepare(
                'SELECT agentId FROM gc_room_agents WHERE roomId = ? AND (id = ? OR agentId = ?)'
            ).get(roomId, agentRef, agentRef) as { agentId?: string } | undefined
            if (!agent?.agentId) return
            const now = Date.now()
            db.prepare(
                `UPDATE gc_handoff_jobs SET status = 'cancelled', leaseOwner = '', leaseToken = '', leaseExpiresAt = 0,
                 lastError = 'Target participant was removed', updatedAt = ?, completedAt = ?
                 WHERE roomId = ? AND targetAgentId = ? AND status IN ('pending', 'running')`
            ).run(now, now, roomId, agent.agentId)
            db.prepare('DELETE FROM gc_room_agents WHERE roomId = ? AND agentId = ?').run(roomId, agent.agentId)
            const room = this.getRoom(roomId)
            const order = parseFixedHandoffOrder(room?.handoffOrderJson, this.getRoomAgents(roomId)).map(item => item.agentId)
            if (room?.handoffMode === 'fixed' && order.length < 2) {
                db.prepare("UPDATE gc_rooms SET handoffMode = 'mentions', handoffOrderJson = '[]' WHERE id = ?").run(roomId)
            } else if (room?.handoffMode === 'fixed') {
                db.prepare('UPDATE gc_rooms SET handoffOrderJson = ? WHERE id = ?').run(JSON.stringify(order), roomId)
            }
        })
    }

    // ─── Context Snapshots ──────────────────────────────────

    getContextSnapshot(roomId: string): { roomId: string; summary: string; lastMessageId: string; lastMessageTimestamp: number; lastRoomSeq: number; updatedAt: number } | null {
        return (this.db()?.prepare(
            'SELECT roomId, summary, lastMessageId, lastMessageTimestamp, lastRoomSeq, updatedAt FROM gc_context_snapshots WHERE roomId = ?'
        ).get(roomId) as any) ?? null
    }

    saveContextSnapshot(roomId: string, summary: string, lastMessageId: string, lastMessageTimestamp: number, lastRoomSeq = 0): void {
        this.db()?.prepare(
            `INSERT INTO gc_context_snapshots (roomId, summary, lastMessageId, lastMessageTimestamp, lastRoomSeq, updatedAt)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(roomId) DO UPDATE SET
               summary = excluded.summary,
               lastMessageId = excluded.lastMessageId,
               lastMessageTimestamp = excluded.lastMessageTimestamp,
               lastRoomSeq = excluded.lastRoomSeq,
               updatedAt = excluded.updatedAt`
        ).run(roomId, summary, lastMessageId, lastMessageTimestamp, Math.max(0, Math.floor(Number(lastRoomSeq) || 0)), Date.now())
    }

    saveContextSnapshotIfCurrent(args: {
        roomId: string
        expectedSessionSeed: string
        expectedLastRoomSeq: number
        summary: string
        lastMessageId: string
        lastMessageTimestamp: number
        lastRoomSeq: number
    }): boolean {
        const db = this.db()
        if (!db) return false
        let saved = false
        this.withImmediateTransaction(db, () => {
            const room = db.prepare('SELECT sessionSeed FROM gc_rooms WHERE id = ?').get(args.roomId) as { sessionSeed: string } | undefined
            if (!room || String(room.sessionSeed || '') !== args.expectedSessionSeed) return
            const current = db.prepare(
                'SELECT lastRoomSeq FROM gc_context_snapshots WHERE roomId = ?'
            ).get(args.roomId) as { lastRoomSeq: number } | undefined
            if (Math.max(0, Number(current?.lastRoomSeq || 0)) !== Math.max(0, Number(args.expectedLastRoomSeq || 0))) return
            this.saveContextSnapshot(
                args.roomId,
                args.summary,
                args.lastMessageId,
                args.lastMessageTimestamp,
                args.lastRoomSeq,
            )
            saved = true
        })
        return saved
    }

    deleteContextSnapshot(roomId: string): void {
        this.db()?.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
    }

    deleteRoom(roomId: string): void {
        const db = this.db()
        if (!db) return
        this.withImmediateTransaction(db, () => {
            const sessions = db.prepare(
                'SELECT session_id, profile_name FROM gc_session_profiles WHERE room_id = ?'
            ).all(roomId) as Array<{ session_id: string; profile_name: string }>
            for (const session of sessions) {
                this.enqueuePendingSessionDelete(session.session_id, session.profile_name)
            }
            this.deleteWorkspaceDiffChanges(roomId)
            db.prepare('DELETE FROM gc_handoff_jobs WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_session_profiles WHERE room_id = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_actor_capabilities WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_actors WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_agents WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_members WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_rooms WHERE id = ?').run(roomId)
        })
    }

    // ─── Room Members ──────────────────────────────────────

    getRoomMembers(roomId: string): { id: string; userId: string; name: string; description: string; joinedAt: number; avatar: string }[] {
        const members = (this.db()?.prepare(
            `SELECT m.id, m.userId, m.userName as name, m.description, m.joinedAt, m.avatar, m.authUserId
             FROM gc_room_members m
             WHERE m.roomId = ?
               AND NOT EXISTS (
                 SELECT 1 FROM gc_room_agents a
                 WHERE a.roomId = m.roomId
                   AND (a.agentId = m.userId OR (m.userId NOT GLOB '????????-????-????-????-????????????' AND COALESCE(m.description, '') = '' AND a.name = m.userName))
               )
             ORDER BY m.joinedAt`
        ).all(roomId) || []) as unknown as {
            id: string
            userId: string
            name: string
            description: string
            joinedAt: number
            avatar: string
            authUserId?: number | null
        }[]

        for (const member of members) {
            try {
                if (typeof member.authUserId === 'number' && member.authUserId > 0) {
                    member.avatar = getUserAvatar(member.authUserId) || member.avatar || ''
                } else if (member.name) {
                    const user = findUserByUsername(member.name)
                    if (user?.avatar) member.avatar = user.avatar
                }
            } catch {
                // ignore individual lookup failures
            }
        }
        return members.map(({ authUserId: _authUserId, ...member }) => member)
    }

    removeRoomMembersForAgent(roomId: string, agent: Pick<RoomAgent, 'agentId' | 'name'>): void {
        this.db()?.prepare(
            `DELETE FROM gc_room_members
             WHERE roomId = ?
               AND (userId = ? OR (userId NOT GLOB '????????-????-????-????-????????????' AND COALESCE(description, '') = '' AND userName = ?))`
        ).run(roomId, agent.agentId, agent.name)
    }

    addRoomMember(roomId: string, userId: string, userName: string, description: string, avatar: string = '', authUserId?: number): void {
        let resolvedAvatar = avatar
        if (!resolvedAvatar && typeof authUserId === 'number' && authUserId > 0) {
            try {
                resolvedAvatar = getUserAvatar(authUserId) || ''
            } catch {
                // ignore lookup failures
            }
        }
        if (!resolvedAvatar && userName) {
            try {
                const user = findUserByUsername(userName)
                if (user) resolvedAvatar = user.avatar || ''
            } catch {
                // ignore lookup failures
            }
        }

        const existing = this.getMemberByUserId(roomId, userId) ||
            (typeof authUserId === 'number' && authUserId > 0 ? this.getMemberByAuthUserId(roomId, authUserId) : null)
        if (existing) {
            const nextAvatar = resolvedAvatar || existing.avatar || ''
            const nextAuthUserId = typeof authUserId === 'number' && authUserId > 0
                ? authUserId
                : existing.authUserId ?? null
            // Update name/description/avatar on rejoin, refresh updatedAt
            this.db()?.prepare(
                'UPDATE gc_room_members SET userId = ?, userName = ?, description = ?, avatar = ?, authUserId = ?, updatedAt = ? WHERE id = ?'
            ).run(userId, userName, description, nextAvatar, nextAuthUserId, Date.now(), existing.id)
            return
        }
        const id = `gcm_${randomBytes(16).toString('hex')}`
        const now = Date.now()
        this.db()?.prepare(
            'INSERT INTO gc_room_members (id, roomId, userId, userName, description, joinedAt, updatedAt, avatar, authUserId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, roomId, userId, userName, description, now, now, resolvedAvatar, authUserId ?? null)
    }

    getMemberByUserId(roomId: string, userId: string): Member | null {
        return (this.db()?.prepare(
            'SELECT id, userId, userName as name, description, joinedAt, avatar, authUserId FROM gc_room_members WHERE roomId = ? AND userId = ?'
        ).get(roomId, userId) as any) ?? null
    }

    getMemberByAuthUserId(roomId: string, authUserId: number): Member | null {
        return (this.db()?.prepare(
            'SELECT id, userId, userName as name, description, joinedAt, avatar, authUserId FROM gc_room_members WHERE roomId = ? AND authUserId = ? ORDER BY updatedAt DESC LIMIT 1'
        ).get(roomId, authUserId) as any) ?? null
    }

    admitHumanMember(args: HumanRoomAdmissionArgs): HumanRoomAdmissionResult {
        const db = this.db()
        const authUserId = typeof args.authUser?.id === 'number' && args.authUser.id > 0
            ? Math.floor(args.authUser.id)
            : null
        const localSubjectId = typeof args.localSubjectId === 'string' && args.localSubjectId.trim()
            ? args.localSubjectId.trim()
            : null
        const fallbackExistingMember = this.getMemberByUserId(args.roomId, args.userId)
            || (authUserId !== null ? this.getMemberByAuthUserId(args.roomId, authUserId) : null)

        const finalizeMember = (room: RoomInfo, existingMember: Member | null): AdmittedHumanRoomAdmission => {
            const userName = args.requestedName || existingMember?.name || `User-${args.userId.slice(0, 6)}`
            const description = args.requestedDescription || existingMember?.description || ''
            const avatar = args.avatar || existingMember?.avatar || ''
            return {
                status: 'admitted',
                room,
                userName,
                description,
                avatar,
            }
        }

        if (!db) {
            const room = this.getRoom(args.roomId)
            if (!room) {
                return { status: 'not_found' }
            }
            const existingMember = fallbackExistingMember
            const inviteMatches = groupChatInviteCodeMatches(args.inviteCode, room.inviteCode)
            if (args.authUser) {
                const subject = createAuthenticatedGroupChatSubject(args.authUser)
                const canRead = subject ? evaluateGroupChatAccessPolicy(this, args.roomId, subject).canRead : false
                if (!existingMember && !canRead && !inviteMatches) {
                    return { status: 'not_found' }
                }
                const admitted = finalizeMember(room, existingMember)
                this.addRoomMember(args.roomId, args.userId, admitted.userName, admitted.description, admitted.avatar, authUserId ?? undefined)
                return admitted
            }
            if (!localSubjectId) {
                return { status: 'not_found' }
            }
            const canRead = !room.inviteCode
                || inviteMatches
                || evaluateGroupChatAccessPolicy(this, args.roomId, createLocalGroupChatSubject(localSubjectId)).canRead
            if (!canRead) {
                return { status: 'not_found' }
            }
            const admitted = finalizeMember(room, existingMember)
            this.addRoomMember(args.roomId, args.userId, admitted.userName, admitted.description, admitted.avatar)
            return admitted
        }

        return this.withImmediateTransaction(db, () => {
            const room = this.getRoom(args.roomId)
            if (!room) {
                return { status: 'not_found' } satisfies HumanRoomAdmissionResult
            }
            const existingMember = this.getMemberByUserId(args.roomId, args.userId)
                || (authUserId !== null ? this.getMemberByAuthUserId(args.roomId, authUserId) : null)
            const admitted = finalizeMember(room, existingMember)
            const inviteMatches = groupChatInviteCodeMatches(args.inviteCode, room.inviteCode)

            if (args.authUser) {
                const subject = createAuthenticatedGroupChatSubject(args.authUser)
                const policy = subject
                    ? evaluateGroupChatAccessPolicy(this, args.roomId, subject)
                    : null
                if (!existingMember && !policy?.canRead && !inviteMatches) {
                    return { status: 'not_found' } satisfies HumanRoomAdmissionResult
                }
                if (authUserId !== null) {
                    persistAuthenticatedHumanActor(db, {
                        roomId: args.roomId,
                        authUserId,
                        userName: admitted.userName,
                        description: admitted.description,
                        avatar: admitted.avatar,
                        capabilities: !policy?.canRead && (inviteMatches || existingMember)
                            ? [...(policy?.capabilities ?? []), 'room.read']
                            : undefined,
                    })
                }
                this.addRoomMember(
                    args.roomId,
                    args.userId,
                    admitted.userName,
                    admitted.description,
                    admitted.avatar,
                    authUserId ?? undefined,
                )
                return admitted
            }

            if (!localSubjectId) {
                return { status: 'not_found' } satisfies HumanRoomAdmissionResult
            }
            const policy = evaluateGroupChatAccessPolicy(this, args.roomId, createLocalGroupChatSubject(localSubjectId))
            if (room.inviteCode && !inviteMatches && !policy.canRead) {
                return { status: 'not_found' } satisfies HumanRoomAdmissionResult
            }
            persistLocalActor(db, {
                roomId: args.roomId,
                localSubjectId,
                userName: admitted.userName,
                description: admitted.description,
                avatar: admitted.avatar,
                grantDefaultCapabilities: inviteMatches || !room.inviteCode,
            })
            this.addRoomMember(args.roomId, args.userId, admitted.userName, admitted.description, admitted.avatar)
            return admitted
        })
    }

    ensureAuthenticatedHumanActor(args: {
        roomId: string
        authUserId: number
        userId: string
        userName: string
        description: string
        avatar: string
        capabilities?: string[]
    }): GroupActor {
        const db = this.db()
        if (!db) {
            return {
                id: args.userId,
                roomId: args.roomId,
                actorType: 'authenticated_human',
                authUserId: args.authUserId,
                agentId: null,
                localSubjectId: null,
                systemKey: null,
                name: args.userName,
                description: args.description,
                avatar: args.avatar,
                active: 1,
                authorizationRevision: 0,
                contextRevision: 0,
                tombstonedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
        }
        let actor: GroupActor | null = null
        this.withImmediateTransaction(db, () => {
            actor = persistAuthenticatedHumanActor(db, {
                roomId: args.roomId,
                authUserId: args.authUserId,
                userName: args.userName,
                description: args.description,
                avatar: args.avatar,
                capabilities: args.capabilities,
            })
            this.addRoomMember(args.roomId, args.userId, args.userName, args.description, args.avatar, args.authUserId)
        })
        if (!actor) {
            throw new Error('failed to persist authenticated group actor')
        }
        return actor
    }

    ensureLocalActor(args: {
        roomId: string
        localSubjectId: string
        userId?: string
        userName: string
        description: string
        avatar: string
        grantDefaultCapabilities?: boolean
    }): GroupActor {
        const db = this.db()
        if (!db) {
            return {
                id: args.userId || args.localSubjectId,
                roomId: args.roomId,
                actorType: 'local',
                authUserId: null,
                agentId: null,
                localSubjectId: args.localSubjectId,
                systemKey: null,
                name: args.userName,
                description: args.description,
                avatar: args.avatar,
                active: 1,
                authorizationRevision: 0,
                contextRevision: 0,
                tombstonedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
        }
        let actor: GroupActor | null = null
        const memberUserId = args.userId
        this.withImmediateTransaction(db, () => {
            actor = persistLocalActor(db, {
                roomId: args.roomId,
                localSubjectId: args.localSubjectId,
                userName: args.userName,
                description: args.description,
                avatar: args.avatar,
                grantDefaultCapabilities: args.grantDefaultCapabilities,
            })
            if (memberUserId) {
                this.addRoomMember(args.roomId, memberUserId, args.userName, args.description, args.avatar)
            }
        })
        if (!actor) {
            throw new Error('failed to persist local group actor')
        }
        return actor
    }

    ensureAgentActor(roomId: string, agentId: string, name: string, description: string): GroupActor {
        const db = this.db()
        if (!db) {
            return {
                id: agentId,
                roomId,
                actorType: 'agent',
                authUserId: null,
                agentId,
                localSubjectId: null,
                systemKey: null,
                name,
                description,
                avatar: '',
                active: 1,
                authorizationRevision: 0,
                contextRevision: 0,
                tombstonedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
        }
        return persistAgentActor(db, { roomId, agentId, name, description })
    }

    ensureSystemActor(roomId: string, systemKey = 'room-system'): GroupActor {
        const db = this.db()
        if (!db) {
            return {
                id: systemKey,
                roomId,
                actorType: 'system',
                authUserId: null,
                agentId: null,
                localSubjectId: null,
                systemKey,
                name: 'system',
                description: '',
                avatar: '',
                active: 1,
                authorizationRevision: 0,
                contextRevision: 0,
                tombstonedAt: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            }
        }
        return persistSystemActor(db, { roomId, systemKey })
    }

    removeAgentActorWithRetention(roomId: string, agentRef: string): RemovedAgentRetention | null {
        const db = this.db()
        if (!db) {
            const agent = this.getRoomAgent(roomId, agentRef)
            if (!agent) return null
            this.removeRoomAgent(roomId, agentRef)
            return {
                agent,
                actorId: null,
                sessionProfiles: [],
            }
        }
        let removed: RemovedAgentRetention | null = null
        this.withImmediateTransaction(db, () => {
            const agent = this.getRoomAgent(roomId, agentRef)
            if (!agent) return
            const sessionProfiles = this.getSessionProfilesForRoomAgent(roomId, agent.agentId)
            const actor = deactivatePersistedAgentActorWithRetention(db, roomId, agent.agentId)
            for (const session of sessionProfiles) {
                this.enqueuePendingSessionDelete(session.session_id, session.profile_name)
            }
            db.prepare('DELETE FROM gc_session_profiles WHERE room_id = ? AND agent_id = ?').run(roomId, agent.agentId)
            this.removeRoomMembersForAgent(roomId, agent)
            this.removeRoomAgent(roomId, agentRef)
            this.incrementRoomAuthorizationRevision(roomId)
            removed = {
                agent,
                actorId: actor?.id || null,
                sessionProfiles,
            }
        })
        return removed
    }

    deactivateAuthenticatedHumanActorWithRetention(roomId: string, authUserId: number): GroupActor | null {
        const db = this.db()
        if (!db || !Number.isFinite(authUserId) || authUserId <= 0) {
            return null
        }
        let actorId: string | null = null
        this.withImmediateTransaction(db, () => {
            const actor = this.findActiveActorByAuthUserId(roomId, Math.floor(authUserId))
            let changed = false
            if (actor) {
                actorId = actor.id
                const now = Date.now()
                db.prepare('DELETE FROM gc_room_actor_capabilities WHERE actorId = ?').run(actor.id)
                const tombstoned = db.prepare(
                    `UPDATE gc_room_actors
                     SET active = 0,
                         authUserId = NULL,
                         agentId = NULL,
                         localSubjectId = NULL,
                         systemKey = NULL,
                         name = ?,
                         description = '',
                         avatar = '',
                         authorizationRevision = authorizationRevision + 1,
                         contextRevision = contextRevision + 1,
                         tombstonedAt = ?,
                         updatedAt = ?
                     WHERE id = ? AND active = 1`
                ).run('Revoked user', now, now, actor.id)
                changed = tombstoned.changes > 0
            }
            const removedMembership = db.prepare(
                'DELETE FROM gc_room_members WHERE roomId = ? AND authUserId = ?',
            ).run(roomId, Math.floor(authUserId))
            const removedOwnership = db.prepare(
                'UPDATE gc_rooms SET ownerAuthUserId = NULL WHERE id = ? AND ownerAuthUserId = ?',
            ).run(roomId, Math.floor(authUserId))
            changed = changed || removedMembership.changes > 0 || removedOwnership.changes > 0
            if (changed) this.incrementRoomAuthorizationRevision(roomId)
        })
        if (!actorId) return null
        return (db.prepare(
            'SELECT id, roomId, actorType, authUserId, agentId, localSubjectId, systemKey, name, description, avatar, active, authorizationRevision, contextRevision, tombstonedAt, createdAt, updatedAt FROM gc_room_actors WHERE id = ?'
        ).get(actorId) as GroupActor | undefined) ?? null
    }

    findActiveActorByAuthUserId(roomId: string, authUserId: number): GroupActor | null {
        const db = this.db()
        return db ? readActiveActorByAuthUserId(db, roomId, authUserId) : null
    }

    findActiveActorByAgentIdentity(roomId: string, agentId: string): GroupActor | null {
        const db = this.db()
        return db ? readActiveActorByAgentIdentity(db, roomId, agentId) : null
    }

    findActiveActorByLocalSubjectId(roomId: string, localSubjectId: string): GroupActor | null {
        const db = this.db()
        return db ? readActiveActorByLocalSubjectId(db, roomId, localSubjectId) : null
    }

    findActiveActorBySystemKey(roomId: string, systemKey: string): GroupActor | null {
        const db = this.db()
        return db ? readActiveActorBySystemKey(db, roomId, systemKey) : null
    }

    getActorCapabilities(actorId: string): string[] {
        const db = this.db()
        return db ? [...readPersistedActorCapabilities(db, actorId)] : []
    }

    updateMemberActivity(roomId: string, userId: string): void {
        this.db()?.prepare(
            'UPDATE gc_room_members SET updatedAt = ? WHERE roomId = ? AND userId = ?'
        ).run(Date.now(), roomId, userId)
    }
}

export async function drainPendingSessionDeletes(profileName: string): Promise<PendingSessionDeleteDrainResult> {
    const deleterResult = await SessionDeleter.getInstance().drain(profileName)
    return {
        deleted: deleterResult.deleted,
        failed: deleterResult.failed.map(id => ({ sessionId: id, error: 'unknown' })),
    }
}

// ─── ChatRoom (in-memory, for online members) ─────────────────

class ChatRoom {
    readonly id: string
    name: string
    readonly members = new Map<string, Member>()
    private readonly userIdBySocketId = new Map<string, string>()
    private readonly socketIdsByUserId = new Map<string, Set<string>>()

    constructor(id: string, name?: string) {
        this.id = id
        this.name = name || id
    }

    addOrUpdateMember(socketId: string, userId: string, name: string, description: string, source: 'human' | 'agent' = 'human', avatar: string = ''): Member {
        const previousUserId = this.userIdBySocketId.get(socketId)
        if (previousUserId && previousUserId !== userId) this.removeMember(socketId)

        const existing = this.members.get(userId)
        const member = existing || {
            id: socketId,
            userId,
            name,
            description,
            joinedAt: Date.now(),
            online: true,
            socketId,
            source,
            avatar,
        }
        member.name = name
        member.description = description
        member.online = true
        member.socketId = socketId
        member.source = source
        if (avatar) member.avatar = avatar
        this.members.set(userId, member)
        this.userIdBySocketId.set(socketId, userId)
        const socketIds = this.socketIdsByUserId.get(userId) || new Set<string>()
        socketIds.add(socketId)
        this.socketIdsByUserId.set(userId, socketIds)
        return member
    }

    removeMember(socketId: string): void {
        const userId = this.userIdBySocketId.get(socketId)
        if (!userId) return
        this.userIdBySocketId.delete(socketId)
        const socketIds = this.socketIdsByUserId.get(userId)
        socketIds?.delete(socketId)
        const member = this.members.get(userId)
        if (!socketIds || socketIds.size === 0) {
            this.socketIdsByUserId.delete(userId)
            if (member) member.online = false
            return
        }
        if (member?.socketId === socketId) {
            for (const remainingSocketId of socketIds) {
                member.socketId = remainingSocketId
                break
            }
        }
    }

    getMembersList(): Member[] {
        return Array.from(this.members.values()).filter(member => member.source !== 'agent')
    }

    getOnlineMemberBySocketId(socketId: string): Member | undefined {
        const userId = this.userIdBySocketId.get(socketId)
        if (!userId) return undefined
        const member = this.members.get(userId)
        return member?.online ? member : undefined
    }

    hasOnlineMember(socketId: string): boolean {
        return this.getOnlineMemberBySocketId(socketId) !== undefined
    }

    hasOnlineUser(userId: string): boolean {
        return (this.socketIdsByUserId.get(userId)?.size || 0) > 0
    }
}

// ─── GroupChat Server ────────────────────────────────────────

export class GroupChatServer {
    private io: Server
    private nsp: Namespace
    private storage: ChatStorage
    private rooms = new Map<string, ChatRoom>()
    /** Map: socket.id → display/routing userId */
    private socketUserMap = new Map<string, string>()
    /** Map: socket.id → authoritative local principal for unauthenticated users */
    private socketLocalSubjectIdMap = new Map<string, string>()
    /** Map: userId → { name, description } (from auth) */
    private userInfoMap = new Map<string, { name: string; description: string }>()
    /** Map: socket.id → requested participant source from handshake */
    private socketRequestedSourceMap = new Map<string, 'human' | 'agent'>()
    /** Map: socket.id → numeric users.id from the web UI auth (for avatar resolution) */
    private socketAuthUserIdMap = new Map<string, number>()
    private localIdentitySecretPromise: Promise<string> | null = null
    readonly agentClients = new AgentClients()
    private _contextEngine: ContextEngine | null = null
    private _restoreScheduled = false
    /** roomId -> (userId -> { userName, timer }) */
    private typingState = new Map<string, Map<string, { userName: string; timer: ReturnType<typeof setTimeout> }>>()
    /** roomId -> (agentName -> { agentName, status }) */
    private contextStatusState = new Map<string, Map<string, { agentId: string; agentName: string; status: string }>>()
    /** Bridge approval ids are scoped to the exact Hermes participant session that emitted them. */
    private pendingApprovals = new Map<string, { roomId: string; agentId: string; agentName: string; sessionId: string }>()
    /** roomId -> blocked Bridge session ids from room-level interrupts/rotations. */
    private fencedRoomAgentSessions = new Map<string, Set<string>>()
    /** Bridge approval id -> server-observed originating room and live agent run. */
    private pendingApprovals = new Map<string, PendingApprovalBinding>()
    private inviteAttemptLimiter?: GroupChatInviteAttemptLimiter
    /** Test-only join checkpoint hook for deterministic invite-admission races. */
    private joinAdmissionCheckpointForTests: ((args: { roomId: string; userId: string; inviteCode?: string }) => void) | null = null

    constructor(httpServers: HttpServer | HttpServer[]) {
        this.storage = new ChatStorage()
        this.storage.init()
        const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

        this.io = new Server(servers[0], {
            cors: { origin: createSocketIoCorsOrigin(config.corsOrigins) },
            allowRequest: (req, callback) => {
                if (shouldRejectUpgradeOrigin(req, config.corsOrigins)) {
                    callback('origin not allowed', false)
                    return
                }
                callback(null, true)
            },
            pingInterval: 25_000,
            pingTimeout: 90_000,
            connectionStateRecovery: {
                maxDisconnectionDuration: 2 * 60_000,
                skipMiddlewares: true,
            },
        })
        servers.slice(1).forEach((httpServer) => this.io.attach(httpServer))
        this.nsp = this.io.of('/group-chat')
        this.nsp.use(this.authMiddleware.bind(this))
        this.nsp.on('connection', this.onConnection.bind(this))

        // Restore persisted rooms into memory
        this.storage.getAllRooms().forEach((row) => {
            this.rooms.set(row.id, new ChatRoom(row.id, row.name))
        })

        logger.info('[GroupChat] Socket.IO ready at /group-chat')

        // Initialize context engine for group chat compression
        const contextEngine = new ContextEngine({
            messageFetcher: this.storage,
        })
        this.agentClients.setContextEngine(contextEngine)
        this.agentClients.setStorage(this.storage)
        this.storage.setRetentionBlockedHandler((roomId, blockedAgentIds, throughRoomSeq) => {
            this.scheduleRetentionCheckpoints(roomId, blockedAgentIds, throughRoomSeq)
        })
        this.agentClients.setWorkspaceDiffBroadcaster((roomId, msg, totalTokens) => {
            this.emitToRoomReaders(roomId, 'message', msg)
            this.emitToRoomReaders(roomId, 'room_updated', { roomId, totalTokens })
        })
        this._contextEngine = contextEngine

        // Restore agent connections — call restoreAgents() after server is listening
        this._restoreScheduled = false
    }

    getIO(): Server {
        return this.io
    }

    getStorage(): ChatStorage {
        return this.storage
    }

    revokeAuthenticatedUser(authUserId: number): void {
        if (!Number.isInteger(authUserId) || authUserId <= 0) return
        for (const room of this.storage.getAllRooms()) {
            this.storage.deactivateAuthenticatedHumanActorWithRetention(room.id, authUserId)
        }
        const sockets = Array.from(this.nsp.sockets.values())
            .filter((socket) => this.socketAuthUserIdMap.get(socket.id) === authUserId)
        for (const socket of sockets) {
            this.leaveAllRooms(socket, socket.id)
            socket.disconnect(true)
        }
    }

    leaveAuthenticatedUserRoom(roomId: string, authUserId: number): void {
        if (!roomId || !Number.isInteger(authUserId) || authUserId <= 0) return
        const room = this.rooms.get(roomId)
        const removedMembers = new Map<string, Member>()
        const sockets = Array.from(this.nsp.sockets.values())
            .filter((socket) => this.socketAuthUserIdMap.get(socket.id) === authUserId)
        for (const socket of sockets) {
            const removed = this.removeUnauthorizedRoomSocket(socket, roomId)
            if (removed) removedMembers.set(removed.userId, removed)
        }
        for (const removed of removedMembers.values()) {
            if (removed.source === 'agent' || room?.hasOnlineUser(removed.userId)) continue
            this.emitToRoomReaders(roomId, 'member_left', {
                roomId,
                memberId: removed.userId,
                memberName: removed.name,
                members: room?.getMembersList() ?? [],
            })
        }
    }

    getInviteAttemptLimiter(): GroupChatInviteAttemptLimiter {
        this.inviteAttemptLimiter ??= new GroupChatInviteAttemptLimiter()
        return this.inviteAttemptLimiter
    }

    async resolveLocalCredentialSubject(localCredential: unknown): Promise<string | null> {
        if (typeof localCredential !== 'string' || !localCredential.trim()) return null
        return decodeLocalCredential(await this.getLocalIdentitySecret(), localCredential)
    }

    async resolveInviteAttemptSubjectKey(
        authUserId: number | null | undefined,
        fallback: string | null | undefined,
        localCredential: unknown,
    ): Promise<string> {
        if (typeof authUserId === 'number' && Number.isInteger(authUserId) && authUserId > 0) {
            return groupChatInviteAttemptSubjectKey(authUserId, fallback)
        }
        const localSubjectId = await this.resolveLocalCredentialSubject(localCredential)
        return groupChatInviteAttemptSubjectKey(null, fallback, localSubjectId)
    }

    getContextEngine(): ContextEngine | null {
        return this._contextEngine || null
    }

    private getLocalIdentitySecret(): Promise<string> {
        if (!this.localIdentitySecretPromise) {
            this.localIdentitySecretPromise = getGroupChatLocalIdentitySecret()
        }
        return this.localIdentitySecretPromise
    }

    private async resolveLocalSocketIdentity(credential: unknown): Promise<{ localSubjectId: string; localUserId: string; localCredential: string }> {
        const secret = await this.getLocalIdentitySecret()
        if (typeof credential === 'string' && credential.trim()) {
            const localSubjectId = decodeLocalCredential(secret, credential)
            if (localSubjectId) {
                return {
                    localSubjectId,
                    localUserId: localGroupUserId(secret, localSubjectId),
                    localCredential: credential.trim(),
                }
            }
        }
        const localSubjectId = createLocalGroupChatSubjectId()
        return {
            localSubjectId,
            localUserId: localGroupUserId(secret, localSubjectId),
            localCredential: encodeLocalCredential(secret, localSubjectId),
        }
    }

    private getDiscoverableRoomIds(socket: Socket): string[] {
        return Array.from(this.rooms.keys()).filter((roomId) => this.socketAccessPolicy(socket, roomId).canDiscover)
    }

    setJoinAdmissionCheckpointForTests(
        hook: ((args: { roomId: string; userId: string; inviteCode?: string }) => void) | null,
    ): void {
        this.joinAdmissionCheckpointForTests = hook
    }

    private roomAgentSessionIdentity(roomId: string, roomAgent: Pick<RoomAgent, 'agentId' | 'profile' | 'name'>) {
        const room = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
        const sessionSeed = String(room?.sessionSeed || '')
        if (!room || !/^[0-9a-f]{32}$/i.test(sessionSeed)) {
            throw new Error(`Group chat room ${roomId} is missing a cryptographic session seed`)
        }
        const actor = typeof this.storage.findActiveActorByAgentIdentity === 'function'
            ? this.storage.findActiveActorByAgentIdentity(roomId, roomAgent.agentId)
            : null
        return {
            sessionSeed,
            actorId: actor?.id || null,
            roomAuthorizationRevision: room.authorizationRevision,
            actorAuthorizationRevision: actor?.authorizationRevision,
            actorContextRevision: actor?.contextRevision,
        }
    }

    fenceCurrentRoomAgentSessions(roomId: string): () => void {
        const room = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
        if (!room) return () => {}
        const ids = new Set<string>()
        for (const agent of this.storage.getRoomAgents(roomId) || []) {
            const sessionIdentity = this.roomAgentSessionIdentity(roomId, agent)
            ids.add(groupBridgeSessionId(roomId, agent.profile, agent.name, sessionIdentity.sessionSeed, sessionIdentity))
        }
        if (!ids.size) return () => {}
        if (!this.fencedRoomAgentSessions) this.fencedRoomAgentSessions = new Map<string, Set<string>>()
        let fenced = this.fencedRoomAgentSessions.get(roomId)
        if (!fenced) {
            fenced = new Set<string>()
            this.fencedRoomAgentSessions.set(roomId, fenced)
        }
        for (const id of ids) fenced.add(id)
        let released = false
        return () => {
            if (released) return
            released = true
            const current = this.fencedRoomAgentSessions.get(roomId)
            if (!current) return
            for (const id of ids) current.delete(id)
            if (!current.size) this.fencedRoomAgentSessions.delete(roomId)
        }
    }

    private isRoomAgentSessionFenced(roomId: string, sessionId: string): boolean {
        return this.fencedRoomAgentSessions?.get(roomId)?.has(sessionId) === true
    }

    async clearRoomRuntimeState(roomId: string, assertAuthorized: () => void): Promise<void> {
        const releaseSessionFence = this.fenceCurrentRoomAgentSessions(roomId)
        try {
            await this.agentClients.interruptRoom(roomId)
            assertAuthorized()
        } catch (err) {
            releaseSessionFence()
            throw err
        }
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.clearPendingApprovals(roomId)
        this.agentClients.resetRoomContext(roomId)
        this.emitToRoomReaders(roomId, 'room_cleared', { roomId, totalTokens: 0 })
        this.emitToRoomReaders(roomId, 'room_updated', { roomId, totalTokens: 0 })
    }

    async cleanupRemovedAgentRuntime(removal: RemovedAgentRetention | null): Promise<void> {
        if (!removal) return
        this.clearPendingApprovals(removal.agent.roomId, removal.agent.agentId)
        const bridge = new AgentBridgeClient()
        for (const session of removal.sessionProfiles) {
            try {
                await bridge.interrupt(session.session_id, 'Interrupted by group chat user', session.profile_name)
            } catch (err) {
                if (!isUnknownBridgeSessionError(err)) {
                    logger.warn(`[GroupChat] failed to interrupt deleted agent session ${session.session_id}: ${(err as Error).message || err}`)
                }
            }
            try {
                await bridge.destroy(session.session_id, session.profile_name)
            } catch (err) {
                if (!isUnknownBridgeSessionError(err)) {
                    logger.warn(`[GroupChat] failed to destroy deleted agent session ${session.session_id}: ${(err as Error).message || err}`)
                }
            }
        }
        this.agentClients.removeAgentFromRoom(removal.agent.roomId, removal.agent.agentId)
    }

    async deleteRoomRuntimeState(roomId: string, assertAuthorized: () => void): Promise<void> {
        const releaseSessionFence = this.fenceCurrentRoomAgentSessions(roomId)
        try {
            await this.agentClients.interruptRoom(roomId)
            assertAuthorized()
        } catch (err) {
            releaseSessionFence()
            throw err
        }
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.clearPendingApprovals(roomId)
        this.agentClients.disconnectRoom(roomId)
        this.rooms.delete(roomId)
        this.nsp.in(roomId).socketsLeave(roomId)
        this.fencedRoomAgentSessions?.delete(roomId)
    }

    // ─── Restore Agents ─────────────────────────────────────────

    /**
     * Restore persisted agent connections. Safe to call multiple times;
     * will only execute once.
     */
    async restoreWhenReady(): Promise<void> {
        if (this._restoreScheduled) return
        this._restoreScheduled = true
        await this.restoreAgents()
        this.handoffDispatcherReady = true
        this.scheduleHandoffDispatch(0)
    }

    stopHandoffDispatcher(): void {
        this.handoffDispatcherReady = false
        if (this.handoffDispatchTimer) {
            clearTimeout(this.handoffDispatchTimer)
            this.handoffDispatchTimer = null
        }
    }

    private scheduleHandoffDispatch(delayMs = 0): void {
        if (!this.handoffDispatcherReady) return
        if (this.handoffDispatchTimer) return
        this.handoffDispatchTimer = setTimeout(() => {
            this.handoffDispatchTimer = null
            void this.drainHandoffJobs()
        }, Math.max(0, delayMs))
        this.handoffDispatchTimer.unref?.()
    }

    private async drainHandoffJobs(): Promise<void> {
        if (this.handoffDispatchRunning) return
        this.handoffDispatchRunning = true
        try {
            while (this.handoffDispatcherReady) {
                this.storage.recoverInterruptedHandoffJobs(this.handoffDispatcherOwner, Date.now())
                const jobs = this.storage.claimHandoffJobs(this.handoffDispatcherOwner, Date.now(), 10, 60_000)
                if (!jobs.length) break
                await Promise.all(jobs.map(async (job) => {
                    const source = this.storage.getMessage(job.sourceMessageId)
                    if (!source) {
                        this.storage.markHandoffJobFailed(job.id, job.leaseToken, 'Source message is no longer available', 0, 1)
                        return
                    }
                    try {
                        const heartbeat = setInterval(() => {
                            this.storage.renewHandoffLease(job.id, job.leaseToken, this.handoffDispatcherOwner, Date.now(), 60_000)
                        }, 15_000)
                        heartbeat.unref?.()
                        try {
                            await this.agentClients.processHandoffJob(job, {
                                messageId: source.id,
                                content: contentToText(source.content),
                                senderName: source.senderName,
                                senderId: source.senderId,
                                timestamp: source.timestamp,
                                role: source.role,
                            })
                        } finally {
                            clearInterval(heartbeat)
                        }
                    } catch (err: any) {
                        const retryWithoutAttempt = err?.retryWithoutAttempt === true
                        const safeRetry = err?.safeRetry === true || retryWithoutAttempt
                        const backoff = Math.min(60_000, 1_000 * (2 ** Math.max(0, job.attemptCount - 1)))
                        if (retryWithoutAttempt) {
                            this.storage.rescheduleHandoffJobWithoutAttempt(
                                job.id, job.leaseToken, err?.message || String(err), Date.now() + backoff,
                            )
                        } else {
                            this.storage.markHandoffJobFailed(
                                job.id, job.leaseToken, err?.message || String(err),
                                safeRetry ? Date.now() + backoff : 0,
                                safeRetry ? 3 : 1,
                            )
                        }
                    }
                }))
            }
        } finally {
            this.handoffDispatchRunning = false
            if (this.handoffDispatcherReady) this.scheduleHandoffDispatch(1_000)
        }
    }

    private async restoreAgents(): Promise<void> {
        const rooms = this.storage.getAllRooms()
        let total = 0

        for (const room of rooms) {
            const agents = this.storage.getRoomAgents(room.id)
            for (const agent of agents) {
                try {
                    const client = await this.agentClients.createAgent({
                        agentId: agent.agentId,
                        profile: agent.profile,
                        name: agent.name,
                        description: agent.description,
                        invited: agent.invited,
                        backgroundDelegationEnabled: false,
                    })
                    await this.agentClients.addAgentToRoom(room.id, client)
                    total++
                } catch (err: any) {
                    logger.error(`[GroupChat] Failed to restore agent ${agent.name} in room ${room.id}: ${err.message}`)
                }
            }
        }

        if (total > 0) {
            logger.info(`[GroupChat] Restored ${total} agent(s) across ${rooms.length} room(s)`)
        }
    }

    // ─── Auth ───────────────────────────────────────────────────

    private readActiveAuthenticatedUser(authUserId: number | undefined): AuthenticatedUser | null {
        if (!Number.isInteger(authUserId) || !authUserId || authUserId <= 0) return null
        try {
            const user = findUserById(authUserId)
            if (!user || user.status !== 'active') return null
            return {
                id: user.id,
                username: user.username,
                role: user.role,
                profiles: user.role === 'super_admin'
                    ? []
                    : listUserProfiles(user.id).map((profile) => profile.profile_name),
            }
        } catch (err) {
            logger.warn(`[GroupChat] failed to refresh authenticated authority for user ${authUserId}: ${(err as Error).message}`)
            return null
        }
    }

    private currentAuthenticatedSocketUser(socket: Socket): AuthenticatedUser | null {
        return this.readActiveAuthenticatedUser(this.socketAuthUserIdMap?.get(socket.id))
    }

    private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
        const auth = socket.handshake.auth as { source?: string; agentSocketSecret?: string; token?: string; localCredential?: string }
        const isAgentSocket = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET
        if (isAgentSocket) {
            delete socket.data.authUserId
            delete socket.data.localSubjectId
            delete socket.data.localUserId
            delete socket.data.localCredential
            next()
            return
        }

        const token = auth.token || socket.handshake.query.token || ''
        if (await isAuthEnabled()) {
            const user = await authenticateUserToken(String(token))
            if (!user) return next(new Error('Unauthorized'))
            socket.data.authUserId = user.id
            delete socket.data.localSubjectId
            delete socket.data.localUserId
            delete socket.data.localCredential
            next()
            return
        }

        const localIdentity = await this.resolveLocalSocketIdentity(auth.localCredential)
        delete socket.data.authUserId
        socket.data.localSubjectId = localIdentity.localSubjectId
        socket.data.localUserId = localIdentity.localUserId
        socket.data.localCredential = localIdentity.localCredential
        next()
    }

    // ─── Connection ─────────────────────────────────────────────

    private onConnection(socket: Socket): void {
        const auth = socket.handshake.auth as { userId?: string; name?: string; description?: string; source?: string; agentSocketSecret?: string }
        const requestedSource = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET ? 'agent' : 'human'
        const storedAuthUserId = requestedSource === 'human' && typeof socket.data.authUserId === 'number'
            ? socket.data.authUserId
            : undefined
        const authenticatedUser = this.readActiveAuthenticatedUser(storedAuthUserId)
        if (storedAuthUserId && !authenticatedUser) {
            socket.disconnect(true)
            return
        }
        const authUserId = authenticatedUser?.id
        const localSubjectId = requestedSource === 'human' && !authUserId && typeof socket.data.localSubjectId === 'string'
            ? socket.data.localSubjectId
            : null
        const localUserId = requestedSource === 'human' && !authUserId && typeof socket.data.localUserId === 'string'
            ? socket.data.localUserId
            : null
        let userId: string
        if (requestedSource === 'agent') {
            userId = typeof auth.userId === 'string' && auth.userId.trim() ? auth.userId.trim() : socket.id
        } else if (authUserId) {
            userId = authenticatedGroupUserId(authUserId)
        } else {
            if (!localSubjectId || !localUserId) {
                socket.disconnect(true)
                return
            }
            userId = localUserId
        }
        const userName = auth.name || authenticatedUser?.username || `User-${userId.slice(0, 6)}`
        const description = auth.description || ''

        this.socketUserMap.set(socket.id, userId)
        if (localSubjectId) {
            this.socketLocalSubjectIdMap.set(socket.id, localSubjectId)
        }
        this.socketRequestedSourceMap.set(socket.id, requestedSource)
        this.userInfoMap.set(userId, { name: userName, description })
        if (typeof authUserId === 'number') {
            this.socketAuthUserIdMap.set(socket.id, authUserId)
        }

        if (requestedSource === 'human' && !authUserId && typeof socket.data.localCredential === 'string') {
            setTimeout(() => {
                socket.emit('local_identity', {
                    localCredential: socket.data.localCredential,
                    userId,
                })
            }, 0)
        }

        logger.debug(`[GroupChat] Connected: ${userName} (socket=${socket.id}, user=${userId})`)

        socket.on('join', (data: { roomId?: string; name?: string }, ack?: (response?: unknown) => void) => this.handleJoin(socket, data, ack))
        socket.on('update_member_profile', (data: { roomId?: string; name?: string; description?: string } | undefined, ack?: (response?: unknown) => void) => this.handleUpdateMemberProfile(socket, data, ack))
        socket.on('message', (data: Partial<ChatMessage> & { roomId?: string; content: string | Array<Record<string, unknown>>; id?: string; mentionDepth?: number }, ack?: (response?: unknown) => void) => this.handleMessage(socket, data, ack))
        socket.on('message_stream_start', (data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number }) => this.handleMessageStreamStart(socket, data))
        socket.on('message_stream_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageStreamDelta(socket, data))
        socket.on('message_reasoning_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageReasoningDelta(socket, data))
        socket.on('message_stream_end', (data: { roomId?: string; id?: string }) => this.handleMessageStreamEnd(socket, data))
        socket.on('typing', (data: { roomId?: string }) => this.handleTyping(socket, data))
        socket.on('stop_typing', (data: { roomId?: string }) => this.handleStopTyping(socket, data))
        socket.on('context_status', (data: { roomId?: string; agentName?: string; status?: string }) => this.handleContextStatus(socket, data))
        socket.on('interrupt_agent', (data: { roomId?: string; agentName?: string }, ack?: (response?: unknown) => void) => this.handleInterruptAgent(socket, data, ack))
        socket.on('approval.requested', (data: { roomId?: string; agentName?: string; agentSessionId?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean }) => this.handleApprovalRequested(socket, data))
        socket.on('approval.resolved', (data: { roomId?: string; agentName?: string; agentSessionId?: string; approval_id?: string; choice?: string }) => this.handleApprovalResolved(socket, data))
        socket.on('approval.respond', (data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void) => this.handleApprovalRespond(socket, data, ack))
        socket.on('disconnect', () => this.handleDisconnect(socket))
    }

    // ─── Handlers ───────────────────────────────────────────────

    private socketAccessPolicy(socket: Socket, roomId: string) {
        const requestedSource = this.socketRequestedSourceMap?.get(socket.id) || 'human'
        const userId = this.socketUserMap?.get(socket.id) || socket.id
        const localSubjectId = this.socketLocalSubjectIdMap?.get(socket.id) || null
        const authUser = this.currentAuthenticatedSocketUser(socket)
        const storedRoom = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : null

        const policy = requestedSource === 'agent'
            ? evaluateGroupChatAccessPolicy(this.storage, roomId, createAgentGroupChatSubject(userId))
            : authUser
                ? (() => {
                    const subject = createAuthenticatedGroupChatSubject({
                        id: authUser.id,
                        role: authUser.role,
                        profiles: authUser.profiles ?? [],
                    })
                    return subject
                        ? evaluateGroupChatAccessPolicy(this.storage, roomId, subject)
                        : noAccessPolicyDecision(roomId, storedRoom)
                })()
                : localSubjectId
                    ? evaluateGroupChatAccessPolicy(this.storage, roomId, createLocalGroupChatSubject(localSubjectId))
                    : noAccessPolicyDecision(roomId, storedRoom)

        return policy
    }

    private removeUnauthorizedRoomSocket(socket: Socket, roomId: string): Member | null {
        const room = this.rooms.get(roomId)
        const member = room?.getOnlineMemberBySocketId(socket.id) ?? null
        room?.removeMember(socket.id)
        socket.leave(roomId)

        const userId = this.socketUserMap.get(socket.id) || socket.id
        const roomTyping = this.typingState.get(roomId)
        const typingEntry = roomTyping?.get(userId)
        if (typingEntry) clearTimeout(typingEntry.timer)
        roomTyping?.delete(userId)
        if (roomTyping?.size === 0) this.typingState.delete(roomId)

        if (member?.source === 'agent' && !room?.hasOnlineUser(member.userId)) {
            const roomStatuses = this.contextStatusState.get(roomId)
            roomStatuses?.delete(member.name)
            if (roomStatuses?.size === 0) this.contextStatusState.delete(roomId)
        }
        return member
    }

    private emitToRoomReaders(roomId: string, event: string, payload: unknown, excludeSocketId?: string): void {
        const socketIds = this.nsp?.adapter?.rooms?.get(roomId)
        if (!socketIds) return

        const recipients: Socket[] = []
        const removedMembers = new Map<string, Member>()
        for (const socketId of Array.from(socketIds)) {
            const recipient = this.nsp.sockets?.get(socketId)
            if (!recipient) continue
            if (!this.socketAccessPolicy(recipient, roomId).canRead) {
                const removed = this.removeUnauthorizedRoomSocket(recipient, roomId)
                if (removed) removedMembers.set(removed.userId, removed)
                continue
            }
            if (recipient.id !== excludeSocketId) recipients.push(recipient)
        }

        for (const recipient of recipients) recipient.emit(event, payload)
        if (event === 'member_left') return
        const room = this.rooms.get(roomId)
        for (const removed of removedMembers.values()) {
            if (room?.hasOnlineUser(removed.userId)) continue
            if (removed.source === 'agent') continue
            const memberPayload = {
                roomId,
                memberId: removed.userId,
                memberName: removed.name,
                members: room?.getMembersList() ?? [],
            }
            for (const recipient of recipients) recipient.emit('member_left', memberPayload)
        }
    }

    private runJoinAdmissionCheckpointForTests(roomId: string, userId: string, inviteCode?: string): void {
        const hook = this.joinAdmissionCheckpointForTests
        if (!hook) return
        this.joinAdmissionCheckpointForTests = null
        hook({ roomId, userId, inviteCode })
    }

    private canSocketManageRoom(socket: Socket, roomId: string): boolean {
        return this.socketAccessPolicy(socket, roomId).canManage
    }

    private getOnlineRoomMember(socket: Socket, roomId: string): { room: ChatRoom; member: Member } | null {
        const room = this.rooms.get(roomId)
        const member = room?.getOnlineMemberBySocketId(socket.id)
        return room && member ? { room, member } : null
    }

    private isAgentEventSocket(socket: Socket, roomId: string, agentName?: string): boolean {
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'agent') return false
        return !agentName || joined.member.name === agentName
    }

    private emitToRoomApprovalResponders(roomId: string, event: string, payload: Record<string, unknown>): void {
        const socketIds = this.nsp?.adapter?.rooms?.get(roomId)
        if (!socketIds) return
        for (const socketId of Array.from(socketIds)) {
            const socket = this.nsp.sockets?.get(socketId)
            if (!socket) continue
            const joined = this.getOnlineRoomMember(socket, roomId)
            if (!joined) {
                socket.leave(roomId)
                continue
            }
            const policy = this.socketAccessPolicy(socket, roomId)
            if (!policy.canRead) {
                this.removeUnauthorizedRoomSocket(socket, roomId)
                continue
            }
            if (joined.member.source === 'agent' || !policy.canApprove) continue
            socket.emit(event, payload)
        }
    }

    private agentIdentitySessionIsCurrent(roomId: string, agentId: string, agentSessionId: unknown): boolean {
        const sessionId = typeof agentSessionId === 'string' ? agentSessionId.trim() : ''
        if (!sessionId) return false
        const roomAgent = this.storage.getRoomAgentByAgentId(roomId, agentId)
        if (!roomAgent) return false
        try {
            const sessionIdentity = this.roomAgentSessionIdentity(roomId, roomAgent)
            const expected = groupBridgeSessionId(roomId, roomAgent.profile, roomAgent.name, sessionIdentity.sessionSeed, sessionIdentity)
            if (sessionId !== expected || this.isRoomAgentSessionFenced(roomId, sessionId)) return false
            const actor = this.storage.findActiveActorByAgentIdentity(roomId, agentId)
            if (!actor) return false
            const capabilities = new Set(this.storage.getActorCapabilities(actor.id))
            return capabilities.has('room.read') && capabilities.has('room.write')
        } catch {
            return false
        }
    }

    private agentSessionIsCurrent(roomId: string, member: Member | undefined, agentSessionId: unknown): boolean {
        return member?.source === 'agent'
            && this.agentIdentitySessionIsCurrent(roomId, member.userId, agentSessionId)
    }

    private canPersistAgentMessageForCurrentSession(roomId: string, member: Member | undefined, data: Partial<ChatMessage>): boolean {
        if (member?.source !== 'agent') return true
        const role = normalizeMessageRole(data.role)
        const isRunTrace = role === 'assistant' || role === 'tool' || Array.isArray(data.tool_calls) || Boolean(data.tool_call_id)
        if (!isRunTrace) return true
        return this.agentSessionIsCurrent(roomId, member, data.agentSessionId)
    }

    private getCurrentAgentEventMember(socket: Socket, roomId: string, agentName: string, agentSessionId?: unknown): Member | null {
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'agent') return null
        if (agentName && joined.member.name !== agentName) return null
        if (!this.agentSessionIsCurrent(roomId, joined.member, agentSessionId)) return null
        if (!this.socketAccessPolicy(socket, roomId).canWrite) return null
        return joined.member
    }

    private handleJoin(socket: Socket, data: { roomId?: string; name?: string; description?: string; inviteCode?: string }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId) || socketId
        const localSubjectId = this.socketLocalSubjectIdMap?.get(socketId) || null
        const requestedSource = this.socketRequestedSourceMap.get(socketId) || 'human'
        const roomId = data.roomId || 'general'
        const roomAgent = this.storage.getRoomAgentByAgentId(roomId, userId)
        if (requestedSource === 'agent' && !roomAgent) {
            ack?.({ error: 'Access denied' })
            return
        }
        const source = requestedSource === 'agent' && roomAgent ? 'agent' : 'human'
        if (source === 'human' && roomAgent) {
            ack?.({ error: 'Reserved member identity' })
            return
        }
        const inviteAttemptKey = source === 'human' && typeof data.inviteCode === 'string'
            ? groupChatInviteAttemptSubjectKey(
                this.socketAuthUserIdMap.get(socket.id),
                socket.handshake?.address,
                localSubjectId,
            )
            : null
        const inviteAttemptLimiter = this.getInviteAttemptLimiter()
        const persistedRoomForAdmission = typeof this.storage.getRoom === 'function'
            ? this.storage.getRoom(roomId)
            : null
        const canReadWithoutInvite = source !== 'agent'
            && (this.socketAccessPolicy(socket, roomId).canRead
                || Boolean(persistedRoomForAdmission && !persistedRoomForAdmission.inviteCode))
        if (inviteAttemptKey && !canReadWithoutInvite && !inviteAttemptLimiter.isAllowed(inviteAttemptKey)) {
            ack?.({ error: 'Room not found' })
            return
        }
        let authUserId: number | undefined
        if (source !== 'agent') {
            authUserId = this.socketAuthUserIdMap?.get(socket.id)
        }
        const getExistingMemberByUserId = typeof this.storage.getMemberByUserId === 'function'
            ? this.storage.getMemberByUserId.bind(this.storage)
            : () => null
        const getExistingMemberByAuthUserId = typeof this.storage.getMemberByAuthUserId === 'function'
            ? this.storage.getMemberByAuthUserId.bind(this.storage)
            : () => null
        const existingMember = source !== 'agent'
            ? getExistingMemberByUserId(roomId, userId)
                || (typeof authUserId === 'number' ? getExistingMemberByAuthUserId(roomId, authUserId) : null)
            : null
        const userInfo = this.userInfoMap?.get(userId) || {
            name: `User-${userId.slice(0, 6)}`,
            description: '',
        }
        const requestedName = typeof data.name === 'string' ? data.name.trim() : ''
        const requestedDescription = typeof data.description === 'string' ? data.description.trim() : ''
        // On rejoin, prefer the per-room DB record over the join-request name
        // so switching rooms doesn't overwrite a member's per-room identity.
        // The DB is authoritative for existing members; requestedName only
        // applies on first join (when there's no DB record yet).
        let userName = existingMember?.name || requestedName || userInfo.name
        let description = existingMember?.description || requestedDescription || userInfo.description

        let room = this.rooms.get(roomId)

        // Look up the user's avatar via their numeric users.id from the web UI session.
        // Falls back to name-based lookup for clients that don't pass authUserId.
        let userAvatar = ''
        if (source !== 'agent') {
            if (typeof authUserId === 'number') {
                try {
                    userAvatar = getUserAvatar(authUserId) || ''
                } catch (err) {
                    logger.info(`[GroupChat] avatar lookup by id=${authUserId} failed: ${(err as Error).message}`)
                }
            } else if (userName) {
                try {
                    const matched = findUserByUsername(userName)
                    if (matched) userAvatar = matched.avatar || ''
                } catch (err) {
                    logger.info(`[GroupChat] avatar lookup by name '${userName}' failed: ${(err as Error).message}`)
                }
            }
        }

        let admittedRoom: RoomInfo | undefined
        // Persist only human members. Agent sockets are runtime participants
        // tracked through gc_room_agents and AgentClients; storing them in
        // gc_room_members makes member counts grow on reconnect/restore.
        const joinedAgent = source === 'agent' ? roomAgent : null
        if (joinedAgent) {
            admittedRoom = this.storage.getRoom(roomId)
            if (!admittedRoom) {
                ack?.({ error: 'Room not found' })
                return
            }
            this.storage.ensureAgentActor?.(roomId, joinedAgent.agentId, joinedAgent.name, joinedAgent.description)
        } else {
            this.runJoinAdmissionCheckpointForTests(roomId, userId, data.inviteCode)
            let admission: any
            if (typeof this.storage.admitHumanMember === 'function') {
                admission = this.storage.admitHumanMember({
                    roomId,
                    userId,
                    localSubjectId,
                    inviteCode: data.inviteCode,
                    requestedName: userName,
                    requestedDescription: description,
                    avatar: userAvatar,
                    authUser: this.currentAuthenticatedSocketUser(socket) ?? undefined,
                })
            } else {
                const roomForAdmission = typeof this.storage.getRoom === 'function'
                    ? this.storage.getRoom(roomId)
                    : null
                const inviteMatches = groupChatInviteCodeMatches(data.inviteCode, roomForAdmission?.inviteCode)
                const canRead = this.socketAccessPolicy(socket, roomId).canRead
                if (!roomForAdmission || (!existingMember && !canRead && !inviteMatches && Boolean(roomForAdmission.inviteCode))) {
                    admission = { status: 'not_found' }
                } else {
                    this.storage.addRoomMember?.(roomId, userId, userName, description, userAvatar, authUserId)
                    admission = {
                        status: 'admitted',
                        room: roomForAdmission,
                        userName,
                        description,
                        avatar: userAvatar,
                    }
                }
            }
            if (admission.status !== 'admitted') {
                if (inviteAttemptKey) inviteAttemptLimiter.recordFailure(inviteAttemptKey)
                ack?.({ error: 'Room not found' })
                return
            }
            admittedRoom = admission.room
            userName = admission.userName
            description = admission.description
            userAvatar = admission.avatar
        }

        if (!this.socketAccessPolicy(socket, roomId).canRead) {
            ack?.({ error: 'Room not found' })
            return
        }

        // Update stored user info only after admission succeeds.
        this.userInfoMap?.set(userId, { name: userName, description })

        if (!room) {
            room = new ChatRoom(roomId, admittedRoom?.name)
            this.rooms.set(roomId, room)
        } else if (admittedRoom?.name) {
            room.name = admittedRoom.name
        }

        // Add to in-memory online participants while preserving every socket for a shared subject.
        const userAlreadyOnline = room.hasOnlineUser(userId)
        room.addOrUpdateMember(socketId, userId, userName, description, source, userAvatar)
        socket.join(roomId)

        if (source !== 'agent' && !userAlreadyOnline) {
            this.emitToRoomReaders(roomId, 'member_joined', {
                roomId,
                memberId: userId,
                memberName: userName,
                members: room.getMembersList(),
            }, socket.id)
        }

        // Load history from SQLite
        const messages = this.storage.getRecentMessagesForUI(roomId)
        const agents = this.storage.getRoomAgents(roomId)

        ack?.({
            roomId,
            roomName: room.name,
            currentUserId: userId,
            members: room.getMembersList(),
            messages,
            agents,
            rooms: this.getDiscoverableRoomIds(socket),
            typingUsers: this.getTypingUsers(roomId),
            contextStatuses: this.getContextStatuses(roomId),
        })

        logger.debug(`[GroupChat] ${userName} (user=${userId}) joined room: ${roomId}`)
    }

    private handleUpdateMemberProfile(
        socket: Socket,
        data: { roomId?: string; name?: string; description?: string } | undefined,
        ack?: (res: any) => void,
    ): void {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        const name = typeof data?.name === 'string' ? data.name.trim() : ''
        const description = typeof data?.description === 'string' ? data.description.trim() : ''
        if (!roomId || !name) {
            ack?.({ error: 'roomId and name are required' })
            return
        }
        if (name.length > 120 || description.length > 2000) {
            ack?.({ error: 'Member profile is too long' })
            return
        }

        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'human') {
            ack?.({ error: 'Access denied' })
            return
        }
        const access = this.socketAccessPolicy(socket, roomId)
        if (!access.canRead) {
            const removed = this.removeUnauthorizedRoomSocket(socket, roomId)
            if (removed && !joined.room.hasOnlineUser(removed.userId)) {
                this.emitToRoomReaders(roomId, 'member_left', {
                    roomId,
                    memberId: removed.userId,
                    memberName: removed.name,
                    members: joined.room.getMembersList(),
                }, socket.id)
            }
            ack?.({ error: 'Access denied' })
            return
        }
        if (!access.canWrite) {
            ack?.({ error: 'Access denied' })
            return
        }

        try {
            const userId = joined.member.userId
            const authUserId = this.socketAuthUserIdMap.get(socket.id)
            const avatar = joined.member.avatar || ''
            this.storage.addRoomMember(roomId, userId, name, description, avatar, authUserId)
            joined.room.addOrUpdateMember(socket.id, userId, name, description, 'human', avatar)
            this.userInfoMap.set(userId, { name, description })

            const members = joined.room.getMembersList()
            const payload = {
                roomId,
                memberId: userId,
                memberName: name,
                members,
            }
            this.emitToRoomReaders(roomId, 'member_updated', payload)
            ack?.({ member: joined.room.getOnlineMemberBySocketId(socket.id), members })
        } catch (err) {
            logger.error(`[GroupChat] Failed to update member profile: ${(err as Error).message}`)
            ack?.({ error: 'Failed to update member profile' })
        }
    }

    private handleMessage(socket: Socket, data: Partial<ChatMessage> & { roomId?: string; content: string | Array<Record<string, unknown>>; id?: string; mentionDepth?: number }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)

        if (!room || !room.hasOnlineMember(socketId)) {
            ack?.({ error: 'Not in room' })
            return
        }

        const member = room.getOnlineMemberBySocketId(socketId)
        if (!this.canPersistAgentMessageForCurrentSession(roomId, member, data)) {
            ack?.({ error: 'Stale room session' })
            return
        }
        const access = this.socketAccessPolicy(socket, roomId)
        if (!access.canWrite) {
            ack?.({ error: 'Access denied' })
            return
        }
        const userId = member?.userId || socketId
        const userName = member?.name || `User-${socketId.slice(0, 6)}`
        const role = member?.source === 'agent' ? normalizeMessageRole(data.role) : 'user'
        const routedText = contentToText(data.content)

        if (member?.source !== 'agent' || data.tool_name !== 'workspace_diff') {
            const validation = this.agentClients.validateMessageInput?.(roomId, routedText, userId) || { ok: true as const }
            if (!validation.ok) {
                ack?.({ error: validation.error })
                return
            }
        }

        const messageId = this.normalizeClientMessageId(data.id) || this.generateId()
        const isAgentMessage = member?.source === 'agent'
        const msg: ChatMessage = {
            id: messageId,
            roomId,
            senderId: userId,
            senderName: userName,
            content: contentToStorageString(data.content),
            timestamp: this.normalizeMessageTimestamp(data.timestamp, role),
            role,
            tool_call_id: isAgentMessage ? data.tool_call_id ?? null : null,
            tool_calls: isAgentMessage && Array.isArray(data.tool_calls) ? data.tool_calls : null,
            tool_name: isAgentMessage ? data.tool_name ?? null : null,
            finish_reason: isAgentMessage ? data.finish_reason ?? null : null,
            reasoning: isAgentMessage ? data.reasoning ?? null : null,
            reasoning_details: isAgentMessage ? data.reasoning_details ?? null : null,
            reasoning_content: isAgentMessage ? data.reasoning_content ?? null : null,
            handoffChainId: isAgentMessage ? String(data.handoffChainId || '') : `gcchain_${messageId}`,
            handoffDepth: isAgentMessage ? normalizeMentionDepth(data.handoffDepth ?? data.mentionDepth) : 0,
            sourceHandoffJobId: isAgentMessage ? String(data.sourceHandoffJobId || '') : '',
            sourceHandoffLeaseToken: isAgentMessage ? String(data.sourceHandoffLeaseToken || '') : '',
            handoffFinal: isAgentMessage && data.handoffFinal === true,
            agentSessionId: isAgentMessage ? String(data.agentSessionId || '') : '',
        }

        const roomInfo = this.storage.getRoom(roomId)
        const sourceHandoffJob = msg.sourceHandoffJobId ? this.storage.getHandoffJob(msg.sourceHandoffJobId) : null
        const shouldPlanHandoffs = (msg.role === 'user' && this.canSocketManageRoom(socket, roomId)) ||
            (msg.role === 'assistant' && msg.handoffFinal === true && Boolean(sourceHandoffJob))
        const handoffs = shouldPlanHandoffs && roomInfo
            ? planGroupHandoffs({
                room: roomInfo,
                agents: this.storage.getRoomAgents(roomId),
                source: msg,
                sourceJobKind: sourceHandoffJob?.kind,
            })
            : []
        let saved: ReturnType<ChatStorage['saveMessageAndRefreshRoom']>
        try {
            saved = this.storage.saveMessageAndRefreshRoom(msg, { handoffs })
        } catch (err: any) {
            logger.warn({ roomId, messageId: msg.id, err: err?.message || String(err) }, '[GroupChat] message persistence rejected')
            ack?.({ error: err?.message || 'Message persistence failed' })
            return
        }
        const savedMsg = saved.message
        const totalTokens = saved.totalTokens

        this.emitToRoomReaders(roomId, 'message', savedMsg)
        this.emitToRoomReaders(roomId, 'room_updated', { roomId, totalTokens })
        ack?.({ id: savedMsg.id })

        const mentionDepth = normalizeMentionDepth(data.mentionDepth)
        const isAgentReply = savedMsg.role === 'assistant' && member?.source === 'agent'
        const shouldRouteMentions = access.canInvokeAgents && (
            savedMsg.role === 'user' ||
            (isAgentReply && mentionDepth < maxAgentMentionDepth())
        )

        if (shouldRouteMentions) {
            // Server-side @mention routing — parse mentions and invoke agents directly.
            // Agent replies are allowed to mention other agents, but mentionDepth
            // bounds chained agent-to-agent handoffs so one prompt cannot loop forever.
            this.agentClients.processMentions(roomId, {
                messageId: savedMsg.id,
                content: contentToText(savedMsg.content),
                input: Array.isArray(data.content) ? data.content : undefined,
                senderName: savedMsg.senderName,
                senderId: savedMsg.senderId,
                timestamp: savedMsg.timestamp,
                role: savedMsg.role,
                mentionDepth,
            }).catch((err) => {
                logger.error(`[GroupChat] processMentions error: ${err.message}`)
            })
        }
    }

    private handleMessageStreamStart(socket: Socket, data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        const member = this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)
        if (!member) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return

        this.emitToRoomReaders(roomId, 'message_stream_start', {
            id,
            roomId,
            senderId: member.userId,
            senderName: member.name,
            content: '',
            timestamp: data.timestamp || Date.now(),
            role: 'assistant',
            finish_reason: 'streaming',
        })
    }

    private handleMessageStreamDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.emitToRoomReaders(roomId, 'message_stream_delta', {
            roomId,
            id,
            delta: String(data.delta),
        })
    }

    private handleMessageReasoningDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.emitToRoomReaders(roomId, 'message_reasoning_delta', {
            roomId,
            id,
            delta: String(data.delta),
        })
    }

    private handleMessageStreamEnd(socket: Socket, data: { roomId?: string; id?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return
        this.emitToRoomReaders(roomId, 'message_stream_end', { roomId, id })
    }

    private handleTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const access = this.socketAccessPolicy(socket, roomId)
        if (!access.canType) return
        const userId = this.socketUserMap.get(socket.id) || socket.id
        const userName = this.userInfoMap.get(userId)?.name || `User-${socket.id.slice(0, 6)}`

        // Track typing state for rejoin recovery
        let roomTyping = this.typingState.get(roomId)
        if (!roomTyping) {
            roomTyping = new Map()
            this.typingState.set(roomId, roomTyping)
        }
        const existing = roomTyping.get(userId)
        if (existing) clearTimeout(existing.timer)
        roomTyping.set(userId, {
            userName,
            timer: setTimeout(() => {
                roomTyping!.delete(userId)
                if (roomTyping!.size === 0) this.typingState.delete(roomId)
            }, 30000),
        })

        this.emitToRoomReaders(roomId, 'typing', {
            roomId,
            userId,
            userName,
        }, socket.id)
    }

    private handleStopTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const access = this.socketAccessPolicy(socket, roomId)
        if (!access.canType) return
        const userId = this.socketUserMap.get(socket.id) || socket.id

        // Remove from typing state
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            const entry = roomTyping.get(userId)
            if (entry) clearTimeout(entry.timer)
            roomTyping.delete(userId)
            if (roomTyping.size === 0) this.typingState.delete(roomId)
        }

        this.emitToRoomReaders(roomId, 'stop_typing', {
            roomId,
            userId,
        }, socket.id)
    }

    private handleContextStatus(socket: Socket, data: { roomId?: string; agentName?: string; status?: string; totalTokens?: number; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        const agentName = data.agentName || ''
        const status = data.status || ''

        const agentMember = this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)
        if (!agentName || !agentMember) return
        const agentId = agentMember.userId

        let roomStatuses = this.contextStatusState.get(roomId)
        if (!roomStatuses) {
            roomStatuses = new Map()
            this.contextStatusState.set(roomId, roomStatuses)
        }

        if (status === 'ready') {
            roomStatuses.delete(agentId)
            if (roomStatuses.size === 0) this.contextStatusState.delete(roomId)
        } else {
            roomStatuses.set(agentId, { agentId, agentName, status })
        }

        // Relay to all other authorized sockets in the room
        this.emitToRoomReaders(roomId, 'context_status', {
            roomId,
            agentId,
            agentName,
            status,
        }, socket.id)

        if (typeof data.totalTokens === 'number' && Number.isFinite(data.totalTokens) && data.totalTokens >= 0) {
            this.storage.updateRoomTotalTokens(roomId, Math.floor(data.totalTokens))
            this.emitToRoomReaders(roomId, 'room_updated', { roomId, totalTokens: Math.floor(data.totalTokens) })
        }
    }

    private async handleInterruptAgent(socket: Socket, data: { roomId?: string; agentId?: string; agentName?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        const agentRef = data.agentId || data.agentName
        if (!roomId || !agentRef) {
            ack?.({ error: 'roomId and agentId are required' })
            return
        }
        const room = this.rooms.get(roomId)
        if (!room?.hasOnlineMember(socket.id)) {
            ack?.({ error: 'Not in room' })
            return
        }
        if (!this.canSocketManageRoom(socket, roomId)) {
            ack?.({ error: 'Access denied' })
            return
        }
        try {
            await this.agentClients.interruptAgent(roomId, agentName)
            this.emitToRoomReaders(roomId, 'context_status', { roomId, agentName, status: 'ready' })
            ack?.({ ok: true })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to interrupt agent ${agentRef} in room ${roomId}: ${err.message}`)
            ack?.({ error: err.message || 'interrupt failed' })
        }
    }

    private normalizeApprovalId(value: unknown): string | null {
        if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 512) return null
        return value
    }

    private normalizeApprovalChoice(value: unknown): ApprovalChoice | null {
        if (typeof value !== 'string') return null
        const normalized = value.trim().toLowerCase()
        return APPROVAL_CHOICE_SET.has(normalized) ? normalized as ApprovalChoice : null
    }

    private normalizeApprovalChoices(value: unknown, allowPermanent: boolean): ApprovalChoice[] {
        const source = Array.isArray(value) ? value : ['once', 'session', 'deny']
        const normalized: ApprovalChoice[] = []
        for (const rawChoice of source) {
            const choice = this.normalizeApprovalChoice(rawChoice)
            if (!choice || (choice === 'always' && !allowPermanent) || normalized.includes(choice)) continue
            normalized.push(choice)
        }
        if (!normalized.includes('deny')) normalized.push('deny')
        return normalized
    }

    private pruneStalePendingApprovals(): void {
        for (const [approvalId, binding] of this.pendingApprovals) {
            if (binding.conflicted) continue
            if (!this.agentIdentitySessionIsCurrent(binding.roomId, binding.agentId, binding.agentSessionId)) {
                this.pendingApprovals.delete(approvalId)
            }
        }
    }

    private bindPendingApproval(approvalId: string, binding: Omit<PendingApprovalBinding, 'responding' | 'responded' | 'conflicted'>): boolean {
        const existing = this.pendingApprovals.get(approvalId)
        if (existing) {
            const sameOrigin = existing.roomId === binding.roomId
                && existing.agentId === binding.agentId
                && existing.agentSessionId === binding.agentSessionId
                && existing.allowPermanent === binding.allowPermanent
                && existing.allowedChoices.length === binding.allowedChoices.length
                && existing.allowedChoices.every((choice, index) => choice === binding.allowedChoices[index])
            if (!sameOrigin) {
                existing.conflicted = true
                existing.responding = false
                existing.responded = true
            }
            // Duplicate events are suppressed; a mismatched origin permanently poisons
            // this globally addressed Bridge approval id for the server lifetime.
            return false
        }
        if (this.pendingApprovals.size >= MAX_PENDING_APPROVAL_BINDINGS) {
            this.pruneStalePendingApprovals()
            if (this.pendingApprovals.size >= MAX_PENDING_APPROVAL_BINDINGS) return false
        }
        this.pendingApprovals.set(approvalId, {
            ...binding,
            responding: false,
            responded: false,
            conflicted: false,
        })
        return true
    }

    private clearPendingApprovals(roomId: string, agentId?: string): void {
        for (const [approvalId, binding] of this.pendingApprovals) {
            if (binding.conflicted) continue
            if (binding.roomId === roomId && (!agentId || binding.agentId === agentId)) {
                this.pendingApprovals.delete(approvalId)
            }
        }
    }

    private handleApprovalRequested(socket: Socket, data: { roomId?: string; agentName?: string; agentSessionId?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        const approvalId = this.normalizeApprovalId(data.approval_id)
        const agentSessionId = typeof data.agentSessionId === 'string' ? data.agentSessionId.trim() : ''
        const member = roomId && approvalId
            ? this.getCurrentAgentEventMember(socket, roomId, agentName, agentSessionId)
            : null
        if (!roomId || !approvalId || !agentSessionId || !member) return
        const allowPermanent = data.allow_permanent === true
        const allowedChoices = this.normalizeApprovalChoices(data.choices, allowPermanent)
        if (!this.bindPendingApproval(approvalId, {
            roomId,
            agentId: member.userId,
            agentSessionId,
            allowedChoices,
            allowPermanent,
        })) return
        this.emitToRoomApprovalResponders(roomId, 'approval.requested', {
            event: 'approval.requested',
            roomId,
            agentName,
            approval_id: approvalId,
            command: data.command || '',
            description: data.description || '',
            choices: allowedChoices,
            allow_permanent: allowPermanent,
        })
    }

    private handleApprovalResolved(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string; agentSessionId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        const approvalId = this.normalizeApprovalId(data.approval_id)
        const agentSessionId = typeof data.agentSessionId === 'string' ? data.agentSessionId.trim() : ''
        const member = roomId && approvalId
            ? this.getCurrentAgentEventMember(socket, roomId, agentName, agentSessionId)
            : null
        const binding = approvalId ? this.pendingApprovals.get(approvalId) : undefined
        if (!roomId || !approvalId || !agentSessionId || !member || !binding || binding.conflicted) return
        if (binding.roomId !== roomId || binding.agentId !== member.userId || binding.agentSessionId !== agentSessionId) return
        const resolvedChoice = this.normalizeApprovalChoice(data.choice)
        const choice = resolvedChoice
            && binding.allowedChoices.includes(resolvedChoice)
            && (resolvedChoice !== 'always' || binding.allowPermanent)
            ? resolvedChoice
            : 'deny'
        this.pendingApprovals.delete(approvalId)
        this.emitToRoomApprovalResponders(roomId, 'approval.resolved', {
            event: 'approval.resolved',
            roomId,
            agentName,
            approval_id: approvalId,
            choice,
        })
    }

    private async handleApprovalRespond(socket: Socket, data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        const approvalId = this.normalizeApprovalId(data.approval_id)
        if (!roomId || !approvalId) {
            ack?.({ error: 'roomId and approval_id are required' })
            return
        }
        const room = this.rooms.get(roomId)
        if (!room?.hasOnlineMember(socket.id)) {
            ack?.({ error: 'Not in room' })
            return
        }
        const policy = this.socketAccessPolicy(socket, roomId)
        if (!policy.canRead) {
            this.removeUnauthorizedRoomSocket(socket, roomId)
            ack?.({ error: 'Access denied' })
            return
        }
        if (!policy.canApprove) {
            ack?.({ error: 'Access denied' })
            return
        }
        const binding = this.pendingApprovals.get(approvalId)
        const choice = this.normalizeApprovalChoice(data.choice)
        const targetIsCurrent = binding
            ? this.agentIdentitySessionIsCurrent(binding.roomId, binding.agentId, binding.agentSessionId)
            : false
        if (!binding
            || binding.roomId !== roomId
            || binding.conflicted
            || binding.responding
            || binding.responded
            || !targetIsCurrent
            || !choice
            || !binding.allowedChoices.includes(choice)
            || (choice === 'always' && !binding.allowPermanent)) {
            if (binding && !targetIsCurrent) this.pendingApprovals.delete(approvalId)
            ack?.({ error: 'Access denied' })
            return
        }
        binding.responding = true
        try {
            const result = await new AgentBridgeClient().approvalRespond(approvalId, choice)
            if (this.pendingApprovals.get(approvalId) !== binding || binding.conflicted) {
                ack?.({ error: 'Access denied' })
                return
            }
            binding.responding = false
            binding.responded = true
            ack?.({ ok: true, resolved: Boolean(result?.resolved) })
        } catch (err: any) {
            if (this.pendingApprovals.get(approvalId) === binding && !binding.conflicted) binding.responding = false
            logger.warn(`[GroupChat] failed to respond approval ${approvalId}: ${err.message}`)
            ack?.({ error: err.message || 'approval response failed' })
        }
    }

    private handleDisconnect(socket: Socket): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId)
        const userName = userId ? this.userInfoMap.get(userId)?.name : undefined

        logger.debug(`[GroupChat] Disconnected: ${userName || socketId} (socket=${socketId}, user=${userId || socketId})`)

        // Clean up typing state for this socket
        for (const [roomId, roomTyping] of this.typingState) {
            const entry = roomTyping.get(userId || socketId)
            if (entry) {
                clearTimeout(entry.timer)
                roomTyping.delete(userId || socketId)
                if (roomTyping.size === 0) this.typingState.delete(roomId)
            }
        }

        this.leaveAllRooms(socket, socketId)
        this.socketUserMap.delete(socketId)
        this.socketLocalSubjectIdMap.delete(socketId)
        this.socketRequestedSourceMap.delete(socketId)
        this.socketAuthUserIdMap.delete(socketId)
        // Don't delete userInfoMap — it persists across reconnects
    }

    // ─── Helpers ────────────────────────────────────────────────

    private getTypingUsers(roomId: string): Array<{ userId: string; userName: string }> {
        const roomTyping = this.typingState.get(roomId)
        if (!roomTyping) return []
        return Array.from(roomTyping.entries()).map(([userId, entry]) => ({ userId, userName: entry.userName }))
    }

    private getContextStatuses(roomId: string): Array<{ agentName: string; status: string }> {
        const roomStatuses = this.contextStatusState.get(roomId)
        if (!roomStatuses) return []
        return Array.from(roomStatuses.values())
    }

    private leaveAllRooms(socket: Socket, socketId: string): void {
        this.rooms.forEach((room, rid) => {
            if (room.hasOnlineMember(socketId)) {
                const member = room.getOnlineMemberBySocketId(socketId)
                room.removeMember(socketId)
                socket.leave(rid)
                if (member && member.source !== 'agent' && !room.hasOnlineUser(member.userId)) {
                    this.emitToRoomReaders(rid, 'member_left', {
                        roomId: rid,
                        memberId: member.userId,
                        memberName: member.name,
                        members: room.getMembersList(),
                    })
                }
            }
        })
    }

    private generateId(): string {
        return `gcm_${randomBytes(16).toString('hex')}`
    }

    private normalizeClientMessageId(id?: string): string | null {
        const cleaned = String(id || '').trim()
        if (!cleaned || cleaned.length > 160) return null
        return /^[a-zA-Z0-9_-]+$/.test(cleaned) ? cleaned : null
    }

    private normalizeMessageTimestamp(timestamp?: unknown, role?: unknown): number {
        const normalizedRole = normalizeMessageRole(role)
        if (normalizedRole !== 'user') {
            const value = Number(timestamp)
            if (Number.isFinite(value) && value > 0) return value
        }
        return Date.now()
    }
}
