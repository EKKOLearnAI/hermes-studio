import { Server, Socket, Namespace } from 'socket.io'
import type { Server as HttpServer } from 'http'
import { logger } from '../../../services/logger'
import { getDb } from '../../../db'
import { normalizeMessageContentForStorage, normalizeMessageContentForStorageRole } from '../../../db/hermes/message-content'
import { AgentClients, GROUP_CHAT_AGENT_SOCKET_SECRET } from './agent-clients'
import { ContextEngine } from '../context-engine/compressor'
import { SessionDeleter } from '../session-deleter'
import { countTokens, SUMMARY_PREFIX } from '../../../lib/context-compressor'
import { AgentBridgeClient } from '../agent-bridge'
import { authenticateUserToken, isAuthEnabled } from '../../../middleware/user-auth'
import { findUserByUsername, getUserAvatar } from '../../../db/hermes/users-store'

// ─── Types ────────────────────────────────────────────────────

interface ChatMessage {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    role?: string
    tool_call_id?: string | null
    tool_calls?: any[] | null
    tool_name?: string | null
    finish_reason?: string | null
    reasoning?: string | null
    reasoning_details?: string | null
    reasoning_content?: string | null
    mentionDepth?: number
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

interface RoomAgent {
    id: string
    roomId: string
    agentId: string
    profile: string
    name: string
    description: string
    invited: number
}

interface RoomInfo {
    id: string
    name: string
    inviteCode: string | null
    triggerTokens: number
    maxHistoryTokens: number
    tailMessageCount: number
    totalTokens: number
    sessionSeed: string
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

function groupRunOrder(id: string): { baseId: string; phase: number } {
    const value = String(id || '')
    const partMatch = value.match(/^(.*)_part_(\d+)(?:_(toolcall|toolresult)_.+)?$/)
    if (partMatch) {
        const part = Number(partMatch[2] || 0)
        const kind = partMatch[3] || 'assistant'
        const offset = kind === 'toolcall' ? 1 : kind === 'toolresult' ? 2 : 0
        return { baseId: partMatch[1], phase: part * 3 + offset }
    }
    const toolIdx = value.indexOf('_toolcall_')
    if (toolIdx >= 0) return { baseId: value.slice(0, toolIdx), phase: 0 }
    const resultIdx = value.indexOf('_toolresult_')
    if (resultIdx >= 0) return { baseId: value.slice(0, resultIdx), phase: 1 }
    return { baseId: value, phase: 2 }
}

function sortGroupMessages<T extends { id: string; timestamp: number }>(messages: T[]): T[] {
    const baseMinTimestamp = new Map<string, number>()
    for (const msg of messages) {
        const { baseId } = groupRunOrder(msg.id)
        const existing = baseMinTimestamp.get(baseId)
        if (existing == null || msg.timestamp < existing) baseMinTimestamp.set(baseId, msg.timestamp)
    }
    return [...messages].sort((a, b) => {
        const ao = groupRunOrder(a.id)
        const bo = groupRunOrder(b.id)
        const at = baseMinTimestamp.get(ao.baseId) ?? a.timestamp
        const bt = baseMinTimestamp.get(bo.baseId) ?? b.timestamp
        if (at !== bt) return at - bt
        if (ao.baseId !== bo.baseId) return ao.baseId.localeCompare(bo.baseId)
        if (ao.phase !== bo.phase) return ao.phase - bo.phase
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
        return a.id.localeCompare(b.id)
    })
}

class ChatStorage {
    private db() { return getDb() }

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
        return this.db()?.prepare('SELECT id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens, sessionSeed FROM gc_rooms WHERE id = ?').get(roomId) as any
    }

    getRoomByInviteCode(code: string): RoomInfo | undefined {
        return this.db()?.prepare('SELECT id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens, sessionSeed FROM gc_rooms WHERE inviteCode = ?').get(code) as any
    }

    getAllRooms(): RoomInfo[] {
        return (this.db()?.prepare('SELECT id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount, totalTokens, sessionSeed FROM gc_rooms ORDER BY id').all() || []) as any[]
    }

