import { Server, Socket, Namespace } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { mkdirSync } from 'fs'
import { basename, join } from 'path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { logger } from '../../../services/logger'
import { getDb } from '../../../db'
import { normalizeMessageContentForStorage, normalizeMessageContentForStorageRole } from '../../../db/hermes/message-content'
import {
    AgentClients,
    GROUP_CHAT_AGENT_SOCKET_SECRET,
    groupBridgeSessionId,
    type GroupChatRunService,
    type StructuredMention,
} from './agent-clients'
import { SessionDeleter } from '../session-deleter'
import { countTokens } from '../../../lib/context-compressor'
import { AgentBridgeClient } from '../agent-bridge'
import { respondToEkkoToolApproval } from '../../ekko-agent/approvals'
import { insertWorkspaceRunChange, deleteWorkspaceRunChangesForRoom, type SaveWorkspaceRunChangeInput, type WorkspaceRunChangeSummary } from '../../../db/hermes/workspace-run-changes-store'
import { authenticateUserToken, isAuthEnabled, type AuthenticatedUser } from '../../../middleware/user-auth'
import { getUserAvatar } from '../../../db/hermes/users-store'
import { config } from '../../../config'
import { createSocketIoCorsOrigin, shouldRejectUpgradeOrigin } from '../../../security'
import { paginateRecentGroupMessagesCanonical, sliceGroupMessagesCanonical, type GroupMessageCursorCutoff } from './group-message-ordering'
import { GroupRoomSummaryService, type GroupRoomSummary } from './room-summary'
import { isAgentMentioned, isAllAgentsMentioned, isReservedMentionName, resolveMentionTargets } from './mention-routing'
import { isGroupChatRoomOwner } from './access'
import { normalizeHumanGroupChatContent } from './attachments'
import { revokeGroupAgentConnector } from './agent-relay-store'
import type { ContentBlock } from '../run-chat/types'

// ─── Types ────────────────────────────────────────────────────

interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    senderType?: 'member' | 'agent'
    senderAgentRecordId?: string
    senderAvatar?: string
    senderAgentType?: RoomAgent['agent']
    senderAgentProfile?: string
    senderAgentProvider?: string
    senderAgentModel?: string
    senderAgentDescription?: string
    senderOwnerMemberId?: string
    content: string
    timestamp: number
    run_id?: string | null
    role?: string
    tool_call_id?: string | null
    tool_calls?: any[] | null
    tool_name?: string | null
    finish_reason?: string | null
    reasoning?: string | null
    reasoning_details?: string | null
    reasoning_content?: string | null
    persistedAt?: number
    mentions?: StructuredMention[]
    mentionDepth?: number
    agentSessionId?: string
}

type IncomingGroupChatMessage = Omit<Partial<ChatMessage>, 'content'> & {
    roomId?: string
    content: string | Array<Record<string, unknown>>
    id?: string
    mentionDepth?: number
}

interface PendingGroupApprovalRoute {
    roomId: string
    agentName: string
    agentSessionId: string
}

function contentToStorageString(content: unknown): string {
    if (typeof content === 'string') return content
    return JSON.stringify(content ?? '')
}