    getRoomsForProfiles(profiles: string[]): RoomInfo[] {
        const uniqueProfiles = [...new Set(profiles.map(profile => profile.trim()).filter(Boolean))]
        if (!uniqueProfiles.length) return []
        const placeholders = uniqueProfiles.map(() => '?').join(', ')
        return (this.db()?.prepare(
            `SELECT DISTINCT r.id, r.name, r.inviteCode, r.triggerTokens, r.maxHistoryTokens, r.tailMessageCount, r.totalTokens, r.sessionSeed
             FROM gc_rooms r
             INNER JOIN gc_room_agents a ON a.roomId = r.id
             WHERE a.profile IN (${placeholders})
             ORDER BY r.id`
        ).all(...uniqueProfiles) || []) as any[]
    }

    saveRoom(id: string, name: string, inviteCode?: string, config?: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }): void {
        this.db()?.prepare(
            'INSERT OR IGNORE INTO gc_rooms (id, name, inviteCode, triggerTokens, maxHistoryTokens, tailMessageCount) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(id, name, inviteCode || null, config?.triggerTokens ?? 100000, config?.maxHistoryTokens ?? 32000, config?.tailMessageCount ?? 10)
    }

    updateRoomConfig(roomId: string, config: { triggerTokens?: number; maxHistoryTokens?: number; tailMessageCount?: number }): void {
        const sets: string[] = []
        const vals: any[] = []
        if (config.triggerTokens !== undefined) { sets.push('triggerTokens = ?'); vals.push(config.triggerTokens) }
        if (config.maxHistoryTokens !== undefined) { sets.push('maxHistoryTokens = ?'); vals.push(config.maxHistoryTokens) }
        if (config.tailMessageCount !== undefined) { sets.push('tailMessageCount = ?'); vals.push(config.tailMessageCount) }
        if (sets.length === 0) return
        vals.push(roomId)
        this.db()?.prepare(`UPDATE gc_rooms SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }

    updateRoomInviteCode(roomId: string, inviteCode: string): void {
        this.db()?.prepare('UPDATE gc_rooms SET inviteCode = ? WHERE id = ?').run(inviteCode, roomId)
    }

    updateRoomTotalTokens(roomId: string, tokens: number): void {
        this.db()?.prepare('UPDATE gc_rooms SET totalTokens = ? WHERE id = ?').run(tokens, roomId)
    }

    rotateRoomSessionSeed(roomId: string): string {
        const seed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
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
        if (snapshot && messages.length) {
            const snapshotIdx = messages.findIndex(m => m.id === snapshot.lastMessageId)
            const newMessages = snapshotIdx >= 0
                ? messages.slice(snapshotIdx + 1)
                : messages.filter(m => m.timestamp > snapshot.lastMessageTimestamp)
            const newUsage = this.estimateUsageTokensFromMessages(newMessages)
            return countTokens(SUMMARY_PREFIX + snapshot.summary) + newUsage.inputTokens + newUsage.outputTokens
        }
        const usage = this.estimateUsageTokensFromMessages(messages)
        return usage.inputTokens + usage.outputTokens
    }

    // ─── Messages ─────────────────────────────────────────────

    getMessages(roomId: string, limit = 300, offset = 0): ChatMessage[] {
        const rows = (this.db()?.prepare(
            'SELECT id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content FROM gc_messages WHERE roomId = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?'
        ).all(roomId, limit, offset) || []) as any[]
        return sortGroupMessages(rows.map(row => ({
            ...row,
            tool_calls: parseJsonArray(row.tool_calls),
        })))
    }

    getMessageCount(roomId: string): number {
        const row = this.db()?.prepare(
            'SELECT COUNT(*) as total FROM gc_messages WHERE roomId = ?'
        ).get(roomId) as { total: number } | undefined
        return row?.total || 0
    }

    getMessage(messageId: string): ChatMessage | null {
        const row = this.db()?.prepare(
            'SELECT id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content FROM gc_messages WHERE id = ?'
        ).get(messageId) as any
        if (!row) return null
        return {
            ...row,
            tool_calls: parseJsonArray(row.tool_calls),
        }
    }

    addMessage(msg: ChatMessage): void {
        this.upsertMessage(msg)
    }

    upsertMessage(msg: ChatMessage): void {
        const toolCallsJson = msg.tool_calls ? JSON.stringify(msg.tool_calls) : null
        this.db()?.prepare(
            `INSERT INTO gc_messages (id, roomId, senderId, senderName, content, timestamp, role, tool_call_id, tool_calls, tool_name, finish_reason, reasoning, reasoning_details, reasoning_content)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
                reasoning_content = excluded.reasoning_content`
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
        )
    }

    saveMessageAndRefreshRoom(msg: ChatMessage, options: { preserveExistingTimestamp?: boolean } = {}): { message: ChatMessage; totalTokens: number } {
        const db = this.db()
        if (!db) return { message: msg, totalTokens: 0 }
        db.exec('BEGIN IMMEDIATE')
        try {
            const existing = this.getMessage(msg.id)
            const message = existing && options.preserveExistingTimestamp ? { ...msg, timestamp: existing.timestamp } : msg
            this.upsertMessage(message)
            this.pruneMessages(msg.roomId)
            const messages = this.getMessages(msg.roomId)
            const totalTokens = this.estimateRoomTotalTokens(msg.roomId, messages)
            this.updateRoomTotalTokens(msg.roomId, totalTokens)
            db.exec('COMMIT')
            return { message, totalTokens }
        } catch (err) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw err
        }
    }

    clearRoomContext(roomId: string): void {
        const db = this.db()
        if (!db) return
        db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
        db.prepare('UPDATE gc_rooms SET totalTokens = 0, sessionSeed = ? WHERE id = ?').run(`${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, roomId)
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
                const result = db.prepare('DELETE FROM gc_messages WHERE roomId = ? AND timestamp < ?').run(roomId, cutoff.timestamp)
                logger.info(`[GroupChat] pruned ${result.changes} messages from room ${roomId} (had ${count}, keeping ${keep})`)
            }
        }
    }

    // ─── Room Agents ──────────────────────────────────────────

    getRoomAgents(roomId: string): RoomAgent[] {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited FROM gc_room_agents WHERE roomId = ?'
        ).all(roomId) || []) as unknown as RoomAgent[]
    }

    addRoomAgent(roomId: string, agentId: string, profile: string, name: string, description: string, invited: number): RoomAgent {
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.db()?.prepare(
            'INSERT INTO gc_room_agents (id, roomId, agentId, profile, name, description, invited) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, roomId, agentId, profile, name, description, invited)
        return { id, roomId, agentId, profile, name, description, invited }
    }

    getRoomAgent(roomId: string, agentRef: string): RoomAgent | null {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited FROM gc_room_agents WHERE roomId = ? AND (id = ? OR agentId = ?)'
        ).get(roomId, agentRef, agentRef) as any) ?? null
    }

    getRoomAgentByAgentId(roomId: string, agentId: string): RoomAgent | null {
        return (this.db()?.prepare(
            'SELECT id, roomId, agentId, profile, name, description, invited FROM gc_room_agents WHERE roomId = ? AND agentId = ?'
        ).get(roomId, agentId) as any) ?? null
    }

    removeRoomAgent(roomId: string, agentRef: string): void {
        this.db()?.prepare('DELETE FROM gc_room_agents WHERE roomId = ? AND (id = ? OR agentId = ?)').run(roomId, agentRef, agentRef)
    }

    // ─── Context Snapshots ──────────────────────────────────

    getContextSnapshot(roomId: string): { roomId: string; summary: string; lastMessageId: string; lastMessageTimestamp: number; updatedAt: number } | null {
        return (this.db()?.prepare(
            'SELECT roomId, summary, lastMessageId, lastMessageTimestamp, updatedAt FROM gc_context_snapshots WHERE roomId = ?'
        ).get(roomId) as any) ?? null
    }

    saveContextSnapshot(roomId: string, summary: string, lastMessageId: string, lastMessageTimestamp: number): void {
        this.db()?.prepare(
            'INSERT INTO gc_context_snapshots (roomId, summary, lastMessageId, lastMessageTimestamp, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(roomId) DO UPDATE SET summary = excluded.summary, lastMessageId = excluded.lastMessageId, lastMessageTimestamp = excluded.lastMessageTimestamp, updatedAt = excluded.updatedAt'
        ).run(roomId, summary, lastMessageId, lastMessageTimestamp, Date.now())
    }

    deleteContextSnapshot(roomId: string): void {
        this.db()?.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
    }

    deleteRoom(roomId: string): void {
        const db = this.db()
        if (!db) return
        db.prepare('DELETE FROM gc_messages WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_room_agents WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_room_members WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_context_snapshots WHERE roomId = ?').run(roomId)
        db.prepare('DELETE FROM gc_rooms WHERE id = ?').run(roomId)
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

        const existing = this.getMemberByUserId(roomId, userId)
        if (existing) {
            const nextAvatar = resolvedAvatar || existing.avatar || ''
            const nextAuthUserId = typeof authUserId === 'number' && authUserId > 0
                ? authUserId
                : existing.authUserId ?? null
            // Update name/description/avatar on rejoin, refresh updatedAt
            this.db()?.prepare(
                'UPDATE gc_room_members SET userName = ?, description = ?, avatar = ?, authUserId = ?, updatedAt = ? WHERE roomId = ? AND userId = ?'
            ).run(userName, description, nextAvatar, nextAuthUserId, Date.now(), roomId, userId)
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
    private _contextEngine: ContextEngine | null = null
    private _restoreScheduled = false
    /** roomId -> (userId -> { userName, timer }) */
    private typingState = new Map<string, Map<string, { userName: string; timer: ReturnType<typeof setTimeout> }>>()
    /** roomId -> (agentName -> { agentName, status }) */
    private contextStatusState = new Map<string, Map<string, { agentName: string; status: string }>>()

    constructor(httpServers: HttpServer | HttpServer[]) {
        this.storage = new ChatStorage()
        this.storage.init()
        const servers = Array.isArray(httpServers) ? httpServers : [httpServers]

        this.io = new Server(servers[0], {
            cors: { origin: '*' },
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
            sessionCleaner: async (sessionId: string) => {
                // TODO: re-enable session deletion after confirming it doesn't
                // accidentally remove user-created sessions outside group chat.
                // try {
                //     const profile = this.storage.getSessionProfile(sessionId)
                //     const profileName = profile?.profile_name || 'default'
                //     this.storage.enqueuePendingSessionDelete(sessionId, profileName)
                // } catch (err: any) {
                //     logger.warn(`[GroupChat] failed to enqueue compression session delete ${sessionId}: ${err.message}`)
                // }
            },
        })
        this.agentClients.setContextEngine(contextEngine)
        this.agentClients.setStorage(this.storage)
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

    getContextEngine(): ContextEngine | null {
        return this._contextEngine || null
    }

    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    clearRoomRuntimeState(roomId: string): void {
        const roomTyping = this.typingState.get(roomId)
        if (roomTyping) {
            for (const entry of roomTyping.values()) clearTimeout(entry.timer)
            this.typingState.delete(roomId)
        }
        this.contextStatusState.delete(roomId)
        this.agentClients.resetRoomContext(roomId)
        this.nsp.to(roomId).emit('room_cleared', { roomId, totalTokens: 0 })
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens: 0 })
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
                try {
                    const client = await this.agentClients.createAgent({
                        agentId: agent.agentId,
                        profile: agent.profile,
                        name: agent.name,
                        description: agent.description,
                        invited: agent.invited,
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
        const auth = socket.handshake.auth as { source?: string; agentSocketSecret?: string; token?: string }
        const isAgentSocket = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET
        if (isAgentSocket) {
            next()
            return
        }

        const token = auth.token || socket.handshake.query.token || ''
        if (await isAuthEnabled() && !await authenticateUserToken(String(token))) {
            return next(new Error('Unauthorized'))
        }
        next()
    }

    // ─── Connection ─────────────────────────────────────────────

    private onConnection(socket: Socket): void {
        const auth = socket.handshake.auth as { userId?: string; name?: string; description?: string; source?: string; agentSocketSecret?: string; authUserId?: number }
        const userId = auth.userId || socket.id
        const userName = auth.name || `User-${userId.slice(0, 6)}`
        const description = auth.description || ''
        const requestedSource = auth.source === 'agent' && auth.agentSocketSecret === GROUP_CHAT_AGENT_SOCKET_SECRET ? 'agent' : 'human'

        this.socketUserMap.set(socket.id, userId)
        this.socketRequestedSourceMap.set(socket.id, requestedSource)
        this.userInfoMap.set(userId, { name: userName, description })
        if (typeof auth.authUserId === 'number') {
            this.socketAuthUserIdMap.set(socket.id, auth.authUserId)
        }

        logger.debug(`[GroupChat] Connected: ${userName} (socket=${socket.id}, user=${userId})`)

        socket.on('join', (data: { roomId?: string; name?: string }, ack?: (response?: unknown) => void) => this.handleJoin(socket, data, ack))
        socket.on('message', (data: Partial<ChatMessage> & { roomId?: string; content: string | Array<Record<string, unknown>>; id?: string; mentionDepth?: number }, ack?: (response?: unknown) => void) => this.handleMessage(socket, data, ack))
        socket.on('message_stream_start', (data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number }) => this.handleMessageStreamStart(socket, data))
        socket.on('message_stream_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageStreamDelta(socket, data))
        socket.on('message_reasoning_delta', (data: { roomId?: string; id?: string; delta?: string }) => this.handleMessageReasoningDelta(socket, data))
        socket.on('message_stream_end', (data: { roomId?: string; id?: string }) => this.handleMessageStreamEnd(socket, data))
        socket.on('typing', (data: { roomId?: string }) => this.handleTyping(socket, data))
        socket.on('stop_typing', (data: { roomId?: string }) => this.handleStopTyping(socket, data))
        socket.on('context_status', (data: { roomId?: string; agentName?: string; status?: string }) => this.handleContextStatus(socket, data))
        socket.on('interrupt_agent', (data: { roomId?: string; agentName?: string }, ack?: (response?: unknown) => void) => this.handleInterruptAgent(socket, data, ack))
        socket.on('approval.requested', (data: { roomId?: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean }) => this.handleApprovalRequested(socket, data))
        socket.on('approval.resolved', (data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string }) => this.handleApprovalResolved(socket, data))
        socket.on('approval.respond', (data: { roomId?: string; approval_id?: string; choice?: string }, ack?: (response?: unknown) => void) => this.handleApprovalRespond(socket, data, ack))
        socket.on('disconnect', () => this.handleDisconnect(socket))
    }

    // ─── Handlers ───────────────────────────────────────────────

    private handleJoin(socket: Socket, data: { roomId?: string; name?: string; description?: string }, ack?: (res: any) => void): void {
        const socketId = socket.id
        const userId = this.socketUserMap.get(socketId) || socketId
        const requestedSource = this.socketRequestedSourceMap.get(socketId) || 'human'
        const roomId = data.roomId || 'general'
        const roomAgent = this.storage.getRoomAgentByAgentId(roomId, userId)
        const source = requestedSource === 'agent' && roomAgent ? 'agent' : 'human'
        if (source === 'human' && roomAgent) {
            ack?.({ error: 'Reserved member identity' })
            return
        }
        const existingMember = this.storage.getMemberByUserId(roomId, userId)
        const userInfo = this.userInfoMap.get(userId) || {
            name: existingMember?.name || `User-${userId.slice(0, 6)}`,
            description: existingMember?.description || '',
        }
        const userName = data.name || existingMember?.name || userInfo.name
        const description = data.description || existingMember?.description || userInfo.description

        // Update stored user info
        this.userInfoMap.set(userId, { name: userName, description })

        let room = this.rooms.get(roomId)
        if (!room) {
            room = new ChatRoom(roomId)
            this.rooms.set(roomId, room)
            this.storage.saveRoom(roomId, roomId)
        }

        // Look up the user's avatar via their numeric users.id from the web UI session.
        // Falls back to name-based lookup for clients that don't pass authUserId.
        let userAvatar = ''
        let authUserId: number | undefined
        if (source !== 'agent') {
            authUserId = this.socketAuthUserIdMap.get(socket.id)
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

        // Persist only human members. Agent sockets are runtime participants
        // tracked through gc_room_agents and AgentClients; storing them in
        // gc_room_members makes member counts grow on reconnect/restore.
        if (source !== 'agent') {
            this.storage.addRoomMember(roomId, userId, userName, description, userAvatar, authUserId)
        }

        // Add to in-memory online participants (keyed by userId)
        room.addOrUpdateMember(socketId, userId, userName, description, source, userAvatar)
        socket.join(roomId)

        if (source !== 'agent') {
            socket.to(roomId).emit('member_joined', {
                roomId,
                memberId: userId,
                memberName: userName,
                members: room.getMembersList(),
            })
        }

        // Load history from SQLite
        const messages = this.storage.getMessages(roomId)
        const agents = this.storage.getRoomAgents(roomId)

        ack?.({
            roomId,
            roomName: room.name,
            members: room.getMembersList(),
            messages,
            agents,
            rooms: this.getRoomIds(),
            typingUsers: this.getTypingUsers(roomId),
            contextStatuses: this.getContextStatuses(roomId),
        })

        logger.debug(`[GroupChat] ${userName} (user=${userId}) joined room: ${roomId}`)
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
        const userId = member?.userId || socketId
        const userName = member?.name || `User-${socketId.slice(0, 6)}`

        const msg: ChatMessage = {
            id: this.normalizeClientMessageId(data.id) || this.generateId(),
            roomId,
            senderId: userId,
            senderName: userName,
            content: contentToStorageString(data.content),
            timestamp: this.normalizeMessageTimestamp(data.timestamp, data.role),
            role: normalizeMessageRole(data.role),
            tool_call_id: data.tool_call_id ?? null,
            tool_calls: Array.isArray(data.tool_calls) ? data.tool_calls : null,
            tool_name: data.tool_name ?? null,
            finish_reason: data.finish_reason ?? null,
            reasoning: data.reasoning ?? null,
            reasoning_details: data.reasoning_details ?? null,
            reasoning_content: data.reasoning_content ?? null,
        }

        const saved = this.storage.saveMessageAndRefreshRoom(msg)
        const savedMsg = saved.message
        const totalTokens = saved.totalTokens

        this.nsp.to(roomId).emit('message', savedMsg)
        this.nsp.to(roomId).emit('room_updated', { roomId, totalTokens })
        ack?.({ id: savedMsg.id })

        const mentionDepth = normalizeMentionDepth(data.mentionDepth)
        const isAgentReply = savedMsg.role === 'assistant' && member?.source === 'agent'
        const shouldRouteMentions = savedMsg.role === 'user' ||
            (isAgentReply && mentionDepth < maxAgentMentionDepth())

        if (shouldRouteMentions) {
            // Server-side @mention routing — parse mentions and invoke agents directly.
            // Agent replies are allowed to mention other agents, but mentionDepth
            // bounds chained agent-to-agent handoffs so one prompt cannot loop forever.
            this.agentClients.processMentions(roomId, {
                content: contentToText(savedMsg.content),
                input: Array.isArray(data.content) ? data.content : undefined,
                senderName: savedMsg.senderName,
                senderId: savedMsg.senderId,
                timestamp: savedMsg.timestamp,
                mentionDepth,
            }).catch((err) => {
                logger.error(`[GroupChat] processMentions error: ${err.message}`)
            })
        }
    }

    private handleMessageStreamStart(socket: Socket, data: { roomId?: string; id?: string; senderId?: string; senderName?: string; timestamp?: number }): void {
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)
        if (!room || !room.hasOnlineMember(socket.id)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return

        const member = room.getOnlineMemberBySocketId(socket.id)
        this.nsp.to(roomId).emit('message_stream_start', {
            id,
            roomId,
            senderId: data.senderId || member?.userId || socket.id,
            senderName: data.senderName || member?.name || `User-${socket.id.slice(0, 6)}`,
            content: '',
            timestamp: data.timestamp || Date.now(),
            role: 'assistant',
            finish_reason: 'streaming',
        })
    }

    private handleMessageStreamDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string }): void {
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)
        if (!room || !room.hasOnlineMember(socket.id)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.nsp.to(roomId).emit('message_stream_delta', {
            roomId,
            id,
            delta: String(data.delta),
        })
    }

    private handleMessageReasoningDelta(socket: Socket, data: { roomId?: string; id?: string; delta?: string }): void {
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)
        if (!room || !room.hasOnlineMember(socket.id)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id || !data.delta) return
        this.nsp.to(roomId).emit('message_reasoning_delta', {
            roomId,
            id,
            delta: String(data.delta),
        })
    }

    private handleMessageStreamEnd(socket: Socket, data: { roomId?: string; id?: string }): void {
        const roomId = data.roomId || 'general'
        const room = this.rooms.get(roomId)
        if (!room || !room.hasOnlineMember(socket.id)) return
        const id = this.normalizeClientMessageId(data.id)
        if (!id) return
        this.nsp.to(roomId).emit('message_stream_end', { roomId, id })
    }

    private handleTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
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

        socket.to(roomId).emit('typing', {
            roomId,
            userId,
            userName,
        })
    }

    private handleStopTyping(socket: Socket, data: { roomId?: string }): void {
        const roomId = data.roomId || 'general'
        const userId = this.socketUserMap.get(socket.id) || socket.id

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

    private handleContextStatus(socket: Socket, data: { roomId?: string; agentName?: string; status?: string; totalTokens?: number }): void {
        const roomId = data.roomId || 'general'
        const agentName = data.agentName || ''
        const status = data.status || ''

        if (!agentName) return

        let roomStatuses = this.contextStatusState.get(roomId)
        if (!roomStatuses) {
            roomStatuses = new Map()
            this.contextStatusState.set(roomId, roomStatuses)
        }

        if (status === 'ready') {
            roomStatuses.delete(agentName)
            if (roomStatuses.size === 0) this.contextStatusState.delete(roomId)
        } else {
            roomStatuses.set(agentName, { agentName, status })
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
        try {
            await this.agentClients.interruptAgent(roomId, agentName)
            this.nsp.to(roomId).emit('context_status', { roomId, agentName, status: 'ready' })
            ack?.({ ok: true })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to interrupt agent ${agentName} in room ${roomId}: ${err.message}`)
            ack?.({ error: err.message || 'interrupt failed' })
        }
    }

    private handleApprovalRequested(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; command?: string; description?: string; choices?: string[]; allow_permanent?: boolean }): void {
        const roomId = data.roomId
        if (!roomId || !data.approval_id) return
        this.nsp.to(roomId).emit('approval.requested', {
            event: 'approval.requested',
            roomId,
            agentName: data.agentName || '',
            approval_id: data.approval_id,
            command: data.command || '',
            description: data.description || '',
            choices: Array.isArray(data.choices) ? data.choices : ['once', 'session', 'deny'],
            allow_permanent: Boolean(data.allow_permanent),
        })
    }

    private handleApprovalResolved(socket: Socket, data: { roomId?: string; agentName?: string; approval_id?: string; choice?: string }): void {
        const roomId = data.roomId
        if (!roomId || !data.approval_id) return
        this.nsp.to(roomId).emit('approval.resolved', {
            event: 'approval.resolved',
            roomId,
            agentName: data.agentName || '',
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
        if (!room?.hasOnlineMember(socket.id)) {
            ack?.({ error: 'Not in room' })
            return
        }
        try {
            const result = await new AgentBridgeClient().approvalRespond(data.approval_id, data.choice || 'deny')
            ack?.({ ok: true, resolved: Boolean((result as any)?.resolved) })
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to respond approval ${data.approval_id}: ${err.message}`)
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
                if (member?.source !== 'agent') {
                    this.nsp.to(rid).emit('member_left', {
                        roomId: rid,
                        memberId: member?.userId || socketId,
                        memberName: member?.name || `User-${socketId.slice(0, 6)}`,
                        members: room.getMembersList(),
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