function humanStructuredContent(content: unknown): Array<Record<string, unknown>> | null {
    if (Array.isArray(content)) return content
    if (typeof content !== 'string') return null
    const trimmed = content.trim()
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null
    try {
        const parsed = JSON.parse(trimmed)
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

function safeGroupChatWorkspaceSegment(value: string, fallback: string): string {
    const segment = String(value || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim()
    return !segment || segment === '.' || segment === '..' ? fallback : segment
}

export function defaultGroupChatWorkspace(profile: string, roomId: string): string {
    return join(
        config.appHome,
        'group-chat',
        safeGroupChatWorkspaceSegment(profile, 'default'),
        safeGroupChatWorkspaceSegment(roomId, 'room'),
    )
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

interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    agent: 'hermes' | 'ekko' | 'codex' | 'claude'
    profile: string
    provider: string
    model: string
    apiMode: string
    reasoningEffort: string
    name: string
    description: string
    avatar: string
    invited: number
    executorType: 'server' | 'remote'
    ownerMemberId: string
    connectorId: string
    remoteOrigin: string
}

interface RoomAgentMetadata {
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude'
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    avatar?: string
    executorType?: 'server' | 'remote'
    ownerMemberId?: string
    connectorId?: string
    remoteOrigin?: string
}

export const ROOM_PARTICIPANT_NAME_CONFLICT = 'ROOM_PARTICIPANT_NAME_CONFLICT'

export class RoomParticipantNameConflictError extends Error {
    readonly code = ROOM_PARTICIPANT_NAME_CONFLICT

    constructor() {
        super('Name is already in use in this room')
        this.name = 'RoomParticipantNameConflictError'
    }
}

function canonicalParticipantName(name: string): string {
    return name.trim().normalize('NFKC').toLocaleLowerCase()
}

const GROUP_MEMBER_AVATAR_MAX_LENGTH = 1_500_000

function normalizeRoomMemberAvatar(value: unknown): string {
    if (value === undefined || value === null || value === '') return ''
    if (typeof value !== 'string' || value.length > GROUP_MEMBER_AVATAR_MAX_LENGTH) {
        throw new Error('Invalid member avatar')
    }
    let parsed: any
    try {
        parsed = JSON.parse(value)
    } catch {
        throw new Error('Invalid member avatar')
    }
    if (parsed?.type === 'generated' && typeof parsed.seed === 'string' && parsed.seed.trim() && parsed.seed.length <= 200) {
        return JSON.stringify({ type: 'generated', seed: parsed.seed.trim() })
    }
    if (
        parsed?.type === 'image' &&
        typeof parsed.dataUrl === 'string' &&
        /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(parsed.dataUrl) &&
        parsed.dataUrl.length <= GROUP_MEMBER_AVATAR_MAX_LENGTH
    ) {
        return JSON.stringify({ type: 'image', dataUrl: parsed.dataUrl })
    }
    throw new Error('Invalid member avatar')
}

export interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    summaryProfile: string
    summaryProvider: string
    summaryModel: string
    summaryApiMode: string
    summaryEveryTurns: number
    triggerTokens: number
    maxHistoryTokens: number
    tailMessageCount: number
    totalTokens: number
    sessionSeed: string
    workspace: string
    ownerAuthUserId: number | null
    allowGuestAgents: number
    guestAgentApproval: 'owner'
    maxGuestAgentsPerMember: number
    allowRemoteWorkspaceAccess: number
    createdAt: number
    lastActiveAt?: number
}

const ROOM_SELECT_COLUMNS = [
    'id',
    'name',
    'inviteCode',
    'summaryProfile',
    'summaryProvider',
    'summaryModel',
    'summaryApiMode',
    'summaryEveryTurns',
    'triggerTokens',
    'maxHistoryTokens',
    'tailMessageCount',
    'totalTokens',
    'sessionSeed',
    'workspace',
    'ownerAuthUserId',
    'allowGuestAgents',
    'guestAgentApproval',
    'maxGuestAgentsPerMember',
    'allowRemoteWorkspaceAccess',
    'createdAt',
].join(', ')

const ROOM_AGENT_SELECT_COLUMNS = [
    'id',
    'roomId',
    'agentId',
    'agent',
    'profile',
    'provider',
    'model',
    'apiMode',
    'reasoningEffort',
    'name',
    'description',
    'avatar',
    'invited',
    'executorType',
    'ownerMemberId',
    'connectorId',
    'remoteOrigin',
].join(', ')

const MESSAGE_SELECT_COLUMNS = [
    'id',
    'roomId',
    'senderId',
    'senderName',
    'senderType',
    'senderAgentRecordId',
    'content',
    'timestamp',
    'persistedAt',
    'mentions',
    'run_id',
    'role',
    'tool_call_id',
    'tool_calls',
    'tool_name',
    'finish_reason',
    'reasoning',
    'reasoning_details',
    'reasoning_content',
].join(', ')

function roomActivityAtSql(messageAlias: string): string {
    return `COALESCE(
        MAX(CASE
            WHEN COALESCE(${messageAlias}.role, '') <> 'tool'
             AND COALESCE(${messageAlias}.finish_reason, '') <> 'streaming'
            THEN NULLIF(${messageAlias}.persistedAt, 0)
        END),
        NULLIF(r.createdAt, 0),
        0
    )`
}

export interface RoomSummaryConfig {
    summaryProfile?: string
    summaryProvider?: string
    summaryModel?: string
    summaryApiMode?: string
    summaryEveryTurns?: number
}

interface SaveWorkspaceDiffMessageArgs {
    roomId: string
    senderId: string
    senderName: string
    sessionId: string
    runId: string
    responseRunId?: string
    status: 'completed' | 'failed' | 'aborted'
    workspace: string
    draft: SaveWorkspaceRunChangeInput
    parentMessageId?: string | null
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

type MemberView = Pick<Member, 'id' | 'userId' | 'name' | 'description' | 'joinedAt' | 'avatar'>

function authenticatedGroupUserId(authUserId: number): string {
    return `auth:${authUserId}`
}

function authenticatedUserProfiles(user: AuthenticatedUser | undefined): string[] {
    return Array.isArray(user?.profiles) ? user.profiles.map(String).filter(Boolean) : []
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

function parseStructuredMentions(value: unknown): StructuredMention[] {
    const parsed = parseJsonArray(value)
    if (!parsed) return []
    return parsed.flatMap((mention): StructuredMention[] => {
        if (!mention || typeof mention !== 'object') return []
        if (mention.type === 'all') return [{ type: 'all' }]
        if (mention.type === 'agent' && typeof mention.participantId === 'string' && mention.participantId) {
            return [{ type: 'agent', participantId: mention.participantId }]
        }
        return []
    })
}

function normalizeMessageRole(role: unknown): string {
    const value = String(role || '').trim()
    return ['user', 'assistant', 'tool', 'command'].includes(value) ? value : 'user'
}

function normalizeMentionDepth(depth: unknown): number {
    const value = Number(depth)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function maxAgentMentionDepth(): number {
    const value = Number(process.env.HERMES_GROUP_CHAT_MAX_AGENT_MENTION_DEPTH)
    if (!Number.isFinite(value) || value <= 0) return 4
    return Math.min(10, Math.floor(value))
}

class ChatStorage {
    private roomAgentOnlineProvider: ((roomId: string, agentId: string) => boolean) | null = null

    private db() { return getDb() }

    setRoomAgentOnlineProvider(provider: ((roomId: string, agentId: string) => boolean) | null): void {
        this.roomAgentOnlineProvider = provider
    }

    private mapStoredMessageRow(
        row: any,
        agentCache = new Map<string, RoomAgent | null>(),
        roomCache = new Map<string, RoomInfo | undefined>(),
    ): ChatMessage {
        const role = String(row.role || 'user')
        const mayBeAgent = row.senderType === 'agent'
            || Boolean(row.senderAgentRecordId)
            || (!row.senderType && (role === 'assistant' || role === 'tool'))
        const agentCacheKey = `${row.roomId || ''}\u0000${row.senderAgentRecordId || row.senderId || ''}`
        let agent = mayBeAgent ? agentCache.get(agentCacheKey) : null
        if (mayBeAgent && agent === undefined) {
            agent = this.getHistoricalMessageAgent(row)
            agentCache.set(agentCacheKey, agent)
        }
        const roomId = String(row.roomId || '')
        let room = agent ? roomCache.get(roomId) : undefined
        if (agent && room === undefined && !roomCache.has(roomId)) {
            room = this.getRoom(roomId)
            roomCache.set(roomId, room)
        }
        const ownerMemberId = agent?.ownerMemberId
            || (
                agent?.executorType === 'server' && Number(room?.ownerAuthUserId || 0) > 0
                    ? authenticatedGroupUserId(Number(room?.ownerAuthUserId))
                    : ''
            )
        const storedMentions = Object.prototype.hasOwnProperty.call(row, 'mentions')
            ? { mentions: parseStructuredMentions(row.mentions) }
            : {}
        return {
            ...row,
            senderType: agent || mayBeAgent ? 'agent' : 'member',
            ...(agent ? {
                senderAgentRecordId: agent.id,
                senderAvatar: agent.avatar || '',
                senderAgentType: agent.agent,
                senderAgentProfile: agent.profile || '',
                senderAgentProvider: agent.provider || '',
                senderAgentModel: agent.model || '',
                senderAgentDescription: agent.description || '',
                senderOwnerMemberId: ownerMemberId,
            } : {}),
            tool_calls: parseJsonArray(row.tool_calls),
            ...storedMentions,
        }
    }

    private getHistoricalMessageAgent(message: Pick<ChatMessage, 'roomId' | 'senderId' | 'senderName' | 'senderAgentRecordId'>): RoomAgent | null {
        const db = this.db()
        if (!db) return null
        const recordId = String(message.senderAgentRecordId || '').trim()
        if (recordId) {
            return (db.prepare(
                `SELECT ${ROOM_AGENT_SELECT_COLUMNS} FROM gc_room_agents WHERE roomId = ? AND id = ?`
            ).get(message.roomId, recordId) as RoomAgent | undefined) || null
        }
        return (db.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS}
             FROM gc_room_agents
             WHERE roomId = ? AND (id = ? OR agentId = ?)
             ORDER BY removedAt ASC
             LIMIT 1`
        ).get(message.roomId, message.senderId, message.senderId) as RoomAgent | undefined) || null
    }

    private snapshotMessageSender(msg: ChatMessage, existing?: ChatMessage | null): ChatMessage {
        if (existing?.senderType) {
            return {
                ...msg,
                senderType: existing.senderType,
                senderAgentRecordId: existing.senderAgentRecordId || '',
            }
        }
        if (msg.senderType) return msg

        const agent = this.getRoomAgents(msg.roomId).find(candidate =>
            candidate.id === msg.senderId
            || candidate.agentId === msg.senderId
            || candidate.name === msg.senderName
        )
        if (agent) {
            return {
                ...msg,
                senderType: 'agent',
                senderAgentRecordId: agent.id,
            }
        }

        return {
            ...msg,
            senderType: 'member',
            senderAgentRecordId: '',
        }
    }

    private compactMessageAgentMetadata(messages: ChatMessage[]): ChatMessage[] {
        const seenAgentRecords = new Set<string>()
        return messages.map((message) => {
            const recordId = String(message.senderAgentRecordId || '').trim()
            if (!recordId || !message.senderAgentType || !seenAgentRecords.has(recordId)) {
                if (recordId && message.senderAgentType) seenAgentRecords.add(recordId)
                return message
            }
            const {
                senderAvatar: _senderAvatar,
                senderAgentType: _senderAgentType,
                senderAgentProfile: _senderAgentProfile,
                senderAgentProvider: _senderAgentProvider,
                senderAgentModel: _senderAgentModel,
                senderAgentDescription: _senderAgentDescription,
                senderOwnerMemberId: _senderOwnerMemberId,
                ...compact
            } = message
            return compact
        })
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
        this.db()?.prepare(
            'INSERT INTO gc_session_profiles (session_id, room_id, agent_id, profile_name, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET room_id = excluded.room_id, agent_id = excluded.agent_id, profile_name = excluded.profile_name'
        ).run(sessionId, roomId, agentId, profileName, Date.now())
    }

    getSessionProfile(sessionId: string): GroupChatSessionProfile | null {
        return (this.db()?.prepare(
            'SELECT session_id, room_id, agent_id, profile_name, created_at FROM gc_session_profiles WHERE session_id = ?'
        ).get(sessionId) as GroupChatSessionProfile | undefined) ?? null
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

    claimPendingSessionDeletes(profileName: string, limit = 50): PendingSessionDelete[] {
        const rows = this.listPendingSessionDeletes(profileName, limit)
        if (rows.length === 0) return []
        const now = Date.now()
        const stmt = this.db()?.prepare(
            `UPDATE gc_pending_session_deletes
             SET status = 'processing', updated_at = ?
             WHERE session_id = ? AND status = 'pending'`
        )
        const claimed: PendingSessionDelete[] = []
        for (const row of rows) {
            const result = stmt?.run(now, row.session_id)
            if (result?.changes) {
                claimed.push({ ...row, status: 'processing', updated_at: now })
            }
        }
        return claimed
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
        return this.db()?.prepare(`SELECT ${ROOM_SELECT_COLUMNS} FROM gc_rooms WHERE id = ?`).get(roomId) as any
    }

    getRoomByInviteCode(code: string): RoomInfo | undefined {
        return this.db()?.prepare(`SELECT ${ROOM_SELECT_COLUMNS} FROM gc_rooms WHERE inviteCode = ?`).get(code) as any
    }

    getAllRooms(): RoomInfo[] {
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             LEFT JOIN gc_messages m ON m.roomId = r.id
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`,
        ).all() || []) as any[]
    }

    getRoomsForProfiles(profiles: string[]): RoomInfo[] {
        const uniqueProfiles = [...new Set(profiles.map(profile => profile.trim()).filter(Boolean))]
        if (!uniqueProfiles.length) return []
        const placeholders = uniqueProfiles.map(() => '?').join(', ')
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             INNER JOIN gc_room_agents a ON a.roomId = r.id
             LEFT JOIN gc_messages m ON m.roomId = r.id
             WHERE a.removedAt = 0
               AND a.executorType = 'server'
               AND a.profile IN (${placeholders})
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`
        ).all(...uniqueProfiles) || []) as any[]
    }

    getRoomsForAuthUser(authUserId: number): RoomInfo[] {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return []
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('messages')} AS lastActiveAt
             FROM gc_rooms r
             INNER JOIN gc_room_members m ON m.roomId = r.id
             LEFT JOIN gc_messages messages ON messages.roomId = r.id
             WHERE m.authUserId = ?
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`
        ).all(authUserId) || []) as any[]
    }

    getOwnedRoomsForAuthUser(authUserId: number): RoomInfo[] {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return []
        return (this.db()?.prepare(
            `SELECT ${ROOM_SELECT_COLUMNS.split(', ').map(column => `r.${column}`).join(', ')},
                    ${roomActivityAtSql('m')} AS lastActiveAt
             FROM gc_rooms r
             LEFT JOIN gc_messages m ON m.roomId = r.id
             WHERE r.ownerAuthUserId = ?
             GROUP BY r.id
             ORDER BY lastActiveAt DESC, r.id ASC`
        ).all(authUserId) || []) as any[]
    }

    saveRoom(id: string, name: string, inviteCode?: string, config?: RoomSummaryConfig & { workspace?: string; ownerAuthUserId?: number | null }): void {
        const rawOwnerAuthUserId = Number(config?.ownerAuthUserId ?? 0)
        const ownerAuthUserId = Number.isFinite(rawOwnerAuthUserId) && rawOwnerAuthUserId > 0 ? Math.floor(rawOwnerAuthUserId) : null
        this.db()?.prepare(
            `INSERT OR IGNORE INTO gc_rooms (
                id, name, inviteCode, summaryProfile, summaryProvider, summaryModel,
                summaryApiMode, summaryEveryTurns, workspace, ownerAuthUserId, createdAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id,
            name,
            inviteCode || null,
            String(config?.summaryProfile || 'default').trim() || 'default',
            String(config?.summaryProvider || '').trim(),
            String(config?.summaryModel || '').trim(),
            String(config?.summaryApiMode || '').trim(),
            Math.max(1, Math.floor(Number(config?.summaryEveryTurns || 20))),
            config?.workspace || '',
            ownerAuthUserId,
            Date.now(),
        )
    }

    setRoomOwnerAuthUserId(roomId: string, authUserId: number): void {
        if (!Number.isFinite(authUserId) || authUserId <= 0) return
        this.db()?.prepare('UPDATE gc_rooms SET ownerAuthUserId = ? WHERE id = ?').run(authUserId, roomId)
    }

    updateRoomGuestAgentPolicy(
        roomId: string,
        policy: {
            allowGuestAgents: boolean
            maxGuestAgentsPerMember: number
            allowRemoteWorkspaceAccess: boolean
        },
    ): RoomInfo | null {
        const maxAgents = Math.min(5, Math.max(1, Math.floor(policy.maxGuestAgentsPerMember || 1)))
        const allowRemoteWorkspaceAccess = policy.allowGuestAgents && policy.allowRemoteWorkspaceAccess
        this.db()?.prepare(
            `UPDATE gc_rooms
             SET allowGuestAgents = ?, guestAgentApproval = 'owner',
                 maxGuestAgentsPerMember = ?, allowRemoteWorkspaceAccess = ?
             WHERE id = ?`,
        ).run(policy.allowGuestAgents ? 1 : 0, maxAgents, allowRemoteWorkspaceAccess ? 1 : 0, roomId)
        return this.getRoom(roomId) || null
    }

    updateRoomConfig(roomId: string, config: RoomSummaryConfig): void {
        const sets: string[] = []
        const vals: any[] = []
        if (config.summaryProfile !== undefined) { sets.push('summaryProfile = ?'); vals.push(config.summaryProfile) }
        if (config.summaryProvider !== undefined) { sets.push('summaryProvider = ?'); vals.push(config.summaryProvider) }
        if (config.summaryModel !== undefined) { sets.push('summaryModel = ?'); vals.push(config.summaryModel) }
        if (config.summaryApiMode !== undefined) { sets.push('summaryApiMode = ?'); vals.push(config.summaryApiMode) }
        if (config.summaryEveryTurns !== undefined) { sets.push('summaryEveryTurns = ?'); vals.push(config.summaryEveryTurns) }
        if (sets.length === 0) return
        vals.push(roomId)
        this.db()?.prepare(`UPDATE gc_rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    updateRoomName(roomId: string, name: string): void {
        this.db()?.prepare('UPDATE gc_rooms SET name = ? WHERE id = ?').run(name, roomId)
    }

    updateRoomInviteCode(roomId: string, inviteCode: string): void {
        this.db()?.prepare('UPDATE gc_rooms SET inviteCode = ? WHERE id = ?').run(inviteCode, roomId)
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
        const seed = this.newRoomSessionSeed()
        this.db()?.prepare('UPDATE gc_rooms SET workspace = ?, sessionSeed = ? WHERE id = ?').run(nextWorkspace, seed, roomId)
        return this.getRoom(roomId) || null
    }

    private newRoomSessionSeed(): string {
        return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
            .reduce((sum, m) => {
                const reasoning = (m as { reasoning_content?: unknown; reasoning?: unknown }).reasoning_content
                    ?? (m as { reasoning?: unknown }).reasoning
                return (
                    sum
                    + countTokens(this.contentToUsageText(m.content))
                    + countTokens(String(m.tool_calls || ''))
                    + countTokens(String(reasoning || ''))
                )
            }, 0)
        return { inputTokens, outputTokens }
    }

    private estimateRoomTotalTokens(roomId: string, messages: ChatMessage[]): number {
        const usage = this.estimateUsageTokensFromMessages(messages)
        return usage.inputTokens + usage.outputTokens
    }

    // ─── Messages ─────────────────────────────────────────────

    getRecentMessagesForUI(roomId: string, limit = 150, offset = 0): ChatMessage[] {
        const rows = (this.db()?.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages WHERE roomId = ?`
        ).all(roomId) || []) as any[]
        const page = paginateRecentGroupMessagesCanonical(rows, { limit, offset })
        const agentCache = new Map<string, RoomAgent | null>()
        const roomCache = new Map<string, RoomInfo | undefined>()
        return this.compactMessageAgentMetadata(
            page.map(row => this.mapStoredMessageRow(row, agentCache, roomCache)),
        )
    }

    getMessagesForContext(roomId: string, cutoff?: GroupMessageCursorCutoff): ChatMessage[] {
        const rows = (this.db()?.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS}
             FROM gc_messages
             WHERE roomId = ? AND COALESCE(tool_name, '') <> 'workspace_diff'`
        ).all(roomId) || []) as any[]
        const agentCache = new Map<string, RoomAgent | null>()
        const roomCache = new Map<string, RoomInfo | undefined>()
        return sliceGroupMessagesCanonical(
            rows.map(row => this.mapStoredMessageRow(row, agentCache, roomCache)),
            cutoff,
        ).messages
    }

    getMessageCount(roomId: string): number {
        const row = this.db()?.prepare(
            'SELECT COUNT(*) as total FROM gc_messages WHERE roomId = ?'
        ).get(roomId) as { total: number } | undefined
        return row?.total || 0
    }

    getMessage(messageId: string): ChatMessage | null {
        const row = this.db()?.prepare(
            `SELECT ${MESSAGE_SELECT_COLUMNS} FROM gc_messages WHERE id = ?`
        ).get(messageId) as any
        if (!row) return null
        return this.mapStoredMessageRow(row)
    }

    addMessage(msg: ChatMessage): void {
        this.upsertMessage(msg)
    }

    upsertMessage(msg: ChatMessage, existing?: ChatMessage | null): ChatMessage {
        const storedMessage = this.snapshotMessageSender(msg, existing ?? this.getMessage(msg.id))
        const toolCallsJson = storedMessage.tool_calls ? JSON.stringify(storedMessage.tool_calls) : null
        const mentionsJson = JSON.stringify(storedMessage.mentions || [])
        this.db()?.prepare(
            `INSERT INTO gc_messages (
                id, roomId, senderId, senderName, senderType, senderAgentRecordId,
                content, timestamp, persistedAt, mentions, run_id, role, tool_call_id,
                tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            + ` ON CONFLICT(id) DO UPDATE SET
                roomId = excluded.roomId,
                senderId = excluded.senderId,
                senderName = excluded.senderName,
                senderType = excluded.senderType,
                senderAgentRecordId = excluded.senderAgentRecordId,
                content = excluded.content,
                timestamp = excluded.timestamp,
                persistedAt = excluded.persistedAt,
                mentions = excluded.mentions,
                run_id = excluded.run_id,
                role = excluded.role,
                tool_call_id = excluded.tool_call_id,
                tool_calls = excluded.tool_calls,
                tool_name = excluded.tool_name,
                finish_reason = excluded.finish_reason,
                reasoning = excluded.reasoning,
                reasoning_details = excluded.reasoning_details,
                reasoning_content = excluded.reasoning_content`
        ).run(
            storedMessage.id,
            storedMessage.roomId,
            storedMessage.senderId,
            storedMessage.senderName,
            storedMessage.senderType || 'member',
            storedMessage.senderAgentRecordId || '',
            messageContentForStorage(storedMessage.role, storedMessage.content),
            storedMessage.timestamp,
            storedMessage.persistedAt ?? Date.now(),
            mentionsJson,
            storedMessage.run_id ?? null,
            storedMessage.role || 'user',
            storedMessage.tool_call_id ?? null,
            toolCallsJson,
            storedMessage.tool_name ?? null,
            storedMessage.finish_reason ?? null,
            storedMessage.reasoning ?? null,
            storedMessage.reasoning_details ?? null,
            storedMessage.reasoning_content ?? null,
        )
        return this.mapStoredMessageRow(storedMessage)
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
                run_id: args.responseRunId || null,
                role: 'tool',
                tool_call_id: `workspace_diff:${args.runId}`,
                tool_calls: null,
                tool_name: 'workspace_diff',
            }
            const storedMessage = this.upsertMessage(message)
            this.pruneMessages(args.roomId)
            const messages = this.getMessagesForContext(args.roomId)
            const totalTokens = this.estimateRoomTotalTokens(args.roomId, messages)
            this.updateRoomTotalTokens(args.roomId, totalTokens)
            db.exec('COMMIT')
            return { message: storedMessage, totalTokens, change }
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    saveMessageAndRefreshRoom(msg: ChatMessage, options: { preserveExistingTimestamp?: boolean } = {}): { message: ChatMessage; totalTokens: number } {
        const db = this.db()
        if (!db) return { message: msg, totalTokens: 0 }
        db.exec('BEGIN IMMEDIATE')
        try {
            const existing = this.getMessage(msg.id)
            if (existing?.tool_name === 'workspace_diff') {
                const messages = this.getMessagesForContext(existing.roomId)
                const totalTokens = this.estimateRoomTotalTokens(existing.roomId, messages)
                db.exec('COMMIT')
                return { message: existing, totalTokens }
            }
            const safeMsg = msg.tool_name === 'workspace_diff'
                ? { ...msg, role: 'user', tool_call_id: null, tool_calls: null, tool_name: null }
                : msg
            const message = existing && options.preserveExistingTimestamp ? { ...safeMsg, timestamp: existing.timestamp } : safeMsg
            const storedMessage = this.upsertMessage(message, existing)
            this.pruneMessages(msg.roomId)
            const messages = this.getMessagesForContext(msg.roomId)
            const totalTokens = this.estimateRoomTotalTokens(msg.roomId, messages)
            this.updateRoomTotalTokens(msg.roomId, totalTokens)
            db.exec('COMMIT')
            return { message: storedMessage, totalTokens }
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    private deleteWorkspaceDiffChanges(roomId: string, beforeTimestamp?: number): void {
        const db = this.db()
        if (!db) return
        deleteWorkspaceRunChangesForRoom(db, roomId, beforeTimestamp)
    }

    private withImmediateTransaction(db: any, fn: () => void): void {
        if (db.inTransaction || db.isTransaction) {
            fn()
            return
        }
        db.exec('BEGIN IMMEDIATE')
        try {
            fn()
            db.exec('COMMIT')
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    clearRoomContext(roomId: string): void {
        const db = this.db()
        if (!db) return
        this.withImmediateTransaction(db, () => {
            this.deleteWorkspaceDiffChanges(roomId)
            db.prepare(
                `UPDATE gc_agent_connectors
                 SET status = 'revoked', revokedAt = ?, lastSeenAt = ?
                 WHERE roomId = ? AND status != 'revoked'`,
            ).run(Date.now(), Date.now(), roomId)
            db.prepare('DELETE FROM gc_agent_pairing_requests WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_agents WHERE roomId = ? AND removedAt > 0').run(roomId)
            db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_summaries WHERE roomId = ?').run(roomId)
            db.prepare('UPDATE gc_rooms SET totalTokens = 0, sessionSeed = ? WHERE id = ?').run(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, roomId)
        })
    }

    pruneMessages(roomId: string, keep = 500): void {
        const db = this.db()
        if (!db) return
        const count = (db.prepare('SELECT COUNT(*) as c FROM gc_messages WHERE roomId = ?').get(roomId) as any)?.c
        if (count > keep) {
            const cutoff = db.prepare(
                'SELECT timestamp FROM gc_messages WHERE roomId = ? ORDER BY timestamp DESC LIMIT 1 OFFSET ?'
            ).get(roomId, keep - 1) as any
            if (cutoff) {
                this.withImmediateTransaction(db, () => {
                    this.deleteWorkspaceDiffChanges(roomId, cutoff.timestamp)
                    const result = db.prepare('DELETE FROM gc_messages WHERE roomId = ? AND timestamp < ?').run(roomId, cutoff.timestamp)
                    logger.info(`[GroupChat] pruned ${result.changes} messages from room ${roomId} (had ${count}, keeping ${keep})`)
                })
            }
        }
    }

    // ─── Room Agents ──────────────────────────────────────────

    getRoomAgents(roomId: string): RoomAgent[] {
        return (this.db()?.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS} FROM gc_room_agents WHERE roomId = ? AND removedAt = 0`
        ).all(roomId) || []) as unknown as RoomAgent[]
    }

    getMentionableRoomAgents(roomId: string): RoomAgent[] {
        const agents = this.getRoomAgents(roomId)
        if (!this.roomAgentOnlineProvider) return agents
        return agents.filter(agent => this.roomAgentOnlineProvider?.(roomId, agent.agentId) === true)
    }

    assertParticipantNameAvailable(
        roomId: string,
        name: string,
        options: { excludeAgentRef?: string; excludeMemberId?: string } = {},
    ): void {
        const canonicalName = canonicalParticipantName(name)
        if (!canonicalName) return

        const conflictingAgent = this.getRoomAgents(roomId).find(agent =>
            agent.id !== options.excludeAgentRef &&
            agent.agentId !== options.excludeAgentRef &&
            canonicalParticipantName(agent.name) === canonicalName
        )
        if (conflictingAgent) throw new RoomParticipantNameConflictError()

        const conflictingMember = this.getRoomMembers(roomId).find(member =>
            member.id !== options.excludeMemberId &&
            canonicalParticipantName(member.name) === canonicalName
        )
        if (conflictingMember) throw new RoomParticipantNameConflictError()
    }

    addRoomAgent(
        roomId: string,
        agentId: string,
        profile: string,
        name: string,
        description: string,
        invited: number,
        metadata: RoomAgentMetadata = {},
    ): RoomAgent {
        this.assertParticipantNameAvailable(roomId, name)
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        const agent = metadata.agent || 'hermes'
        const provider = String(metadata.provider || '').trim()
        const model = String(metadata.model || '').trim()
        const apiMode = agent === 'hermes' ? '' : String(metadata.apiMode || '').trim()
        const reasoningEffort = String(metadata.reasoningEffort || '').trim()
        const avatar = String(metadata.avatar || '').trim()
        const executorType = metadata.executorType === 'remote' ? 'remote' : 'server'
        const ownerMemberId = String(metadata.ownerMemberId || '').trim()
        const connectorId = String(metadata.connectorId || '').trim()
        const remoteOrigin = String(metadata.remoteOrigin || '').trim()
        this.db()?.prepare(
            `INSERT INTO gc_room_agents (
                id, roomId, agentId, agent, profile, provider, model, apiMode,
                reasoningEffort, name, description, avatar, invited,
                executorType, ownerMemberId, connectorId, remoteOrigin
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            id, roomId, agentId, agent, profile, provider, model, apiMode,
            reasoningEffort, name, description, avatar, invited,
            executorType, ownerMemberId, connectorId, remoteOrigin,
        )
        return {
            id, roomId, agentId, agent, profile, provider, model, apiMode,
            reasoningEffort, name, description, avatar, invited,
            executorType, ownerMemberId, connectorId, remoteOrigin,
        }
    }

    getRoomAgent(roomId: string, agentRef: string): RoomAgent | null {
        return (this.db()?.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS}
             FROM gc_room_agents
             WHERE roomId = ? AND removedAt = 0 AND (id = ? OR agentId = ?)`
        ).get(roomId, agentRef, agentRef) as any) ?? null
    }

    getRoomAgentByAgentId(roomId: string, agentId: string): RoomAgent | null {
        return (this.db()?.prepare(
            `SELECT ${ROOM_AGENT_SELECT_COLUMNS}
             FROM gc_room_agents
             WHERE roomId = ? AND removedAt = 0 AND agentId = ?`
        ).get(roomId, agentId) as any) ?? null
    }

    updateRoomAgent(
        roomId: string,
        agentRef: string,
        profile: string,
        name: string,
        description: string,
        metadata: RoomAgentMetadata = {},
    ): RoomAgent | null {
        const existing = this.getRoomAgent(roomId, agentRef)
        if (!existing) return null
        this.assertParticipantNameAvailable(roomId, name, { excludeAgentRef: existing.id })
        const agent = metadata.agent || 'hermes'
        const provider = String(metadata.provider || '').trim()
        const model = String(metadata.model || '').trim()
        const apiMode = agent === 'hermes' ? '' : String(metadata.apiMode || '').trim()
        const reasoningEffort = String(metadata.reasoningEffort || '').trim()
        const avatar = String(metadata.avatar || '').trim()
        this.db()?.prepare(
            `UPDATE gc_room_agents
             SET agent = ?, profile = ?, provider = ?, model = ?, apiMode = ?, reasoningEffort = ?, name = ?, description = ?, avatar = ?
             WHERE roomId = ? AND removedAt = 0 AND (id = ? OR agentId = ?)`
        ).run(agent, profile, provider, model, apiMode, reasoningEffort, name, description, avatar, roomId, agentRef, agentRef)
        return this.getRoomAgent(roomId, agentRef)
    }

    updateRoomAgentRelayMetadata(
        roomId: string,
        agentRef: string,
        metadata: { connectorId: string; remoteOrigin: string },
    ): RoomAgent | null {
        this.db()?.prepare(
            `UPDATE gc_room_agents
             SET executorType = 'remote', connectorId = ?, remoteOrigin = ?
             WHERE roomId = ? AND removedAt = 0 AND (id = ? OR agentId = ?)`,
        ).run(metadata.connectorId, metadata.remoteOrigin, roomId, agentRef, agentRef)
        return this.getRoomAgent(roomId, agentRef)
    }

    removeRoomAgent(roomId: string, agentRef: string): void {
        const db = this.db()
        if (!db) return
        const agent = this.getRoomAgent(roomId, agentRef)
        if (!agent) return
        this.removeRoomMembersForAgent(roomId, agent)
        db.prepare(
            `UPDATE gc_messages
             SET senderType = 'agent', senderAgentRecordId = ?
             WHERE roomId = ?
               AND COALESCE(senderAgentRecordId, '') = ''
               AND (
                    senderId = ?
                    OR senderId = ?
                    OR (senderName = ? AND role IN ('assistant', 'tool'))
               )`
        ).run(agent.id, roomId, agent.id, agent.agentId, agent.name)
        db.prepare(
            `UPDATE gc_room_agents
             SET removedAt = ?, connectorId = '', remoteOrigin = ''
             WHERE roomId = ? AND removedAt = 0 AND id = ?`
        ).run(Date.now(), roomId, agent.id)
    }

    // ─── Rolling Room Summary ───────────────────────────────

    getRoomSummary(roomId: string): GroupRoomSummary | null {
        return (this.db()?.prepare(
            `SELECT roomId, summary, summaryThroughMessageId, summaryThroughMessageTimestamp,
                    summarizedTurnCount, status, version, updatedAt, lastError
             FROM gc_room_summaries WHERE roomId = ?`
        ).get(roomId) as any) ?? null
    }

    saveRoomSummary(summary: GroupRoomSummary): void {
        this.db()?.prepare(
            `INSERT INTO gc_room_summaries (
                roomId, summary, summaryThroughMessageId, summaryThroughMessageTimestamp,
                summarizedTurnCount, status, version, updatedAt, lastError
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(roomId) DO UPDATE SET
                summary = excluded.summary,
                summaryThroughMessageId = excluded.summaryThroughMessageId,
                summaryThroughMessageTimestamp = excluded.summaryThroughMessageTimestamp,
                summarizedTurnCount = excluded.summarizedTurnCount,
                status = excluded.status,
                version = excluded.version,
                updatedAt = excluded.updatedAt,
                lastError = excluded.lastError`
        ).run(
            summary.roomId,
            summary.summary,
            summary.summaryThroughMessageId,
            summary.summaryThroughMessageTimestamp,
            summary.summarizedTurnCount,
            summary.status,
            summary.version,
            summary.updatedAt,
            summary.lastError,
        )
    }

    deleteRoom(roomId: string): void {
        const db = this.db()
        if (!db) return
        this.withImmediateTransaction(db, () => {
            this.deleteWorkspaceDiffChanges(roomId)
            db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_agents WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_members WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
            db.prepare('DELETE FROM gc_room_summaries WHERE roomId = ?').run(roomId)
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
                   AND a.removedAt = 0
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

    removeRoomMember(roomId: string, userId: string): void {
        this.db()?.prepare(
            'DELETE FROM gc_room_members WHERE roomId = ? AND userId = ?'
        ).run(roomId, userId)
    }

    addRoomMember(roomId: string, userId: string, userName: string, description: string, avatar: string = '', authUserId?: number): void {
        const existing = this.getMemberByUserId(roomId, userId) ||
            (typeof authUserId === 'number' && authUserId > 0 ? this.getMemberByAuthUserId(roomId, authUserId) : null)
        this.assertParticipantNameAvailable(roomId, userName, { excludeMemberId: existing?.id })

        let resolvedAvatar = avatar
        if (!resolvedAvatar && typeof authUserId === 'number' && authUserId > 0) {
            try {
                resolvedAvatar = getUserAvatar(authUserId) || ''
            } catch {
                // ignore lookup failures
            }
        }
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
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
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

    constructor(id: string, name?: string) {
        this.id = id
        this.name = name || id
    }

    addOrUpdateMember(socketId: string, userId: string, name: string, description: string, source: 'human' | 'agent' = 'human', avatar: string = ''): Member {
        const existing = this.members.get(userId)
        if (existing) {
            existing.name = name
            existing.description = description
            existing.online = true
            existing.socketId = socketId
            existing.source = source
            if (avatar) existing.avatar = avatar
            return existing
        }
        const member: Member = { id: socketId, userId, name, description, joinedAt: Date.now(), online: true, socketId, source, avatar }
        this.members.set(userId, member)
        return member
    }

    removeMember(socketId: string): void {
        for (const member of this.members.values()) {
            if (member.socketId === socketId) {
                member.online = false
                break
            }
        }
    }

    removeUser(userId: string): Member | null {
        const member = this.members.get(userId) || null
        if (member) this.members.delete(userId)
        return member
    }

    getMembersList(): Member[] {
        return Array.from(this.members.values()).filter(member => member.source !== 'agent')
    }

    getOnlineMemberBySocketId(socketId: string): Member | undefined {
        for (const member of this.members.values()) {
            if (member.socketId === socketId && member.online) return member
        }
        return undefined
    }

    hasOnlineMember(socketId: string): boolean {
        return this.getOnlineMemberBySocketId(socketId) !== undefined
    }
}

// ─── GroupChat Server ────────────────────────────────────────

export class GroupChatServer {
    private io: Server
    private nsp: Namespace
    private storage: ChatStorage
    private rooms = new Map<string, ChatRoom>()
    /** Map: socket.id → persistent userId */
    private socketUserMap = new Map<string, string>()
    /** Map: userId → { name, description } (from auth) */
    private userInfoMap = new Map<string, { name: string; description: string }>()
    /** Map: socket.id → requested participant source from handshake */
    private socketRequestedSourceMap = new Map<string, 'human' | 'agent'>()
    /** Map: socket.id → numeric users.id from the web UI auth (for avatar resolution) */
    private socketAuthUserIdMap = new Map<string, number>()
    readonly agentClients = new AgentClients()
    private roomSummaryService: GroupRoomSummaryService
    private _restoreScheduled = false
    private chatRunService: GroupChatRunService | null = null
    /** roomId -> (userId -> { userName, timer }) */
    private typingState = new Map<string, Map<string, { userName: string; timer: ReturnType<typeof setTimeout> }>>()
    /**
     * Transient activity restored to browsers when they join/reconnect.
     * Keep the runtime session id internally so a terminal event from the
     * just-finished ephemeral run can clear its own status without clearing a
     * newer run for the same Agent.
     */
    private contextStatusState = new Map<string, Map<string, {
        agentName: string
        status: string
        agentSessionId?: string
    }>>()
    /** room-scoped approval locator -> validated room and runtime session that requested it. */
    private pendingApprovalRoutes = new Map<string, PendingGroupApprovalRoute>()

    private pendingApprovalRouteKey(roomId: string, approvalId: string): string {
        return `${roomId}:${approvalId}`
    }
    /** roomId -> blocked Bridge session ids from room-level interrupts/rotations. */
    private fencedRoomAgentSessions = new Map<string, Set<string>>()
    /** A short-lived proof that an invite guest actually joined as this room member. */
    private guestAgentRequestTokens = new Map<string, { hash: Buffer; expiresAt: number; socketId: string }>()

    constructor(httpServers: HttpServer | HttpServer[]) {
        this.storage = new ChatStorage()
        this.storage.init()
        const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

        this.io = new Server(servers[0], {
            cors: { origin: createSocketIoCorsOrigin(config.corsOrigins) },
            maxHttpBufferSize: 2_000_000,
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

        this.roomSummaryService = new GroupRoomSummaryService(this.storage, (summary) => {
            this.nsp.to(summary.roomId).emit('room_summary_updated', summary)
        })
        this.agentClients.setStorage(this.storage)
        this.storage.setRoomAgentOnlineProvider((roomId, agentId) =>
            this.agentClients.getAgent(roomId, agentId)?.connected === true
        )
        this.agentClients.setRoomSummaryService(this.roomSummaryService)
        this.agentClients.setActivityBroadcaster((roomId, agentName, status) => {
            let roomStatuses = this.contextStatusState.get(roomId)
            if (status === 'ready') {
                roomStatuses?.delete(agentName)
                if (roomStatuses?.size === 0) this.contextStatusState.delete(roomId)
            } else {
                if (!roomStatuses) {
                    roomStatuses = new Map()
                    this.contextStatusState.set(roomId, roomStatuses)
                }
                roomStatuses.set(agentName, { agentName, status })
            }
            this.nsp.to(roomId).emit('context_status', { roomId, agentName, status })
        })
        this.agentClients.setWorkspaceDiffBroadcaster((roomId, msg, totalTokens) => {
            this.nsp.to(roomId).emit('message', msg)
            this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens })
        })
        // Restore agent connections — call restoreAgents() after server is listening
        this._restoreScheduled = false
    }

    getIO(): Server {
        return this.io
    }

    getStorage(): ChatStorage {
        return this.storage
    }

    getRoomSummaryService(): GroupRoomSummaryService {
        return this.roomSummaryService
    }

    getChatRunService(): GroupChatRunService | null {
        return this.chatRunService
    }

    authorizeGuestAgentRequestToken(roomId: string, userId: string, token: string): boolean {
        const key = `${roomId}\u0000${userId}`
        const entry = this.guestAgentRequestTokens.get(key)
        if (!entry || entry.expiresAt <= Date.now() || !token) {
            if (entry?.expiresAt && entry.expiresAt <= Date.now()) this.guestAgentRequestTokens.delete(key)
            return false
        }
        const actual = createHash('sha256').update(token).digest()
        return actual.length === entry.hash.length && timingSafeEqual(actual, entry.hash)
    }

    private issueGuestAgentRequestToken(roomId: string, userId: string, socketId: string): string {
        const token = randomBytes(32).toString('base64url')
        this.guestAgentRequestTokens.set(`${roomId}\u0000${userId}`, {
            hash: createHash('sha256').update(token).digest(),
            expiresAt: Date.now() + 60 * 60_000,
            socketId,
        })
        return token
    }

    broadcastAgentPairingRequest(roomId: string, request: Record<string, unknown>): void {
        this.emitToRoomManagers(roomId, 'agent_pairing_requested', { roomId, request })
    }

    broadcastAgentPairingUpdated(roomId: string, request: Record<string, unknown>): void {
        this.emitToRoomManagers(roomId, 'agent_pairing_updated', { roomId, request })
    }

    broadcastGuestAgentPolicy(roomId: string, room: RoomInfo): void {
        this.nsp.to(roomId).emit('room_updated', {
            roomId,
            allowGuestAgents: Number(room.allowGuestAgents || 0),
            guestAgentApproval: 'owner',
            maxGuestAgentsPerMember: Math.max(1, Number(room.maxGuestAgentsPerMember || 1)),
            allowRemoteWorkspaceAccess: Number(room.allowRemoteWorkspaceAccess || 0),
        })
    }

    ensureDefaultRoomWorkspace(roomId: string, profile: string): string {
        const workspace = defaultGroupChatWorkspace(profile, roomId)
        mkdirSync(workspace, { recursive: true })
        return workspace
    }

    updateRoomName(roomId: string, name: string): RoomInfo | null {
        const normalizedName = String(name || '').trim()
        const runtimeRoom = this.rooms.get(roomId)
        if (!normalizedName) return null
        this.storage.updateRoomName(roomId, normalizedName)
        if (runtimeRoom) runtimeRoom.name = normalizedName
        const room = this.storage.getRoom(roomId) || null
        if (room) {
            this.nsp.to(roomId).emit('room_updated', {
                roomId,
                name: room.name,
                totalTokens: room.totalTokens,
            })
        }
        return room
    }

    getRoomAgentViews(
        roomId: string,
        _includeManageFields = false,
        viewerMemberId = '',
    ): Array<Record<string, unknown>> {
        const room = typeof this.storage.getRoom === 'function'
            ? this.storage.getRoom(roomId)
            : null
        const roomOwnerAuthUserId = Number(room?.ownerAuthUserId || 0)
        const roomOwnerMemberId = roomOwnerAuthUserId > 0
            ? authenticatedGroupUserId(roomOwnerAuthUserId)
            : ''
        return this.storage.getRoomAgents(roomId).map(agent => {
            const { ownerMemberId, connectorId, remoteOrigin, ...visible } = agent
            const executor = this.agentClients?.getAgent?.(roomId, agent.agentId)
            const displayOwnerMemberId = ownerMemberId
                || (agent.executorType === 'server' ? roomOwnerMemberId : '')
            const canManageAgent = agent.executorType === 'remote'
                && Boolean(viewerMemberId)
                && displayOwnerMemberId === viewerMemberId
            return {
                ...visible,
                connectionStatus: executor?.connected ? 'online' : 'offline',
                ...(displayOwnerMemberId ? { ownerMemberId: displayOwnerMemberId } : {}),
                ...(canManageAgent ? { connectorId, remoteOrigin } : {}),
            }
        })
    }

    private getRoomMemberViews(roomId: string, room = this.rooms.get(roomId)): MemberView[] {
        const storedMembers = typeof this.storage.getRoomMembers === 'function'
            ? this.storage.getRoomMembers(roomId)
            : []
        if (storedMembers.length > 0) return storedMembers
        return (room?.getMembersList() || []).map(({
            id,
            userId,
            name,
            description,
            joinedAt,
            avatar,
        }) => ({
            id,
            userId,
            name,
            description,
            joinedAt,
            avatar,
        }))
    }

    broadcastRoomAgents(roomId: string): RoomAgent[] {
        const agents = this.storage.getRoomAgents(roomId)
        this.nsp.to(roomId).emit('agents_updated', {
            roomId,
            agents: this.getRoomAgentViews(roomId, false),
        })
        this.emitToRoomManagers(roomId, 'agents_updated', {
            roomId,
            agents: this.getRoomAgentViews(roomId, true),
        })
        for (const socket of this.nsp.sockets?.values?.() || []) {
            if (
                !socket.rooms?.has(roomId)
                || this.socketRequestedSourceMap.get(socket.id) === 'agent'
                || this.canSocketManageRoom(socket, roomId)
            ) continue
            const userId = this.socketUserMap.get(socket.id)
            if (!userId) continue
            socket.emit('agents_updated', {
                roomId,
                agents: this.getRoomAgentViews(roomId, false, userId),
            })
        }
        return agents
    }

    removeRoomMember(roomId: string, userId: string): MemberView[] | null {
        const normalizedUserId = String(userId || '').trim()
        if (!normalizedUserId) return null
        const room = this.rooms.get(roomId)
        const storedMember = typeof this.storage.getMemberByUserId === 'function'
            ? this.storage.getMemberByUserId(roomId, normalizedUserId)
            : null
        const onlineMember = room?.members.get(normalizedUserId) || null
        if (!storedMember && !onlineMember) return null

        room?.removeUser(normalizedUserId)
        this.storage.removeRoomMember?.(roomId, normalizedUserId)

        for (const socket of this.nsp.sockets?.values?.() || []) {
            if (
                this.socketUserMap.get(socket.id) !== normalizedUserId
                || !socket.rooms?.has(roomId)
            ) continue
            socket.emit('member_kicked', { roomId })
            socket.leave(roomId)
        }

        const members = this.getRoomMemberViews(roomId, room)
        this.nsp.to(roomId).emit('member_left', {
            roomId,
            memberId: normalizedUserId,
            memberName: onlineMember?.name || storedMember?.name || normalizedUserId,
            members,
        })
        return members
    }

    setChatRunService(service: GroupChatRunService | null): void {
        this.chatRunService = service
        this.agentClients.setChatRunService(service)
    }

    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    fenceCurrentRoomAgentSessions(roomId: string): () => void {
        const activeIds = typeof this.agentClients?.activeSessionIds === 'function'
            ? this.agentClients.activeSessionIds(roomId)
            : []
        const ids = new Set(activeIds)
        if (ids.size === 0 && typeof this.storage?.getRoomAgents === 'function') {
            const room = this.storage.getRoom(roomId)
            for (const agent of this.storage.getRoomAgents(roomId) || []) {
                ids.add(groupBridgeSessionId(roomId, agent.profile, agent.name, String(room?.sessionSeed || '0'), {
                    agent: agent.agent,
                    provider: agent.provider,
                    model: agent.model,
                    apiMode: agent.apiMode,
                    reasoningEffort: agent.reasoningEffort,
                }))
            }
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

    async clearRoomRuntimeState(roomId: string): Promise<void> {
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.clearPendingApprovalRoutes(roomId)
        const releaseSessionFence = this.fenceCurrentRoomAgentSessions(roomId)
        try {
            await this.agentClients.interruptRoom(roomId)
        } catch (err) {
            releaseSessionFence()
            throw err
        }
        this.agentClients.resetRoomContext(roomId)
        this.nsp.to(roomId).emit('room_cleared', { roomId, totalTokens: 0 })
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens: 0 })
    }

    async deleteRoomRuntimeState(roomId: string): Promise<void> {
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.clearPendingApprovalRoutes(roomId)
        const releaseSessionFence = this.fenceCurrentRoomAgentSessions(roomId)
        try {
            await this.agentClients.interruptRoom(roomId)
        } catch (err) {
            releaseSessionFence()
            throw err
        }
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
    }

    private async restoreAgents(): Promise<void> {
        const rooms = this.storage.getAllRooms()
        let total = 0

        for (const room of rooms) {
            const agents = this.storage.getRoomAgents(room.id)
            for (const agent of agents) {
                if (agent.executorType === 'remote') continue
                try {
                    const client = await this.agentClients.createAgent({
                        agentId: agent.agentId,
                        agent: agent.agent,
                        profile: agent.profile,
                        provider: agent.provider,
                        model: agent.model,
                        apiMode: agent.apiMode,
                        reasoningEffort: agent.reasoningEffort,
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

    private async authMiddleware(socket: Socket, next: (err?: Error) => void): Promise<void> {
        const auth = socket.handshake.auth as {
            source?: string
            agentSocketSecret?: string
            token?: string
            inviteCode?: string
        }
        const isAgentSocket = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET
        if (isAgentSocket) {
            next()
            return
        }

        const inviteCode = typeof auth.inviteCode === 'string' ? auth.inviteCode.trim() : ''
        if (inviteCode) {
            const invitedRoom = inviteCode ? this.storage.getRoomByInviteCode(inviteCode) : null
            if (!invitedRoom) return next(new Error('Unauthorized'))
            socket.data.inviteGuestRoomId = invitedRoom.id
            next()
            return
        }

        const token = auth.token || socket.handshake.query.token || ''
        if (await isAuthEnabled()) {
            const user = await authenticateUserToken(String(token))
            if (!user) return next(new Error('Unauthorized'))
            socket.data.authUser = user
        }
        next()
    }

    // ─── Connection ─────────────────────────────────────────────

    private onConnection(socket: Socket): void {
        const auth = socket.handshake.auth as { userId?: string; name?: string; description?: string; source?: string; agentSocketSecret?: string; authUserId?: number }
        const requestedSource = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET ? 'agent' : 'human'
        const authenticatedUser = socket.data.authUser as AuthenticatedUser | undefined
        const authUserId = requestedSource === 'human'
            ? authenticatedUser?.id ?? (typeof auth.authUserId === 'number' && auth.authUserId > 0 ? auth.authUserId : undefined)
            : undefined
        const userId = authUserId ? authenticatedGroupUserId(authUserId) : auth.userId || socket.id
        const userName = auth.name || authenticatedUser?.username || `User-${userId.slice(0, 6)}`
        const description = auth.description || ''

        this.socketUserMap.set(socket.id, userId)
        this.socketRequestedSourceMap.set(socket.id, requestedSource)
        this.userInfoMap.set(userId, { name: userName, description })
        if (typeof authUserId === 'number') {
            this.socketAuthUserIdMap.set(socket.id, authUserId)
        }

        logger.debug(`[GroupChat] Connected: ${userName} (socket=${socket.id}, user=${userId})`)

        socket.on('join', (data: { roomId?: string; name?: string }, ack?: (response?: unknown) => void) => this.handleJoin(socket, data, ack))
        socket.on('load_messages', (data: { roomId?: string; offset?: number; limit?: number }, ack?: (response?: unknown) => void) => this.handleLoadMessages(socket, data, ack))
        socket.on('update_member_profile', (data: { roomId?: string; name?: string; description?: string } | undefined, ack?: (response?: unknown) => void) => this.handleUpdateMemberProfile(socket, data, ack))
        socket.on('message', (data: IncomingGroupChatMessage, ack?: (response?: unknown) => void) => this.handleMessage(socket, data, ack))
        socket.on('message_stream_start', (data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number; run_id?: string; agentSessionId?: string }) => this.handleMessageStreamStart(socket, data))
        socket.on('message_stream_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageStreamDelta(socket, data))
        socket.on('message_reasoning_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageReasoningDelta(socket, data))
        socket.on('message_stream_end', (data: { roomId?: string; id?: string }) => this.handleMessageStreamEnd(socket, data))
        socket.on('typing', (data: { roomId?: string }) => this.handleTyping(socket, data))
        socket.on('stop_typing', (data: { roomId?: string }) => this.handleStopTyping(socket, data))
        socket.on('context_status', (data: { roomId?: string; agentName?: string; status?: string }) => this.handleContextStatus(socket, data))
        socket.on('interrupt_agent', (data: { roomId?: string; agentName?: string }, ack?: (response?: unknown) => void) => this.handleInterruptAgent(socket, data, ack))
        socket.on('remove_agent', (data: { roomId?: string; agentId?: string }, ack?: (response?: unknown) => void) => this.handleRemoveAgent(socket, data, ack))
        socket.on('approval.requested', (data: { roomId?: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean; agentSessionId?: string }) => this.handleApprovalRequested(socket, data))
        socket.on('approval.resolved', (data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string; agentSessionId?: string }) => this.handleApprovalResolved(socket, data))
        socket.on('approval.respond', (data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void) => this.handleApprovalRespond(socket, data, ack))
        socket.on('disconnect', () => this.handleDisconnect(socket))
    }

    // ─── Handlers ───────────────────────────────────────────────

    private canSocketJoinRoom(socket: Socket, roomId: string, room: RoomInfo | undefined, existingMember: Member | null, inviteCode?: string): boolean {
        if (!room) return typeof this.storage.getRoom !== 'function'
        const inviteGuestRoomId = socket.data?.inviteGuestRoomId
        if (typeof inviteGuestRoomId === 'string') return inviteGuestRoomId === roomId
        const requested = typeof inviteCode === 'string' ? inviteCode.trim() : ''
        if (requested && room.inviteCode && requested === room.inviteCode) return true
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        if (!authUser) return Boolean(existingMember || !room.inviteCode)
        if (authUser.role === 'super_admin') return true
        if (typeof authUser.id === 'number' && Number(room.ownerAuthUserId || 0) === authUser.id) return true
        if (existingMember) return true
        const profiles = authenticatedUserProfiles(authUser)
        return profiles.length > 0 && typeof this.storage.getRoomsForProfiles === 'function' && this.storage.getRoomsForProfiles(profiles).some(candidate => candidate.id === roomId)
    }

    private canSocketManageRoom(socket: Socket, roomId: string): boolean {
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        if (typeof socket.data?.inviteGuestRoomId === 'string') return false
        const room = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
        if (!room) return false
        const authUser = socket.data?.authUser as AuthenticatedUser | undefined
        if (!authUser) {
            // With authentication disabled, handshake userId/authUserId values are client-controlled.
            // They may identify a joined in-context member, but must never grant off-room global
            // approval visibility or authority based on persisted membership alone.
            const joined = this.getOnlineRoomMember(socket, roomId)
            return Boolean(joined && joined.member.source === 'human')
        }
        if (authUser.role === 'super_admin') return true
        if (typeof authUser.id === 'number' && Number(room.ownerAuthUserId || 0) === authUser.id) return true
        const profiles = authenticatedUserProfiles(authUser)
        return profiles.length > 0 && typeof this.storage.getRoomsForProfiles === 'function' && this.storage.getRoomsForProfiles(profiles).some(candidate => candidate.id === roomId)
    }

    private canSocketMentionAll(socket: Socket, roomId: string): boolean {
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        if (typeof socket.data?.inviteGuestRoomId === 'string') return false
        return isGroupChatRoomOwner(
            this.storage,
            roomId,
            socket.data?.authUser as AuthenticatedUser | undefined,
        )
    }

    private canSocketInterruptAgent(socket: Socket, roomId: string, agentName: string): boolean {
        if (this.canSocketManageRoom(socket, roomId)) return true
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        const requesterMemberId = this.socketUserMap?.get(socket.id)
        if (!requesterMemberId) return false
        const agent = this.storage.getRoomAgents(roomId)
            .find(candidate => candidate.name === agentName)
        return agent?.executorType === 'remote'
            && agent.ownerMemberId === requesterMemberId
    }

    private canSocketRemoveAgent(socket: Socket, roomId: string, agent: RoomAgent): boolean {
        if (this.canSocketManageRoom(socket, roomId)) return true
        if (this.socketRequestedSourceMap?.get(socket.id) === 'agent') return false
        const requesterMemberId = this.socketUserMap?.get(socket.id)
        return agent.executorType === 'remote'
            && Boolean(requesterMemberId)
            && agent.ownerMemberId === requesterMemberId
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

    private emitToRoomManagers(roomId: string, event: string, payload: Record<string, unknown>): void {
        const emitted = new Set<string>()
        const sockets = this.nsp.sockets?.values?.()
        if (!sockets) return
        for (const socket of sockets) {
            if (emitted.has(socket.id) || this.socketRequestedSourceMap?.get(socket.id) === 'agent') continue
            if (!this.canSocketManageRoom(socket, roomId)) continue
            socket.emit(event, payload)
            emitted.add(socket.id)
        }
    }

    private agentSessionIsCurrent(roomId: string, member: Member | undefined, agentSessionId: unknown): boolean {
        const sessionId = typeof agentSessionId === 'string' ? agentSessionId.trim() : ''
        if (!sessionId || member?.source !== 'agent') return false
        if (typeof this.agentClients?.agentSessionIsCurrent === 'function') {
            return this.agentClients.agentSessionIsCurrent(roomId, member.userId, sessionId)
                && !this.isRoomAgentSessionFenced(roomId, sessionId)
        }
        const room = this.storage?.getRoom?.(roomId)
        const roomAgent = this.storage?.getRoomAgentByAgentId?.(roomId, member.userId)
        if (!room || !roomAgent) return false
        const expected = groupBridgeSessionId(roomId, roomAgent.profile, roomAgent.name, String(room.sessionSeed || '0'), {
            agent: roomAgent.agent,
            provider: roomAgent.provider,
            model: roomAgent.model,
            apiMode: roomAgent.apiMode,
            reasoningEffort: roomAgent.reasoningEffort,
        })
        return sessionId === expected && !this.isRoomAgentSessionFenced(roomId, sessionId)
    }

    private canPersistAgentMessageForCurrentSession(
        roomId: string,
        member: Member | undefined,
        data: Pick<IncomingGroupChatMessage, 'role' | 'tool_calls' | 'tool_call_id' | 'agentSessionId'>,
    ): boolean {
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
        return joined.member
    }

    private handleJoin(socket: Socket, data: { roomId?: string; name?: string; description?: string; avatar?: string; inviteCode?: string }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId) || socketId
        const requestedSource = this.socketRequestedSourceMap.get(socketId) || 'human'
        const roomId = data.roomId || 'general'
        const storedRoom = typeof this.storage.getRoom === 'function' ? this.storage.getRoom(roomId) : undefined
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
        const socketAuthUserId = this.socketAuthUserIdMap.get(socket.id)
        const existingMember = this.storage.getMemberByUserId(roomId, userId) ||
            (typeof socketAuthUserId === 'number' ? this.storage.getMemberByAuthUserId(roomId, socketAuthUserId) : null)
        if (source !== 'agent' && !this.canSocketJoinRoom(socket, roomId, storedRoom, existingMember, data.inviteCode)) {
            ack?.({ error: 'Access denied' })
            return
        }
        const userInfo = this.userInfoMap.get(userId) || {
            name: `User-${userId.slice(0, 6)}`,
            description: '',
        }
        const requestedName = typeof data.name === 'string' ? data.name.trim() : ''
        const requestedDescription = typeof data.description === 'string' ? data.description.trim() : ''
        const isInviteGuest = typeof socket.data?.inviteGuestRoomId === 'string'
        if (isInviteGuest && !requestedName) {
            ack?.({ code: 'ROOM_PARTICIPANT_NAME_REQUIRED', error: 'Name is required' })
            return
        }
        // On rejoin, prefer the per-room DB record over the join-request name
        // so switching rooms doesn't overwrite a member's per-room identity.
        // Invite guests explicitly confirm their name before every entry, so
        // their requested name may update the persisted browser identity.
        const userName = isInviteGuest && requestedName
            ? requestedName
            : existingMember?.name || requestedName || userInfo.name
        const description = existingMember?.description || requestedDescription || userInfo.description
        if (isReservedMentionName(userName)) {
            ack?.({ code: 'ROOM_PARTICIPANT_NAME_RESERVED', error: '`all` is reserved for @all mentions' })
            return
        }
        let requestedAvatar = ''
        if (isInviteGuest) {
            try {
                requestedAvatar = normalizeRoomMemberAvatar(data.avatar)
            } catch {
                ack?.({ code: 'ROOM_PARTICIPANT_AVATAR_INVALID', error: 'Invalid member avatar' })
                return
            }
        }

        // Update stored user info
        this.userInfoMap.set(userId, { name: userName, description })

        let room = this.rooms.get(roomId)
        if (!room) {
            if (!storedRoom && typeof this.storage.getRoom === 'function') {
                ack?.({ error: 'Room not found' })
                return
            }
            room = new ChatRoom(roomId)
            this.rooms.set(roomId, room)
            if (!storedRoom) this.storage.saveRoom(roomId, roomId)
        }

        // Look up the user's avatar via their numeric users.id from the web UI session.
        // Falls back to name-based lookup for clients that don't pass authUserId.
        let userAvatar = isInviteGuest
            ? requestedAvatar || existingMember?.avatar || ''
            : existingMember?.avatar || ''
        let authUserId: number | undefined
        if (source !== 'agent') {
            authUserId = this.socketAuthUserIdMap.get(socket.id)
            if (typeof authUserId === 'number') {
                try {
                    userAvatar = getUserAvatar(authUserId) || ''
                } catch (err) {
                    logger.info(`[GroupChat] avatar lookup by id=${authUserId} failed: ${(err as Error).message}`)
                }
            }
        }

        // Persist only human members. Agent sockets are runtime participants
        // tracked through gc_room_agents and AgentClients; storing them in
        // gc_room_members makes member counts grow on reconnect/restore.
        if (source !== 'agent') {
            try {
                this.storage.addRoomMember(roomId, userId, userName, description, userAvatar, authUserId)
            } catch (err: any) {
                if (err?.code === ROOM_PARTICIPANT_NAME_CONFLICT) {
                    ack?.({ code: err.code, error: err.message })
                    return
                }
                logger.error(`[GroupChat] Failed to persist room member: ${err?.message || err}`)
                ack?.({ error: 'Failed to join room' })
                return
            }
        }

        // Add to in-memory online participants (keyed by userId)
        room.addOrUpdateMember(socketId, userId, userName, description, source, userAvatar)
        socket.join(roomId)

        if (source !== 'agent') {
            const members = this.getRoomMemberViews(roomId, room)
            socket.to(roomId).emit('member_joined', {
                roomId,
                memberId: userId,
                memberName: userName,
                members,
            })
        }

        // Load history from SQLite
        const messages = this.storage.getRecentMessagesForUI(roomId)
        const total = this.storage.getMessageCount?.(roomId) ?? messages.length
        const agents = this.getRoomAgentViews(
            roomId,
            this.canSocketManageRoom(socket, roomId),
            userId,
        )

        ack?.({
            roomId,
            roomName: room.name,
            members: this.getRoomMemberViews(roomId, room),
            messages,
            agents,
            rooms: typeof socket.data?.inviteGuestRoomId === 'string' ? [roomId] : this.getRoomIds(),
            total,
            offset: 0,
            limit: messages.length,
            hasMore: messages.length < total,
            typingUsers: this.getTypingUsers(roomId),
            contextStatuses: this.getContextStatuses(roomId),
            ...(isInviteGuest && source !== 'agent'
                ? { agentLinkToken: this.issueGuestAgentRequestToken(roomId, userId, socket.id) }
                : {}),
        })

        logger.debug(`[GroupChat] ${userName} (user=${userId}) joined room: ${roomId}`)
    }

    private handleLoadMessages(
        socket: Socket,
        data: { roomId?: string; offset?: number; limit?: number } | undefined,
        ack?: (res: any) => void,
    ): void {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        if (!roomId || !this.getOnlineRoomMember(socket, roomId)) {
            ack?.({ error: 'Access denied' })
            return
        }

        const offset = Math.max(0, Number.isFinite(data?.offset) ? Math.floor(Number(data?.offset)) : 0)
        const limit = Math.min(150, Math.max(1, Number.isFinite(data?.limit) ? Math.floor(Number(data?.limit)) : 150))
        const messages = this.storage.getRecentMessagesForUI(roomId, limit, offset)
        const total = this.storage.getMessageCount?.(roomId) ?? messages.length
        ack?.({
            messages,
            total,
            offset,
            limit,
            hasMore: offset + messages.length < total,
        })
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
        if (isReservedMentionName(name)) {
            ack?.({ code: 'ROOM_PARTICIPANT_NAME_RESERVED', error: '`all` is reserved for @all mentions' })
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

        try {
            const userId = joined.member.userId
            const authUserId = this.socketAuthUserIdMap.get(socket.id)
            const avatar = joined.member.avatar || ''
            this.storage.addRoomMember(roomId, userId, name, description, avatar, authUserId)
            joined.room.addOrUpdateMember(socket.id, userId, name, description, 'human', avatar)
            this.userInfoMap.set(userId, { name, description })

            const members = this.getRoomMemberViews(roomId, joined.room)
            this.nsp.to(roomId).emit('member_updated', {
                roomId,
                memberId: userId,
                memberName: name,
                members,
            })
            ack?.({ member: joined.room.getOnlineMemberBySocketId(socket.id), members })
        } catch (err) {
            if ((err as any)?.code === ROOM_PARTICIPANT_NAME_CONFLICT) {
                ack?.({ code: ROOM_PARTICIPANT_NAME_CONFLICT, error: (err as Error).message })
                return
            }
            logger.error(`[GroupChat] Failed to update member profile: ${(err as Error).message}`)
            ack?.({ error: 'Failed to update member profile' })
        }
    }

    private normalizeStructuredMentions(
        roomId: string,
        member: Member | undefined,
        content: string,
        rawMentions: unknown,
    ): { mentions?: StructuredMention[]; error?: string } {
        const senderId = member?.userId || ''
        const senderIsAgent = member?.source === 'agent'
        if (rawMentions === undefined) {
            const roomAgents = senderIsAgent && typeof this.storage.getRoomAgents === 'function'
                ? this.storage.getRoomAgents(roomId) as RoomAgent[]
                : []
            if (senderIsAgent && (isAllAgentsMentioned(content) || resolveMentionTargets(roomAgents, content, senderId).length > 0)) {
                return { error: 'Agent mentions require structured metadata' }
            }
            return senderIsAgent ? { mentions: [] } : {}
        }
        if (!Array.isArray(rawMentions)) return { error: 'Invalid structured mentions' }
        const roomAgents = this.storage.getRoomAgents(roomId) as RoomAgent[]
        const visibleAllMention = isAllAgentsMentioned(content)
        const visibleParticipantIds = new Set(
            roomAgents
                .filter(agent => isAgentMentioned(content, agent.name))
                .map(agent => agent.agentId),
        )

        const normalized: StructuredMention[] = []
        const participantIds = new Set<string>()
        let allSeen = false
        for (const rawMention of rawMentions) {
            if (!rawMention || typeof rawMention !== 'object' || Array.isArray(rawMention)) {
                return { error: 'Invalid structured mentions' }
            }
            const mention = rawMention as Record<string, unknown>
            if (mention.type === 'all') {
                if (allSeen || normalized.length > 0 || mention.displayName !== 'all' || !visibleAllMention) {
                    return { error: 'Invalid structured mentions' }
                }
                allSeen = true
                normalized.push({ type: 'all' })
                continue
            }
            if (mention.type !== 'agent'
                || typeof mention.participantId !== 'string'
                || typeof mention.displayName !== 'string'
                || allSeen
                || participantIds.has(mention.participantId)
                || mention.participantId === senderId) {
                return { error: 'Invalid structured mentions' }
            }
            const target = roomAgents.find(agent => agent.agentId === mention.participantId)
            if (!target || target.name !== mention.displayName || !isAgentMentioned(content, target.name)) {
                return { error: 'Invalid structured mentions' }
            }
            participantIds.add(target.agentId)
            normalized.push({ type: 'agent', participantId: target.agentId })
        }

        if (senderIsAgent) {
            const structuredAll = normalized.length === 1 && normalized[0].type === 'all'
            const visibleAgentMentionIds = [...visibleParticipantIds]
            if (visibleAllMention
                ? !structuredAll || visibleAgentMentionIds.length > 0
                : structuredAll
                    || participantIds.size !== visibleAgentMentionIds.length
                    || visibleAgentMentionIds.some(participantId => !participantIds.has(participantId))) {
                return { error: 'Invalid structured mentions' }
            }
        }
        return { mentions: normalized }
    }

    private handleMessage(socket: Socket, data: IncomingGroupChatMessage, ack?: (res: any) => void): void {
        if (!data || (typeof data.content !== 'string' && !Array.isArray(data.content))) {
            ack?.({ error: 'Invalid message content' })
            return
        }
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
        const userId = member?.userId || socketId
        const userName = member?.name || `User-${socketId.slice(0, 6)}`
        const isHumanMessage = member?.source === 'human'
        const role = isHumanMessage ? 'user' : normalizeMessageRole(data.role)
        let messageContent: unknown = data.content
        let runtimeInput: ContentBlock[] | undefined = Array.isArray(data.content)
            ? data.content as ContentBlock[]
            : undefined
        const structuredHumanContent = isHumanMessage ? humanStructuredContent(data.content) : null
        if (structuredHumanContent) {
            try {
                const normalized = normalizeHumanGroupChatContent(roomId, structuredHumanContent)
                messageContent = normalized.storageContent
                runtimeInput = normalized.runtimeInput
            } catch (error) {
                ack?.({
                    code: 'GROUP_CHAT_ATTACHMENT_INVALID',
                    error: error instanceof Error ? error.message : 'Invalid group chat attachment',
                })
                return
            }
        }
        if (
            isAllAgentsMentioned(contentToText(messageContent))
            && !this.canSocketMentionAll(socket, roomId)
        ) {
            ack?.({
                code: 'GROUP_CHAT_ALL_MENTION_FORBIDDEN',
                error: 'Only the room owner can mention @all',
            })
            return
        }
        const content = contentToStorageString(messageContent)
        const mentionResult = this.normalizeStructuredMentions(roomId, member, contentToText(messageContent), data.mentions)
        if (mentionResult.error) {
            ack?.({ error: mentionResult.error })
            return
        }

        const msg: ChatMessage = {
            id: this.normalizeClientMessageId(data.id) || this.generateId(),
            roomId,
            senderId: userId,
            senderName: userName,
            content,
            timestamp: this.normalizeMessageTimestamp(data.timestamp, role),
            persistedAt: Date.now(),
            ...(mentionResult.mentions !== undefined ? { mentions: mentionResult.mentions } : {}),
            run_id: !isHumanMessage && typeof data.run_id === 'string' && data.run_id.trim()
                ? data.run_id.trim()
                : null,
            role,
            tool_call_id: !isHumanMessage ? data.tool_call_id ?? null : null,
            tool_calls: !isHumanMessage && Array.isArray(data.tool_calls) ? data.tool_calls : null,
            tool_name: !isHumanMessage ? data.tool_name ?? null : null,
            finish_reason: !isHumanMessage ? data.finish_reason ?? null : null,
            reasoning: !isHumanMessage ? data.reasoning ?? null : null,
            reasoning_details: !isHumanMessage ? data.reasoning_details ?? null : null,
            reasoning_content: !isHumanMessage ? data.reasoning_content ?? null : null,
        }

        const saved = this.storage.saveMessageAndRefreshRoom(msg)
        const savedMsg = saved.message
        const totalTokens = saved.totalTokens

        this.nsp.to(roomId).emit('message', savedMsg)
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens })
        ack?.({ id: savedMsg.id })

        const mentionDepth = normalizeMentionDepth(data.mentionDepth)
        const isAgentReply = savedMsg.role === 'assistant' && member?.source === 'agent'
        // Any human who has successfully joined the room may interact with its
        // Agents. Room management remains separately protected by
        // canSocketManageRoom, so invite guests cannot mutate settings, approve
        // tools, or interrupt an Agent.
        const canRouteHumanMentions = savedMsg.role === 'user' && member?.source === 'human'
        const shouldRouteMentions = canRouteHumanMentions ||
            (isAgentReply && mentionDepth < maxAgentMentionDepth())

        if (shouldRouteMentions) {
            // Server-side @mention routing — parse mentions and invoke agents directly.
            // Agent replies are allowed to mention other agents, but mentionDepth
            // bounds chained agent-to-agent handoffs so one prompt cannot loop forever.
            this.agentClients.processMentions(roomId, {
                messageId: savedMsg.id,
                content: contentToText(savedMsg.content),
                input: runtimeInput,
                senderName: savedMsg.senderName,
                senderId: savedMsg.senderId,
                timestamp: savedMsg.timestamp,
                role: savedMsg.role,
                mentionDepth,
                mentions: savedMsg.mentions,
            }).catch((err) => {
                logger.error(`[GroupChat] processMentions error: ${err.message}`)
            })
        } else if (savedMsg.role === 'user' && typeof this.agentClients.processSummaryCheck === 'function') {
            this.agentClients.processSummaryCheck(roomId, savedMsg.id).catch((err) => {
                logger.error(`[GroupChat] summary check error: ${err.message}`)
            })
        }
    }

    private handleMessageStreamStart(socket: Socket, data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number; run_id?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        const member = this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)
        if (!member) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return

        this.nsp.to(roomId).emit('message_stream_start', {
            id,
            roomId,
            senderId: member.userId,
            senderName: member.name,
            content: '',
            timestamp: data.timestamp || Date.now(),
            run_id: typeof data.run_id === 'string' && data.run_id.trim() ? data.run_id.trim() : null,
            role: 'assistant',
            finish_reason: 'streaming',
        })
    }

    private handleMessageStreamDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        if (!this.getCurrentAgentEventMember(socket, roomId, '', data.agentSessionId)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.nsp.to(roomId).emit('message_stream_delta', {
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
        this.nsp.to(roomId).emit('message_reasoning_delta', {
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
        this.nsp.to(roomId).emit('message_stream_end', { roomId, id })
    }

    private handleTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined) return
        const userId = joined.member.userId
        const userName = joined.member.name

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

        socket.to(roomId).emit('typing', {
            roomId,
            userId,
            userName,
        })
    }

    private handleStopTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined) return
        const userId = joined.member.userId

        // Remove from typing state
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            const entry = roomTyping.get(userId)
            if (entry) clearTimeout(entry.timer)
            roomTyping.delete(userId)
            if (roomTyping.size === 0) this.typingState.delete(roomId)
        }

        socket.to(roomId).emit('stop_typing', {
            roomId,
            userId,
        })
    }

    private handleContextStatus(socket: Socket, data: { roomId?: string; agentName?: string; status?: string; totalTokens?: number; agentSessionId?: string }): void {
        const roomId = data.roomId || 'general'
        const agentName = data.agentName || ''
        const status = data.status || ''
        const agentSessionId = typeof data.agentSessionId === 'string' ? data.agentSessionId.trim() : ''

        if (!agentName) return

        if (status === 'ready') {
            const joined = this.getOnlineRoomMember(socket, roomId)
            if (!joined || joined.member.source !== 'agent' || joined.member.name !== agentName) return
            const roomStatuses = this.contextStatusState.get(roomId)
            const activeStatus = roomStatuses?.get(agentName)
            if (!roomStatuses || !activeStatus) return
            // Fresh group runs remove their active session immediately after
            // emitting ready. Match the status that started the run instead of
            // consulting the already-disposed runtime session.
            if (!activeStatus.agentSessionId || activeStatus.agentSessionId !== agentSessionId) return
            roomStatuses.delete(agentName)
            if (roomStatuses.size === 0) this.contextStatusState.delete(roomId)
        } else {
            const agentMember = this.getCurrentAgentEventMember(socket, roomId, agentName, agentSessionId)
            if (!agentMember) return
            let roomStatuses = this.contextStatusState.get(roomId)
            if (!roomStatuses) {
                roomStatuses = new Map()
                this.contextStatusState.set(roomId, roomStatuses)
            }
            roomStatuses.set(agentName, {
                agentName,
                status,
                ...(agentSessionId ? { agentSessionId } : {}),
            })
        }

        // Relay to all other sockets in the room
        socket.to(roomId).emit('context_status', {
            roomId,
            agentName,
            status,
        })

        if (typeof data.totalTokens === 'number' && Number.isFinite(data.totalTokens) && data.totalTokens >= 0) {
            this.storage.updateRoomTotalTokens(roomId, Math.floor(data.totalTokens))
            this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens: Math.floor(data.totalTokens) })
        }
    }

    private async handleInterruptAgent(socket: Socket, data: { roomId?: string; agentName?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        const agentName = data.agentName
        if (!roomId || !agentName) {
            ack?.({ error: 'roomId and agentName are required' })
            return
        }
        const room = this.rooms.get(roomId)
        if (!room?.hasOnlineMember(socket.id)) {
            ack?.({ error: 'Not in room' })
            return
        }
        if (!this.canSocketInterruptAgent(socket, roomId, agentName)) {
            ack?.({ error: 'Access denied' })
            return
        }
        try {
            await this.agentClients.interruptAgent(roomId, agentName)
            const roomStatuses = this.contextStatusState.get(roomId)
            roomStatuses?.delete(agentName)
            if (roomStatuses?.size === 0) this.contextStatusState.delete(roomId)
            this.nsp.to(roomId).emit('context_status', { roomId, agentName, status: 'ready' })
            ack?.({ ok: true })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to interrupt agent ${agentName} in room ${roomId}: ${err.message}`)
            ack?.({ error: err.message || 'interrupt failed' })
        }
    }

    private handleRemoveAgent(
        socket: Socket,
        data: { roomId?: string; agentId?: string },
        ack?: (response?: unknown) => void,
    ): void {
        const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : ''
        const agentId = typeof data?.agentId === 'string' ? data.agentId.trim() : ''
        if (!roomId || !agentId) {
            ack?.({ error: 'roomId and agentId are required' })
            return
        }
        const joined = this.getOnlineRoomMember(socket, roomId)
        if (!joined || joined.member.source !== 'human') {
            ack?.({ error: 'Not in room' })
            return
        }
        const agent = this.storage.getRoomAgent(roomId, agentId)
        if (!agent) {
            ack?.({ error: 'Agent not found' })
            return
        }
        if (!this.canSocketRemoveAgent(socket, roomId, agent)) {
            ack?.({ error: 'Access denied' })
            return
        }

        if (agent.executorType === 'remote' && agent.connectorId) {
            revokeGroupAgentConnector(agent.connectorId)
        }
        this.storage.removeRoomAgent(roomId, agent.id)
        this.agentClients.removeAgentFromRoom(roomId, agent.agentId)
        this.broadcastRoomAgents(roomId)
        ack?.({
            ok: true,
            agents: this.getRoomAgentViews(roomId, false, joined.member.userId),
            members: this.storage.getRoomMembers(roomId),
        })
    }

    private handleApprovalRequested(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean; agentSessionId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        if (!roomId || !data.approval_id || !this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)) return
        this.pendingApprovalRoutes.set(this.pendingApprovalRouteKey(roomId, data.approval_id), {
            roomId,
            agentName,
            agentSessionId: String(data.agentSessionId || '').trim(),
        })
        this.emitToRoomManagers(roomId, 'approval.requested', {
            event: 'approval.requested',
            roomId,
            agentName,
            approval_id: data.approval_id,
            command: data.command || '',
            description: data.description || '',
            choices: Array.isArray(data.choices) ? data.choices : ['once', 'session', 'deny'],
            allow_permanent: Boolean(data.allow_permanent),
        })
    }

    private handleApprovalResolved(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string; agentSessionId?: string }): void {
        const roomId = data.roomId
        const agentName = data.agentName || ''
        if (!roomId || !data.approval_id || !this.getCurrentAgentEventMember(socket, roomId, agentName, data.agentSessionId)) return
        const routeKey = this.pendingApprovalRouteKey(roomId, data.approval_id)
        const pendingRoute = this.pendingApprovalRoutes.get(routeKey)
        if (pendingRoute?.roomId === roomId && pendingRoute.agentName === agentName) {
            this.pendingApprovalRoutes.delete(routeKey)
        }
        this.emitToRoomManagers(roomId, 'approval.resolved', {
            event: 'approval.resolved',
            roomId,
            agentName,
            approval_id: data.approval_id,
            choice: data.choice || '',
        })
    }

    private async handleApprovalRespond(socket: Socket, data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void): Promise<void> {
        const roomId = data.roomId
        if (!roomId || !data.approval_id) {
            ack?.({ error: 'roomId and approval_id are required' })
            return
        }
        const room = this.rooms.get(roomId)
        if (!room) {
            ack?.({ error: 'Not in room' })
            return
        }
        if (!this.canSocketManageRoom(socket, roomId)) {
            ack?.({ error: 'Access denied' })
            return
        }
        const routeKey = this.pendingApprovalRouteKey(roomId, data.approval_id)
        const pendingRoute = this.pendingApprovalRoutes.get(routeKey)
        if (!pendingRoute || pendingRoute.roomId !== roomId) {
            ack?.({ error: 'Approval is not pending in this room' })
            return
        }
        const remoteExecutor = this.agentClients.getAgents(roomId).find(agent =>
            agent.name === pendingRoute.agentName && typeof agent.respondApproval === 'function'
        )
        if (remoteExecutor?.respondApproval) {
            try {
                const resolved = await remoteExecutor.respondApproval(data.approval_id, data.choice || 'deny')
                if (resolved) this.pendingApprovalRoutes.delete(routeKey)
                ack?.({ ok: true, resolved })
            } catch (err: any) {
                ack?.({ error: err.message || 'approval response failed' })
            }
            return
        }
        const ekkoResult = pendingRoute.agentSessionId
            ? respondToEkkoToolApproval(
                pendingRoute.agentSessionId,
                data.approval_id,
                data.choice,
            )
            : null
        if (ekkoResult?.handled) {
            if (!ekkoResult.resolved) {
                ack?.({ error: 'Approval does not belong to the active Agent session' })
                return
            }
            this.pendingApprovalRoutes.delete(routeKey)
            ack?.({ ok: true, resolved: true })
            return
        }
        try {
            const result = await new AgentBridgeClient().approvalRespond(data.approval_id, data.choice || 'deny')
            const resolved = Boolean((result as any)?.resolved)
            if (resolved) this.pendingApprovalRoutes.delete(routeKey)
            ack?.({ ok: true, resolved })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to respond approval ${data.approval_id}: ${err.message}`)
            ack?.({ error: err.message || 'approval response failed' })
        }
    }

    private clearPendingApprovalRoutes(roomId: string): void {
        const pendingRoutes = this.pendingApprovalRoutes
        if (!pendingRoutes) return
        for (const [routeKey, route] of pendingRoutes) {
            if (route.roomId === roomId) pendingRoutes.delete(routeKey)
        }
    }

    private handleDisconnect(socket: Socket): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId)
        const userName = userId ? this.userInfoMap.get(userId)?.name : undefined
        const inviteGuestRoomId = typeof socket.data?.inviteGuestRoomId === 'string'
            ? socket.data.inviteGuestRoomId
            : ''
        if (userId && inviteGuestRoomId) {
            const key = `${inviteGuestRoomId}\u0000${userId}`
            if (this.guestAgentRequestTokens.get(key)?.socketId === socketId) {
                this.guestAgentRequestTokens.delete(key)
            }
        }

        logger.debug(`[GroupChat] Disconnected: ${userName || socketId} (socket=${socketId}, user=${userId || socketId})`)

        // Clean up typing state for this socket
        for (const [roomId, roomTyping] of this.typingState) {
            const entry = roomTyping.get(userId || socketId)
            if (entry) {
                clearTimeout(entry.timer)
                roomTyping.delete(userId || socketId)
                if (roomTyping.size === 0) this.typingState.delete(roomId)
                this.nsp.to(roomId).emit('stop_typing', {
                    roomId,
                    userId: userId || socketId,
                })
            }
        }

        this.leaveAllRooms(socket, socketId)
        this.socketUserMap.delete(socketId)
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
        return Array.from(roomStatuses.values()).map(({ agentName, status }) => ({ agentName, status }))
    }

    private leaveAllRooms(socket: Socket, socketId: string): void {
        this.rooms.forEach((room, rid) => {
            if (room.hasOnlineMember(socketId)) {
                const member = room.getOnlineMemberBySocketId(socketId)
                room.removeMember(socketId)
                socket.leave(rid)
                if (member?.source !== 'agent') {
                    this.nsp.to(rid).emit('member_left', {
                        roomId: rid,
                        memberId: member?.userId || socketId,
                        memberName: member?.name || `User-${socketId.slice(0, 6)}`,
                        members: this.getRoomMemberViews(rid, room),
                    })
                }
            }
        })
    }

    private generateId(): string {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
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
