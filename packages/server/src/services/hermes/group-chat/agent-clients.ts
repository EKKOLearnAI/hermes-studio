import { io, Socket } from 'socket.io-client'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { getToken } from '../../../services/auth'
import { logger } from '../../../services/logger'
import { countTokens } from '../../../lib/context-compressor'
import { AgentBridgeClient, type AgentBridgeContextEstimate, type AgentBridgeMessage, type AgentBridgeOutput } from '../agent-bridge'
import { convertContentBlocksForAgent, isContentBlockArray } from '../run-chat/content-blocks'
import { resolveBridgeRunModelConfig } from '../run-chat/model-config'
import {
    completeWorkspaceRunCheckpointDraft,
    discardWorkspaceRunCheckpoint,
    startWorkspaceRunCheckpoint,
} from '../run-chat/workspace-diff-tracker'
import type { ContentBlock } from '../run-chat/types'
import type { StoredMessage } from '../context-engine/types'
import type { GroupRoomSummaryService, GroupRuntimeContext } from './room-summary'
import {
    isAllAgentsMentioned,
    resolveMentionTargets,
    stripMentionRoutingTokens,
} from './mention-routing'
import { buildAgentInstructions } from '../context-engine/prompt'

export const GROUP_CHAT_AGENT_SOCKET_SECRET = randomBytes(32).toString('hex')

// ─── Types ────────────────────────────────────────────────────

export interface AgentConfig {
    agentId?: string
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude'
    profile: string
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    name: string
    description: string
    invited: number
    /** Group-chat Hermes agents must never detach delegate_task work. */
    backgroundDelegationEnabled: false
}

interface MessageData {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
    run_id?: string | null
}

export type MentionMessage = {
    messageId?: string
    content: string
    senderName: string
    senderId: string
    timestamp: number
    role?: string
    input?: string | ContentBlock[]
    mentionDepth?: number
}

export function mentionMessageToStoredContextMessage(roomId: string, msg: MentionMessage): StoredMessage {
    return {
        id: msg.messageId || '',
        roomId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: msg.content,
        timestamp: msg.timestamp,
        role: msg.role === 'assistant' ? 'assistant' : 'user',
    }
}

type GroupEstimateMessage = { role: 'user' | 'assistant'; content: string }
export type GroupModelContext = { model: string; provider: string }
export type GroupAgentSessionConfig = {
    agent?: 'hermes' | 'ekko' | 'codex' | 'claude'
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
}
type WorkspaceDiffTerminalStatus = 'completed' | 'failed' | 'aborted'
export type WorkspaceDiffBroadcaster = (roomId: string, message: MessageData & Record<string, unknown>, totalTokens: number) => void
type AgentActivityBroadcaster = (
    roomId: string,
    agentName: string,
    status: 'compressing' | 'replying' | 'ready',
) => void

function isUnknownBridgeSessionError(err: unknown): boolean {
    const message = String((err as any)?.message || err || '').toLowerCase()
    return message.includes('unknown session') || message.includes('session not found')
}

interface WorkspaceDiffRunState {
    roomId: string
    sessionId: string
    runId: string
    responseRunId: string
    workspace: string
    abortRequested: boolean
    finalized: boolean
}

interface BridgeContextCache {
    fixedContextTokens: number
    instructions?: string
    systemPromptTokens?: number
    toolTokens?: number
    systemPromptChars?: number
    toolCount?: number
    toolNames?: string[]
    profile?: string
    model?: string
    provider?: string
}

export async function resolveGroupAgentModelContext(
    profile: string,
    model?: string,
    provider?: string,
): Promise<GroupModelContext> {
    return resolveBridgeRunModelConfig({
        profile,
        requestedModel: model,
        requestedProvider: provider,
        preferRequested: true,
    })
}

export function estimateGroupHistoryMessageTokens(history: Array<{ content?: unknown }>): number {
    return history.reduce((sum, message) => sum + countTokens(String(message.content || '')), 0)
}

export function groupContextTokensWithFixedOverhead(
    fixedContextTokens: number | null | undefined,
    history: Array<{ content?: unknown }>,
): number | undefined {
    if (typeof fixedContextTokens !== 'number' || !Number.isFinite(fixedContextTokens) || fixedContextTokens < 0) {
        return undefined
    }
    return Math.floor(fixedContextTokens) + estimateGroupHistoryMessageTokens(history)
}

export function isGroupBridgeContextCacheCompatible(
    cache: { model?: string; provider?: string } | null | undefined,
    modelContext: GroupModelContext,
): boolean {
    if (!cache) return false
    if (modelContext.model && cache.model !== modelContext.model) return false
    if (modelContext.provider && cache.provider !== modelContext.provider) return false
    return true
}

export function groupBridgeReasoningDeltaFromEvent(event: Record<string, unknown>): string | null {
    if (String(event.event || '') !== 'reasoning.delta') return null
    const text = String(event.text || '')
    return text ? text : null
}

export interface MemberData {
    id: string
    name: string
    joinedAt: number
}

export interface JoinResult {
    roomId: string
    roomName: string
    members: MemberData[]
    messages: MessageData[]
    rooms: string[]
}

export interface AgentEventHandler {
    onMessage?: (data: { roomId: string; msg: MessageData }) => void
    onTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onStopTyping?: (data: { roomId: string; userId: string; userName: string }) => void
    onMemberJoined?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
    onMemberLeft?: (data: { roomId: string; memberId: string; memberName: string; members: MemberData[] }) => void
}

export interface GroupAgentEventSink {
    readonly connected: boolean
    readonly id?: string
    sendMessage(
        roomId: string,
        content: string,
        messageId?: string,
        extra?: Record<string, unknown>,
        agentSessionId?: string,
    ): Promise<string>
    emit(event: string, payload: Record<string, unknown>): void
    disconnect?(): void
}

export interface GroupAgentExecutor {
    readonly agentId: string
    readonly agent: 'hermes' | 'ekko' | 'codex' | 'claude'
    readonly profile: string
    readonly provider: string
    readonly model: string
    readonly apiMode: string
    readonly reasoningEffort: string
    readonly name: string
    readonly description: string
    readonly connected: boolean
    disconnect(): void
    sendMessage(roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>, agentSessionId?: string): Promise<string>
    interrupt(roomId: string): Promise<boolean>
    getActiveSessionId(roomId: string): string | undefined
    isActiveSession(roomId: string, sessionId: string): boolean
    respondApproval?(approvalId: string, choice: string): Promise<boolean>
    replyToMention(
        roomId: string,
        msg: MentionMessage,
        runtimeContext?: GroupRuntimeContext,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void>
    setStorage(storage: any): void
    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void
    setChatRunService(service: GroupChatRunService | null): void
}

export interface GroupChatRunService {
    runAndWait(
        data: {
            input: string | ContentBlock[]
            session_id: string
            model?: string
            provider?: string
            apiMode?: string
            instructions?: string
            group_system_prompt?: string
            group_room_id?: string
            group_agent_id?: string
            workspace?: string | null
            source?: string
            session_source?: 'group_chat'
            coding_agent_id?: 'claude-code' | 'codex' | 'ekko-agent'
            mode?: 'scoped'
            profile?: string
            reasoning_effort?: string
            background_delegation_enabled?: boolean
            context_compression_enabled?: boolean
        },
        options?: {
            profile?: string
            timeoutMs?: number
            onEvent?: (event: string, payload: any) => void
        },
    ): Promise<{
        ok: boolean
        output?: string | null
        reasoning?: string | null
        error?: string
    }>
    abortSession(sessionId: string, reason?: string): Promise<void>
    disposeSession?(sessionId: string): Promise<void>
}

// ─── Agent Client (single connection) ─────────────────────────

export class AgentClient implements GroupAgentExecutor {
    readonly agentId: string
    readonly agent: 'hermes' | 'ekko' | 'codex' | 'claude'
    readonly profile: string
    readonly provider: string
    readonly model: string
    readonly apiMode: string
    readonly reasoningEffort: string
    readonly name: string
    readonly description: string
    private readonly backgroundDelegationEnabled: false
    private socket: Socket | null = null
    private joinedRooms = new Set<string>()
    private handlers: AgentEventHandler
    private _reconnecting = false
    private storage: any = null
    private pendingToolCallIds = new Map<string, string[]>()
    private pendingToolBaseIds = new Map<string, string>()
    private pendingToolRunIds = new Map<string, string>()
    private pendingToolNames = new Map<string, string>()
    private bridgeContextCache = new Map<string, BridgeContextCache>()
    private workspaceDiffRuns = new Map<string, WorkspaceDiffRunState>()
    private interruptVersions = new Map<string, number>()
    private activeSessions = new Map<string, string>()
    private workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null
    private chatRunService: GroupChatRunService | null = null
    private readonly eventSink: GroupAgentEventSink | null

    constructor(config: AgentConfig, handlers: AgentEventHandler = {}, eventSink: GroupAgentEventSink | null = null) {
        this.agentId = config.agentId || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.agent = config.agent || 'hermes'
        this.profile = config.profile
        this.provider = String(config.provider || '').trim()
        this.model = String(config.model || '').trim()
        this.apiMode = this.agent === 'hermes' ? '' : String(config.apiMode || '').trim()
        this.reasoningEffort = String(config.reasoningEffort || '').trim()
        this.name = config.name
        this.description = config.description
        this.backgroundDelegationEnabled = config.backgroundDelegationEnabled ?? false
        this.handlers = handlers
        this.eventSink = eventSink
    }

    get connected(): boolean {
        return this.eventSink?.connected ?? this.socket?.connected ?? false
    }

    get id(): string | undefined {
        return this.eventSink?.id || this.socket?.id
    }

    setStorage(storage: any): void {
        this.storage = storage
    }

    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void {
        this.workspaceDiffBroadcaster = broadcaster
    }

    setChatRunService(service: GroupChatRunService | null): void {
        this.chatRunService = service
    }

    async connect(port?: number): Promise<void> {
        if (this.eventSink) {
            this.ensureConnected()
            return
        }
        const actualPort = port ?? parseInt(process.env.PORT || '8648', 10)
        const token = await getToken()

        this.socket = io(`http://127.0.0.1:${actualPort}/group-chat`, {
            auth: {
                token: token || undefined,
                userId: this.agentId,
                name: this.name,
                description: this.description,
                source: 'agent',
                agentSocketSecret: GROUP_CHAT_AGENT_SOCKET_SECRET,
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
            randomizationFactor: 0.5,
            timeout: 30000,
        })

        this.bindEvents()

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

            this.socket!.on('connect', () => {
                clearTimeout(timeout)
                logger.debug(`[AgentClient] ${this.name} connected, socket id: ${this.socket!.id}`)
                resolve()
            })

            this.socket!.on('connect_error', (err) => {
                clearTimeout(timeout)
                logger.error(err, `[AgentClient] ${this.name} connect_error`)
                reject(err)
            })
        })
    }

    disconnect(): void {
        this.eventSink?.disconnect?.()
        if (this.socket) {
            this.socket.disconnect()
            this.socket = null
            this.joinedRooms.clear()
            this.bridgeContextCache.clear()
        }
    }

    async joinRoom(roomId: string): Promise<JoinResult> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('join', { roomId }, (res: JoinResult | { error: string }) => {
                if ('error' in res) {
                    reject(new Error(res.error))
                } else {
                    this.joinedRooms.add(roomId)
                    resolve(res)
                }
            })
        })
    }

    sendMessage(roomId: string, content: string, messageId?: string, extra?: Record<string, unknown>, agentSessionId?: string): Promise<string> {
        this.ensureConnected()
        if (this.eventSink) {
            return this.eventSink.sendMessage(roomId, content, messageId, extra, agentSessionId)
        }
        return new Promise((resolve, reject) => {
            this.socket!.emit('message', { roomId, content, id: messageId, ...extra, ...(agentSessionId ? { agentSessionId } : {}) }, (res: { id?: string; error?: string }) => {
                if (res.error) {
                    reject(new Error(res.error))
                } else {
                    resolve(res.id!)
                }
            })
        })
    }

    startTyping(roomId: string): void {
        this.ensureConnected()
        if (this.eventSink) {
            this.eventSink.emit('typing', { roomId })
            return
        }
        this.socket!.emit('typing', { roomId })
    }

    stopTyping(roomId: string): void {
        this.ensureConnected()
        if (this.eventSink) {
            this.eventSink.emit('stop_typing', { roomId })
            return
        }
        this.socket!.emit('stop_typing', { roomId })
    }

    emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>, agentSessionId?: string): void {
        this.ensureConnected()
        const payload = { roomId, agentName: this.name, status, ...extra, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('context_status', payload)
            return
        }
        this.socket!.emit('context_status', payload)
    }

    emitApprovalRequested(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        const event = { roomId, agentName: this.name, ...payload }
        if (this.eventSink) {
            this.eventSink.emit('approval.requested', event)
            return
        }
        this.socket!.emit('approval.requested', event)
    }

    emitApprovalResolved(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        const event = { roomId, agentName: this.name, ...payload }
        if (this.eventSink) {
            this.eventSink.emit('approval.resolved', event)
            return
        }
        this.socket!.emit('approval.resolved', event)
    }

    async interrupt(roomId: string): Promise<boolean> {
        const sessionId = this.activeSessions.get(roomId)
        if (!sessionId) return true
        if (this.agent !== 'hermes') {
            if (!this.chatRunService) throw new Error('Chat run service is not ready')
            await this.chatRunService.abortSession(sessionId, 'Interrupted by group chat user')
            this.markSessionInterrupted(sessionId)
            const abortedStates = this.markWorkspaceDiffAborted(roomId)
            try {
                for (const state of abortedStates) {
                    await this.finalizeWorkspaceDiffOnce(state, 'aborted', null)
                }
            } finally {
                try { this.stopTyping(roomId) } catch { /* disconnected */ }
                try { this.emitContextStatus(roomId, 'ready', undefined, sessionId) } catch { /* disconnected */ }
            }
            return true
        }
        let result: Awaited<ReturnType<AgentBridgeClient['interrupt']>> | null = null
        try {
            result = await new AgentBridgeClient().interrupt(sessionId, 'Interrupted by group chat user', this.profile)
        } catch (err) {
            if (!isUnknownBridgeSessionError(err)) throw err
            logger.info(`[AgentClients] ${this.name}: bridge session ${sessionId} was already idle/missing during interrupt`)
        }
        const synced = result?.synced !== false
        if (!synced) return false
        this.markSessionInterrupted(sessionId)
        const abortedStates = this.markWorkspaceDiffAborted(roomId)
        try {
            for (const state of abortedStates) {
                await this.finalizeWorkspaceDiffOnce(state, 'aborted', null)
            }
        } finally {
            try {
                this.stopTyping(roomId)
            } catch (err: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to emit stop_typing after interrupt: ${err.message || err}`)
            }
            try {
                this.emitContextStatus(roomId, 'ready', undefined, sessionId)
            } catch (err: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to emit ready status after interrupt: ${err.message || err}`)
            }
        }
        return true
    }

    emitMessageStreamStart(roomId: string, messageId: string, agentSessionId?: string, responseRunId?: string): void {
        this.ensureConnected()
        const payload = {
            roomId,
            id: messageId,
            senderId: this.id || this.agentId,
            senderName: this.name,
            timestamp: Date.now(),
            ...(responseRunId ? { run_id: responseRunId } : {}),
            ...(agentSessionId ? { agentSessionId } : {}),
        }
        if (this.eventSink) {
            this.eventSink.emit('message_stream_start', payload)
            return
        }
        this.socket!.emit('message_stream_start', payload)
    }

    emitMessageStreamDelta(roomId: string, messageId: string, delta: string, agentSessionId?: string): void {
        if (!delta) return
        this.ensureConnected()
        const payload = { roomId, id: messageId, delta, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('message_stream_delta', payload)
            return
        }
        this.socket!.emit('message_stream_delta', payload)
    }

    emitMessageReasoningDelta(roomId: string, messageId: string, delta: string, agentSessionId?: string): void {
        if (!delta) return
        this.ensureConnected()
        const payload = { roomId, id: messageId, delta, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('message_reasoning_delta', payload)
            return
        }
        this.socket!.emit('message_reasoning_delta', payload)
    }

    emitMessageStreamEnd(roomId: string, messageId: string, agentSessionId?: string): void {
        this.ensureConnected()
        const payload = { roomId, id: messageId, ...(agentSessionId ? { agentSessionId } : {}) }
        if (this.eventSink) {
            this.eventSink.emit('message_stream_end', payload)
            return
        }
        this.socket!.emit('message_stream_end', payload)
    }

    getJoinedRooms(): string[] {
        return Array.from(this.joinedRooms)
    }

    getActiveSessionId(roomId: string): string | undefined {
        return this.activeSessions.get(roomId)
    }

    isActiveSession(roomId: string, sessionId: string): boolean {
        return this.activeSessions.get(roomId) === sessionId
    }

    private finiteToken(value: unknown): number | undefined {
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? Math.floor(value)
            : undefined
    }

    private cacheBridgeContext(
        sessionId: string,
        data: Record<string, unknown> | AgentBridgeContextEstimate,
        instructions?: string,
        modelContext: GroupModelContext = { model: '', provider: '' },
    ): void {
        const fixedContextTokens = this.finiteToken(data.fixed_context_tokens)
        if (fixedContextTokens == null) return
        this.bridgeContextCache.set(sessionId, {
            fixedContextTokens,
            instructions,
            systemPromptTokens: this.finiteToken(data.system_prompt_tokens),
            toolTokens: this.finiteToken(data.tool_tokens),
            systemPromptChars: this.finiteToken(data.system_prompt_chars),
            toolCount: this.finiteToken(data.tool_count),
            toolNames: Array.isArray(data.tool_names) ? data.tool_names.map(String) : undefined,
            profile: typeof data.profile === 'string' ? data.profile : undefined,
            model: typeof data.model === 'string' ? data.model : modelContext.model || undefined,
            provider: typeof data.provider === 'string' ? data.provider : modelContext.provider || undefined,
        })
    }

    private estimateHistoryMessageTokens(history: GroupEstimateMessage[]): number {
        return estimateGroupHistoryMessageTokens(history)
    }

    private estimateWithCachedBridgeContext(sessionId: string, history: GroupEstimateMessage[], instructions: string | undefined, modelContext: GroupModelContext): number | undefined {
        const cache = this.bridgeContextCache.get(sessionId)
        if (!cache) return undefined
        if (cache.instructions !== instructions) return undefined
        if (!isGroupBridgeContextCacheCompatible(cache, modelContext)) return undefined
        return groupContextTokensWithFixedOverhead(cache.fixedContextTokens, history)
    }

    private async estimateGroupContextTokens(
        roomId: string,
        sessionId: string,
        bridge: AgentBridgeClient,
        history: GroupEstimateMessage[],
        instructions: string | undefined,
        modelContext: GroupModelContext,
        phase: string,
    ): Promise<number | undefined> {
        const cachedTokens = this.estimateWithCachedBridgeContext(sessionId, history, instructions, modelContext)
        if (cachedTokens != null) {
            logger.info({
                roomId,
                agentName: this.name,
                profile: this.profile,
                sessionId,
                messages: history.length,
                fixedContextTokens: this.bridgeContextCache.get(sessionId)?.fixedContextTokens,
                messageTokens: cachedTokens - (this.bridgeContextCache.get(sessionId)?.fixedContextTokens || 0),
                fullContextTokens: cachedTokens,
                phase,
                source: 'cache',
            }, '[GroupChat] full context estimate')
            return cachedTokens
        }

        const estimate = await bridge.contextEstimate(
            sessionId,
            history,
            instructions,
            this.profile,
            {
                ...(modelContext.model ? { model: modelContext.model } : {}),
                ...(modelContext.provider ? { provider: modelContext.provider } : {}),
                background_delegation_enabled: this.backgroundDelegationEnabled,
            },
        )
        this.cacheBridgeContext(sessionId, estimate, instructions, modelContext)
        const totalTokens = Number(estimate.token_count || 0)
        logger.info({
            roomId,
            agentName: this.name,
            profile: this.profile,
            sessionId,
            messages: estimate.message_count,
            toolCount: estimate.tool_count,
            systemPromptChars: estimate.system_prompt_chars,
            fixedContextTokens: estimate.fixed_context_tokens,
            fullContextTokens: estimate.token_count,
            phase,
            source: 'bridge',
        }, '[GroupChat] full context estimate')
        return Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : undefined
    }

    private ensureConnected(): void {
        if (!this.connected) {
            throw new Error(`Agent "${this.name}" is not connected`)
        }
    }

    private workspaceDiffKey(roomId: string, sessionId: string, runId: string): string {
        return `${roomId}\u0000${sessionId}\u0000${runId}`
    }

    private beginWorkspaceDiffIfNeeded(args: { roomId: string; sessionId: string; runId: string; responseRunId: string; workspace: string }): WorkspaceDiffRunState | null {
        if (!args.workspace) return null
        startWorkspaceRunCheckpoint({
            sessionId: args.sessionId,
            runId: args.runId,
            workspace: args.workspace,
        })
        const state: WorkspaceDiffRunState = { ...args, abortRequested: false, finalized: false }
        this.workspaceDiffRuns.set(this.workspaceDiffKey(args.roomId, args.sessionId, args.runId), state)
        return state
    }

    private discardWorkspaceDiffRun(state: WorkspaceDiffRunState | null): void {
        if (!state) return
        this.workspaceDiffRuns.delete(this.workspaceDiffKey(state.roomId, state.sessionId, state.runId))
        discardWorkspaceRunCheckpoint({ sessionId: state.sessionId, runId: state.runId })
    }

    private interruptVersion(sessionId: string): number {
        return this.interruptVersions.get(sessionId) || 0
    }

    private markSessionInterrupted(sessionId: string): void {
        this.interruptVersions.set(sessionId, this.interruptVersion(sessionId) + 1)
    }

    private replySessionIsCurrent(roomId: string, sessionId: string, interruptVersion: number): boolean {
        return this.roomSessionIsCurrent(roomId, sessionId) && this.interruptVersion(sessionId) === interruptVersion
    }

    private roomSessionIsCurrent(roomId: string, sessionId: string): boolean {
        return Boolean(this.storage?.getRoom?.(roomId))
            && this.activeSessions.get(roomId) === sessionId
    }

    private markWorkspaceDiffAborted(roomId: string): WorkspaceDiffRunState[] {
        const aborted: WorkspaceDiffRunState[] = []
        for (const state of this.workspaceDiffRuns.values()) {
            if (state.roomId === roomId) {
                state.abortRequested = true
                aborted.push(state)
            }
        }
        return aborted
    }

    private async finalizeWorkspaceDiffOnce(
        state: WorkspaceDiffRunState | null,
        status: WorkspaceDiffTerminalStatus,
        parentMessageId?: string | null,
    ): Promise<void> {
        if (!state) return
        const key = this.workspaceDiffKey(state.roomId, state.sessionId, state.runId)
        const current = this.workspaceDiffRuns.get(key)
        if (!current || current.finalized) return
        if (!this.roomSessionIsCurrent(current.roomId, current.sessionId)) {
            this.discardWorkspaceDiffRun(current)
            return
        }
        current.finalized = true
        this.workspaceDiffRuns.delete(key)
        const finalStatus = current.abortRequested ? 'aborted' : status
        let draft
        try {
            draft = completeWorkspaceRunCheckpointDraft({
                sessionId: current.sessionId,
                runId: current.runId,
                workspace: current.workspace,
            })
        } catch (err) {
            logger.warn({ err, roomId: current.roomId, sessionId: current.sessionId, runId: current.runId }, '[GroupChat] failed to complete workspace diff draft')
            return
        }
        if (!draft) return
        try {
            const saved = this.storage?.saveWorkspaceDiffMessageForRun?.({
                roomId: current.roomId,
                senderId: this.agentId,
                senderName: this.name,
                sessionId: current.sessionId,
                runId: current.runId,
                responseRunId: current.responseRunId,
                status: finalStatus,
                workspace: current.workspace,
                draft,
                parentMessageId,
            })
            if (saved?.message) {
                this.workspaceDiffBroadcaster?.(current.roomId, saved.message, saved.totalTokens)
            }
        } catch (err) {
            logger.warn({ err, roomId: current.roomId, sessionId: current.sessionId, runId: current.runId }, '[GroupChat] failed to persist workspace diff message')
        }
    }

    // ─── Hermes Agent Bridge Integration ───────────────────────

    /**
     * Handle an @mention from the server side.
     * Called by AgentClients.processMentions() — no socket round-trip needed.
     * onStatus is called to report context compression progress.
     */
    private groupRuntimeInput(msg: MentionMessage, runtimeContext: GroupRuntimeContext): string | ContentBlock[] {
        const routedPrefix = isAllAgentsMentioned(msg.content)
            ? '群聊系统：这条消息通过 @all 提及所有 agent，你是其中之一，请直接回复。'
            : `群聊系统：这条消息已经提及你（${this.name}），请直接回复；即使消息同时提及其他成员，也不要因此输出空回复。`
        const transcript = runtimeContext.history
            .map(item => `${item.role === 'assistant' ? '智能体' : '成员'}「${item.senderName}」：${item.content}`)
            .join('\n\n')
        const context = [
            routedPrefix,
            runtimeContext.summary
                ? `以下是截至总结锚点的群聊总结：\n<group_chat_summary>\n${runtimeContext.summary}\n</group_chat_summary>`
                : '',
            transcript
                ? `以下是总结锚点之后、当前消息之前的群聊记录：\n<group_chat_history>\n${transcript}\n</group_chat_history>`
                : '',
        ].filter(Boolean).join('\n\n')
        const rawInput = msg.input || msg.content
        if (isContentBlockArray(rawInput)) {
            let markedCurrent = false
            return [
                { type: 'text', text: context },
                ...rawInput.map((block) => {
                    if (block.type !== 'text') return block
                    const text = stripMentionRoutingTokens(String(block.text || msg.content), this.name) || msg.content
                    if (markedCurrent) return { ...block, text }
                    markedCurrent = true
                    return { ...block, text: `当前消息：${text}` }
                }),
            ]
        }
        return `${context}\n\n当前消息：${stripMentionRoutingTokens(msg.content, this.name) || msg.content}`
    }

    private groupSystemPrompt(roomId: string): string {
        const room = this.storage?.getRoom?.(roomId)
        const rawMembers = this.storage?.getRoomMembers?.(roomId)
        const rawAgents = this.storage?.getMentionableRoomAgents?.(roomId)
            ?? this.storage?.getRoomAgents?.(roomId)
        const humanMembers = Array.isArray(rawMembers) ? rawMembers : []
        const roomAgents = Array.isArray(rawAgents) ? rawAgents : []
        const members = [
            ...humanMembers.map((member: any) => ({
                userId: String(member.userId || member.id || ''),
                name: String(member.name || ''),
                description: String(member.description || ''),
                kind: 'human' as const,
            })),
            ...roomAgents.map((agent: any) => ({
                userId: String(agent.agentId || agent.id || ''),
                name: String(agent.name || ''),
                description: String(agent.description || ''),
                kind: 'agent' as const,
            })),
        ].filter(member => member.name)
        const instructions = buildAgentInstructions({
            agentName: this.name,
            roomName: String(room?.name || roomId),
            agentDescription: this.description,
            memberNames: members.map(member => member.name),
            members,
        })
        const remoteWorkspaceApi = room?.remoteWorkspaceApi
        if (
            !remoteWorkspaceApi
            || remoteWorkspaceApi.access !== 'read-write'
            || typeof remoteWorkspaceApi.endpoint !== 'string'
            || typeof remoteWorkspaceApi.token !== 'string'
        ) {
            return instructions
        }
        const workspaceInstructions = [
            'This run may access the sharing host\'s group-chat workspace through a short-lived HTTP JSON API.',
            'Your current local working directory is separate; use this API only when files must be shared with the room owner or other Agents.',
            `Endpoint: ${remoteWorkspaceApi.endpoint}`,
            `Authorization header: Bearer ${remoteWorkspaceApi.token}`,
            'Send POST requests with Content-Type: application/json.',
            'Supported request bodies:',
            '{"action":"list","path":""}',
            '{"action":"read","path":"relative/file.txt"}',
            '{"action":"write","path":"relative/file.txt","content":"text","expectedSha256":"hash returned by read"}',
            '{"action":"mkdir","path":"relative/directory"}',
            '{"action":"delete","path":"relative/file.txt","expectedSha256":"hash returned by read"}',
            'Paths must be relative to the shared group-chat workspace. Existing files require the SHA-256 returned by read before write or delete.',
            'The authorization expires when this run finishes. Never repeat the token in chat output.',
        ].join('\n')
        return `${instructions}\n\n${workspaceInstructions}`
    }

    private groupConversationHistory(runtimeContext: GroupRuntimeContext): Array<{ role: 'user' | 'assistant'; content: string }> {
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
        if (runtimeContext.summary) {
            history.push({
                role: 'user',
                content: `[群聊历史总结]\n${runtimeContext.summary}`,
            })
        }
        for (const message of runtimeContext.history) {
            history.push({
                role: message.role,
                content: `${message.senderName}：${message.content}`,
            })
        }
        return history
    }

    private async replyToMentionWithChatRun(
        roomId: string,
        msg: MentionMessage,
        runtimeContext: GroupRuntimeContext,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        if (!this.chatRunService) throw new Error('Chat run service is not ready')
        const responseRunId = groupMessageId(roomId, this.profile, this.name)
        const runMessageId = groupMessagePartId(responseRunId, 0)
        const sessionId = groupRuntimeSessionId(roomId, this.profile, this.name)
        this.activeSessions.set(roomId, sessionId)
        const interruptVersion = this.interruptVersion(sessionId)
        const reportStatus = (status: 'compressing' | 'replying' | 'ready') => {
            onStatus?.(status, { agentSessionId: sessionId })
        }
        let streamStarted = false
        let streamEnded = false
        let currentContent = ''
        let reasoningContent = ''
        let sawReasoningDelta = false
        let abortRequested = false
        let workspaceRunState: WorkspaceDiffRunState | null = null
        let toolEventWrites = Promise.resolve()
        const isCurrent = () => this.replySessionIsCurrent(roomId, sessionId, interruptVersion)
        const queueToolEventWrite = (write: () => Promise<void>) => {
            toolEventWrites = toolEventWrites
                .then(write)
                .catch((err: any) => logger.warn(`[AgentClients] failed to record group tool event: ${err.message || err}`))
        }
        const endStream = () => {
            if (!streamStarted || streamEnded) return
            streamEnded = true
            this.emitMessageStreamEnd(roomId, runMessageId, sessionId)
        }
        try {
            this.startTyping(roomId)
            reportStatus('replying')
            this.emitMessageStreamStart(roomId, runMessageId, sessionId, responseRunId)
            streamStarted = true
            const workspace = String(this.storage?.getRoom?.(roomId)?.workspace || '').trim()
            if (workspace) {
                workspaceRunState = this.beginWorkspaceDiffIfNeeded({
                    roomId,
                    sessionId,
                    runId: runMessageId,
                    responseRunId,
                    workspace,
                })
            }
            const codingAgentId = this.agent === 'ekko'
                ? 'ekko-agent'
                : this.agent === 'claude'
                    ? 'claude-code'
                    : 'codex'
            const groupSystemPrompt = this.groupSystemPrompt(roomId)
            const result = await this.chatRunService.runAndWait({
                input: this.groupRuntimeInput(msg, runtimeContext),
                session_id: sessionId,
                model: this.model || undefined,
                provider: this.provider || undefined,
                ...(this.apiMode ? { apiMode: this.apiMode } : {}),
                instructions: groupSystemPrompt,
                group_system_prompt: groupSystemPrompt,
                group_room_id: roomId,
                group_agent_id: this.agentId,
                workspace: workspace || null,
                source: 'group_chat',
                session_source: 'group_chat',
                coding_agent_id: codingAgentId,
                mode: 'scoped',
                profile: this.profile,
                reasoning_effort: this.reasoningEffort || undefined,
                background_delegation_enabled: false,
                context_compression_enabled: false,
            }, {
                profile: this.profile,
                onEvent: (event, payload = {}) => {
                    if (!isCurrent()) {
                        if (!abortRequested) {
                            abortRequested = true
                            void this.chatRunService?.abortSession(sessionId, 'Interrupted because group chat room state changed')
                        }
                        return
                    }
                    if (event === 'message.delta' && typeof payload.delta === 'string') {
                        currentContent += payload.delta
                        this.emitMessageStreamDelta(roomId, runMessageId, payload.delta, sessionId)
                    } else if ((event === 'reasoning.delta' || event === 'thinking.delta') && typeof payload.delta === 'string') {
                        sawReasoningDelta = true
                        reasoningContent += payload.delta
                        this.emitMessageReasoningDelta(roomId, runMessageId, payload.delta, sessionId)
                    } else if (event === 'tool.started') {
                        const toolReasoning = reasoningContent
                        reasoningContent = ''
                        queueToolEventWrite(() => this.recordToolStarted(
                            roomId,
                            sessionId,
                            payload,
                            runMessageId,
                            responseRunId,
                            toolReasoning,
                        ))
                    } else if (event === 'tool.completed' || event === 'tool.failed') {
                        queueToolEventWrite(() => this.recordToolCompleted(roomId, sessionId, { ...payload, event }))
                    } else if (event === 'approval.requested') {
                        this.emitApprovalRequested(roomId, { ...payload, agentSessionId: sessionId })
                    } else if (event === 'approval.resolved') {
                        this.emitApprovalResolved(roomId, { ...payload, agentSessionId: sessionId })
                    }
                },
            })
            if (!isCurrent()) return
            await toolEventWrites
            await this.completePendingToolsForRun(roomId, sessionId, responseRunId)
            if (!result.ok) throw new Error(result.error || 'Run failed')
            const finalContent = String(result.output || currentContent || '').trim()
            if (!sawReasoningDelta) reasoningContent = String(result.reasoning || reasoningContent || '')
            if (finalContent) {
                if (!currentContent) this.emitMessageStreamDelta(roomId, runMessageId, finalContent, sessionId)
                this.stopTyping(roomId)
                await this.sendMessage(roomId, finalContent, runMessageId, {
                    role: 'assistant',
                    run_id: responseRunId,
                    mentionDepth: nextMentionDepth(msg),
                    reasoning: reasoningContent || null,
                    reasoning_content: reasoningContent || null,
                }, sessionId)
            }
            endStream()
            await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', finalContent ? runMessageId : null)
            reportStatus('ready')
        } catch (err) {
            if (!isCurrent()) return
            await toolEventWrites
            await this.completePendingToolsForRun(roomId, sessionId, responseRunId)
            await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'failed', streamStarted ? runMessageId : null)
            await this.sendAgentErrorMessage(roomId, runMessageId, err, msg, reasoningContent, sessionId, responseRunId)
            endStream()
            reportStatus('ready')
        } finally {
            try { endStream() } catch { /* stale room session */ }
            if (this.roomSessionIsCurrent(roomId, sessionId)) {
                try { this.stopTyping(roomId) } catch { /* disconnected */ }
                this.activeSessions.delete(roomId)
            }
            await this.chatRunService.disposeSession?.(sessionId).catch((err: any) => {
                logger.warn(`[AgentClients] failed to dispose temporary group chat session ${sessionId}: ${err.message || err}`)
            })
        }
    }

    async replyToMention(
        roomId: string,
        msg: MentionMessage,
        runtimeContext: GroupRuntimeContext = { summary: '', history: [] },
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        logger.debug(`[AgentClients] ${this.name} mentioned by ${msg.senderName}: "${msg.content.slice(0, 50)}"`)
        if (this.agent !== 'hermes') {
            await this.replyToMentionWithChatRun(roomId, msg, runtimeContext, onStatus)
            return
        }
        const runMessageId = groupMessageId(roomId, this.profile, this.name)
        let partIndex = 0
        let streamMessageId = groupMessagePartId(runMessageId, partIndex)
        let currentContent = ''
        let totalContent = ''
        let reasoningContent = ''
        let streamStarted = false
        let bridgeStarted = false
        let workspaceRunState: WorkspaceDiffRunState | null = null
        let activeSessionId = ''
        let activeReplyInterruptVersion = 0
        let staleStartedRunStopped = false
        let stopStaleStartedRun: ((reason?: string) => Promise<void>) | null = null
        try {
            // Notify room that agent is typing
            this.startTyping(roomId)

            const conversationHistory = this.groupConversationHistory(runtimeContext)
            let instructions = this.groupSystemPrompt(roomId)
            const bridge = new AgentBridgeClient()
            const sessionId = groupRuntimeSessionId(roomId, this.profile, this.name)
            this.activeSessions.set(roomId, sessionId)
            const replyInterruptVersion = this.interruptVersion(sessionId)
            const reportStatus = (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => {
                onStatus?.(status, { ...extra, agentSessionId: sessionId })
            }
            activeSessionId = sessionId
            activeReplyInterruptVersion = replyInterruptVersion
            stopStaleStartedRun = async (reason = 'Interrupted because group chat room state changed') => {
                if (staleStartedRunStopped) return
                staleStartedRunStopped = true
                if (bridgeStarted) {
                    let destroySession = false
                    try {
                        const result = await bridge.interrupt(sessionId, reason, this.profile)
                        destroySession = result?.synced === false
                    } catch (err: any) {
                        destroySession = true
                        logger.warn(`[AgentClients] ${this.name}: failed to interrupt stale bridge run: ${err.message || err}`)
                    }
                    if (destroySession) {
                        try {
                            await bridge.destroy(sessionId, this.profile)
                        } catch (err: any) {
                            logger.warn(`[AgentClients] ${this.name}: failed to destroy stale bridge session: ${err.message || err}`)
                        }
                    }
                    if (streamStarted) {
                        try {
                            this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                        } catch (err: any) {
                            logger.warn(`[AgentClients] ${this.name}: failed to end stale stream: ${err.message || err}`)
                        }
                    }
                }
                this.discardWorkspaceDiffRun(workspaceRunState)
                workspaceRunState = null
                try {
                    this.stopTyping(roomId)
                } catch (err: any) {
                    logger.warn(`[AgentClients] ${this.name}: failed to stop typing after stale bridge run: ${err.message || err}`)
                }
                reportStatus('ready')
            }
            const modelContext = await resolveGroupAgentModelContext(this.profile, this.model, this.provider)

            reportStatus('replying')

            // Keep routing explicit while removing only the mention tokens that
            // selected this agent. This avoids making @all look like an
            // instruction for the model to fan out another routing cycle.
            const routedPrefix = isAllAgentsMentioned(msg.content)
                ? `群聊系统：这条消息通过 @all 提及所有 agent，你是其中之一，请直接回复。`
                : `群聊系统：这条消息已经提及你（${this.name}），请直接回复；即使消息同时提及其他成员，也不要因此输出空回复。`
            const rawInput = msg.input || msg.content
            const input = isContentBlockArray(rawInput)
                ? rawInput.map((block) => {
                    if (block.type !== 'text') return block
                    const text = stripMentionRoutingTokens(String(block.text || msg.content), this.name)
                    return { ...block, text: `${routedPrefix}\n\n原始消息：${text || msg.content}` }
                })
                : `${routedPrefix}\n\n原始消息：${stripMentionRoutingTokens(msg.content, this.name) || msg.content}`
            const runPrompt = 'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.'
            instructions = `${instructions}\n\n${runPrompt}`
            const bridgeInput: AgentBridgeMessage = isContentBlockArray(input)
                ? await convertContentBlocksForAgent(input)
                : input
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            const flushedAssistantParts = new Set<string>()
            let lastChunk: AgentBridgeOutput | null = null
            const roomWorkspace = String(this.storage?.getRoom?.(roomId)?.workspace || '').trim()
            const started = await bridge.chat(
                sessionId,
                bridgeInput,
                conversationHistory,
                instructions,
                this.profile,
                {
                    ...(modelContext.model ? { model: modelContext.model } : {}),
                    ...(modelContext.provider ? { provider: modelContext.provider } : {}),
                    ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
                    source: 'api_server',
                    ...(roomWorkspace ? { workspace: roomWorkspace } : {}),
                    // Used only if this operation creates the cached AgentSession.
                    background_delegation_enabled: this.backgroundDelegationEnabled,
                },
            )
            bridgeStarted = true
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            if (roomWorkspace) {
                workspaceRunState = this.beginWorkspaceDiffIfNeeded({
                    roomId,
                    sessionId,
                    runId: started.run_id,
                    responseRunId: runMessageId,
                    workspace: roomWorkspace,
                })
            }

            this.emitMessageStreamStart(roomId, streamMessageId, sessionId, runMessageId)
            streamStarted = true
            for await (const chunk of bridge.streamOutput(started.run_id, { timeoutMs: 120000 })) {
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                lastChunk = chunk
                reasoningContent = await this.recordBridgeEvents(
                    roomId,
                    sessionId,
                    replyInterruptVersion,
                    instructions,
                    modelContext,
                    chunk,
                    runMessageId,
                    reasoningContent,
                    () => streamMessageId,
                    async (toolReasoning) => {
                        const toolBaseId = streamMessageId
                        if (currentContent.trim()) {
                            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                                await stopStaleStartedRun?.()
                                currentContent = ''
                                return toolBaseId
                            }
                            await this.sendMessage(roomId, currentContent, streamMessageId, {
                                role: 'assistant',
                                run_id: runMessageId,
                                mentionDepth: nextMentionDepth(msg),
                                reasoning: toolReasoning || null,
                                reasoning_content: toolReasoning || null,
                            }, sessionId)
                            flushedAssistantParts.add(streamMessageId)
                            currentContent = ''
                        }
                        this.emitMessageStreamEnd(roomId, toolBaseId, sessionId)
                        partIndex += 1
                        streamMessageId = groupMessagePartId(runMessageId, partIndex)
                        this.emitMessageStreamStart(roomId, streamMessageId, sessionId, runMessageId)
                        streamStarted = true
                        return toolBaseId
                    },
                )
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                if (chunk.delta) {
                    currentContent += chunk.delta
                    totalContent += chunk.delta
                    this.emitMessageStreamDelta(roomId, streamMessageId, chunk.delta, sessionId)
                }
            }

            if (lastChunk?.status === 'error') {
                logger.error(`[AgentClients] ${this.name}: bridge response failed: ${lastChunk.error || 'unknown error'}`)
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                await this.sendAgentErrorMessage(roomId, streamMessageId, lastChunk.error || 'Run failed', msg, reasoningContent, sessionId, runMessageId)
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'failed', streamStarted ? streamMessageId : null)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                this.stopTyping(roomId)
                reportStatus('ready')
                return
            }

            if (!totalContent) {
                currentContent = extractBridgeFinalText(lastChunk)
                totalContent = currentContent
            }
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            logger.debug(`[AgentClients] ${this.name}: bridge response completed, content length=${totalContent.length}`)
            if (currentContent) {
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await stopStaleStartedRun?.()
                    return
                }
                this.stopTyping(roomId)
                await this.sendMessage(roomId, currentContent, streamMessageId, {
                    role: 'assistant',
                    run_id: runMessageId,
                    mentionDepth: nextMentionDepth(msg),
                    reasoning: reasoningContent || null,
                    reasoning_content: reasoningContent || null,
                }, sessionId)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', streamMessageId)
                reportStatus('ready')
                return
            }
            logger.warn(`[AgentClients] ${this.name}: bridge response completed without content`)
            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
            await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', streamStarted ? streamMessageId : null)
            this.stopTyping(roomId)
            reportStatus('ready')
        } catch (err: any) {
            logger.error(`[AgentClients] ${this.name}: error handling message: ${err.message}`)
            if (activeSessionId && !this.replySessionIsCurrent(roomId, activeSessionId, activeReplyInterruptVersion)) {
                await stopStaleStartedRun?.()
                return
            }
            if (workspaceRunState && !bridgeStarted) {
                await stopStaleStartedRun?.('Interrupted after group chat bridge launch failed')
            } else {
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'failed', streamStarted ? streamMessageId : null)
            }
            try {
                await this.sendAgentErrorMessage(roomId, streamMessageId, err, msg, reasoningContent, activeSessionId || undefined, runMessageId)
                if (streamStarted) this.emitMessageStreamEnd(roomId, streamMessageId, activeSessionId || undefined)
            } catch (sendErr: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to send error message: ${sendErr.message}`)
            }
            this.stopTyping(roomId)
            if (activeSessionId) {
                onStatus?.('ready', { agentSessionId: activeSessionId })
            } else {
                onStatus?.('ready')
            }
        } finally {
            if (activeSessionId) {
                if (this.activeSessions.get(roomId) === activeSessionId) this.activeSessions.delete(roomId)
                await new AgentBridgeClient().destroy(activeSessionId, this.profile).catch((err: any) => {
                    if (!isUnknownBridgeSessionError(err)) {
                        logger.warn(`[AgentClients] ${this.name}: failed to destroy temporary bridge session: ${err.message || err}`)
                    }
                })
            }
        }
    }

    private async sendAgentErrorMessage(
        roomId: string,
        messageId: string,
        error: unknown,
        sourceMsg: MentionMessage,
        reasoningContent = '',
        sessionId?: string,
        responseRunId?: string,
    ): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error || 'Run failed')
        const content = detail.startsWith('Error:') ? detail : `Error: ${detail}`
        await this.sendMessage(roomId, content, messageId, {
            role: 'assistant',
            ...(responseRunId ? { run_id: responseRunId } : {}),
            mentionDepth: nextMentionDepth(sourceMsg),
            finish_reason: 'error',
            reasoning: reasoningContent || null,
            reasoning_content: reasoningContent || null,
        }, sessionId)
    }

    private async recordBridgeEvents(
        roomId: string,
        sessionId: string,
        interruptVersion: number,
        instructions: string | undefined,
        modelContext: GroupModelContext,
        chunk: AgentBridgeOutput,
        responseRunId: string,
        initialReasoning: string,
        getCurrentMessageId: () => string,
        beforeToolStarted: (reasoning: string) => Promise<string>,
    ): Promise<string> {
        let reasoning = initialReasoning
        for (const ev of chunk.events || []) {
            if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
            const eventType = String((ev as any)?.event || '')
            if (eventType === 'bridge.context.ready') {
                this.cacheBridgeContext(sessionId, ev as Record<string, unknown>, instructions, modelContext)
            } else if (eventType === 'tool.started') {
                const toolReasoning = reasoning
                const toolBaseId = await beforeToolStarted(toolReasoning)
                if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
                await this.recordToolStarted(roomId, sessionId, ev as Record<string, unknown>, toolBaseId, responseRunId, toolReasoning)
                reasoning = ''
            } else if (eventType === 'tool.completed') {
                if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
                await this.recordToolCompleted(roomId, sessionId, ev as Record<string, unknown>)
            } else if (eventType === 'approval.requested') {
                this.emitApprovalRequested(roomId, {
                    event: 'approval.requested',
                    agentSessionId: sessionId,
                    approval_id: (ev as any).approval_id,
                    command: (ev as any).command,
                    description: (ev as any).description,
                    choices: Array.isArray((ev as any).choices) ? (ev as any).choices : undefined,
                    allow_permanent: (ev as any).allow_permanent,
                })
            } else if (eventType === 'approval.resolved') {
                this.emitApprovalResolved(roomId, {
                    event: 'approval.resolved',
                    agentSessionId: sessionId,
                    approval_id: (ev as any).approval_id,
                    choice: (ev as any).choice,
                })
            } else {
                const text = groupBridgeReasoningDeltaFromEvent(ev as Record<string, unknown>)
                if (text) {
                    reasoning += text
                    this.emitMessageReasoningDelta(roomId, getCurrentMessageId(), text, sessionId)
                }
            }
        }
        return reasoning
    }

    private recordToolStarted(
        roomId: string,
        sessionId: string,
        ev: Record<string, unknown>,
        runMessageId: string,
        responseRunId: string,
        reasoning = '',
    ): Promise<void> {
        const toolName = String(ev.tool_name || ev.tool || ev.name || '')
        const rawToolCallId = String(ev.tool_call_id || '').trim()
        const toolCallId = groupToolCallId(rawToolCallId, toolName, this.nextToolIndex(roomId, toolName))
        if (!rawToolCallId || !this.pendingToolBaseIds.has(toolCallId)) {
            this.trackPendingToolCall(roomId, toolName, toolCallId)
        }
        this.pendingToolBaseIds.set(toolCallId, runMessageId)
        this.pendingToolRunIds.set(toolCallId, responseRunId)
        this.pendingToolNames.set(toolCallId, toolName)
        const timestamp = Date.now()
        const rawArgs = ev.args ?? ev.arguments ?? ev.input ?? {}
        const args = normalizeToolArgs(rawArgs)
        const toolCall = {
            id: toolCallId,
            type: 'function',
            function: {
                name: toolName,
                arguments: JSON.stringify(args),
            },
        }
        const msg: MessageData & Record<string, any> = {
            id: `${runMessageId}_toolcall_${safeId(toolCallId)}`,
            roomId,
            senderId: this.id || this.agentId,
            senderName: this.name,
            content: '',
            timestamp,
            run_id: responseRunId,
            role: 'assistant',
            tool_calls: [toolCall],
            finish_reason: 'tool_calls',
            reasoning: reasoning || null,
            reasoning_content: reasoning || null,
        }
        return this.sendMessage(roomId, '', msg.id, {
            role: 'assistant',
            run_id: responseRunId,
            tool_calls: msg.tool_calls,
            finish_reason: 'tool_calls',
            reasoning: reasoning || null,
            reasoning_content: reasoning || null,
            timestamp,
        }, sessionId)
            .then(() => undefined)
            .catch((err: any) => logger.warn(`[AgentClients] failed to record tool call: ${err.message || err}`))
    }

    private recordToolCompleted(roomId: string, sessionId: string, ev: Record<string, unknown>): Promise<void> {
        const rawId = String(ev.tool_call_id || '').trim()
        const toolName = String(ev.tool_name || ev.tool || ev.name || this.pendingToolNames.get(rawId) || '')
        if (rawId) this.removePendingToolCall(roomId, toolName, rawId)
        const toolCallId = rawId || this.takePendingToolCall(roomId, toolName) || groupToolCallId(null, toolName, this.nextToolIndex(roomId, toolName))
        const runMessageId = this.pendingToolBaseIds.get(toolCallId) || groupMessagePartId(groupMessageId(roomId, this.profile, this.name), 0)
        const responseRunId = this.pendingToolRunIds.get(toolCallId) || inferResponseRunId(runMessageId)
        this.pendingToolBaseIds.delete(toolCallId)
        this.pendingToolRunIds.delete(toolCallId)
        this.pendingToolNames.delete(toolCallId)
        const output = bridgeToolOutput(ev)
        const failed = ev.event === 'tool.failed'
            || ev.is_error === true
            || ev.error === true
            || (typeof ev.error === 'string' && ev.error.trim().length > 0)
        const timestamp = Date.now()
        const msg: MessageData & Record<string, any> = {
            id: `${runMessageId}_toolresult_${safeId(toolCallId)}_${Date.now()}`,
            roomId,
            senderId: this.id || this.agentId,
            senderName: this.name,
            content: output,
            timestamp,
            run_id: responseRunId,
            role: 'tool',
            tool_call_id: toolCallId,
            tool_name: toolName || null,
            finish_reason: failed ? 'error' : null,
        }
        return this.sendMessage(roomId, output, msg.id, {
            role: 'tool',
            run_id: responseRunId,
            tool_call_id: toolCallId,
            tool_name: toolName || null,
            finish_reason: failed ? 'error' : null,
            timestamp,
        }, sessionId)
            .then(() => undefined)
            .catch((err: any) => logger.warn(`[AgentClients] failed to record tool result: ${err.message || err}`))
    }

    private async completePendingToolsForRun(roomId: string, sessionId: string, responseRunId: string): Promise<void> {
        const pendingToolCallIds = Array.from(this.pendingToolRunIds.entries())
            .filter(([, pendingRunId]) => pendingRunId === responseRunId)
            .map(([toolCallId]) => toolCallId)
        for (const toolCallId of pendingToolCallIds) {
            await this.recordToolCompleted(roomId, sessionId, {
                tool_call_id: toolCallId,
                tool_name: this.pendingToolNames.get(toolCallId) || '',
                output: '',
            })
        }
    }

    private pendingToolKey(roomId: string, toolName: string): string {
        return `${roomId}::${toolName || 'tool'}`
    }

    private trackPendingToolCall(roomId: string, toolName: string, toolCallId: string): void {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key) || []
        list.push(toolCallId)
        this.pendingToolCallIds.set(key, list)
    }

    private takePendingToolCall(roomId: string, toolName: string): string | undefined {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key)
        if (!list?.length) return undefined
        const id = list.shift()
        if (list.length) this.pendingToolCallIds.set(key, list)
        else this.pendingToolCallIds.delete(key)
        return id
    }

    private removePendingToolCall(roomId: string, toolName: string, toolCallId: string): void {
        const key = this.pendingToolKey(roomId, toolName)
        const list = this.pendingToolCallIds.get(key)
        if (!list?.length) return
        const next = list.filter(id => id !== toolCallId)
        if (next.length) this.pendingToolCallIds.set(key, next)
        else this.pendingToolCallIds.delete(key)
    }

    private nextToolIndex(roomId: string, toolName: string): number {
        const key = this.pendingToolKey(roomId, toolName)
        return (this.pendingToolCallIds.get(key)?.length || 0) + 1
    }

    private bindEvents(): void {
        const s = this.socket!

        s.on('typing', (data: any) => {
            this.handlers.onTyping?.(data)
        })

        s.on('stop_typing', (data: any) => {
            this.handlers.onStopTyping?.(data)
        })

        s.on('member_joined', (data: any) => {
            this.handlers.onMemberJoined?.(data)
        })

        s.on('member_left', (data: any) => {
            this.handlers.onMemberLeft?.(data)
        })

        // Auto rejoin rooms on reconnect
        s.io.on('reconnect', async () => {
            if (this._reconnecting) return
            this._reconnecting = true
            logger.info(`[AgentClients] ${this.name} reconnecting, rejoining ${this.joinedRooms.size} rooms...`)
            const rooms = Array.from(this.joinedRooms)
            for (const roomId of rooms) {
                try {
                    await this.joinRoom(roomId)
                } catch (err: any) {
                    logger.error(`[AgentClients] ${this.name} failed to rejoin room ${roomId}: ${err.message}`)
                }
            }
            this._reconnecting = false
        })
    }
}

export function groupBridgeSessionId(
    roomId: string,
    profile: string,
    name: string,
    sessionSeed: string,
    runtimeConfig: GroupAgentSessionConfig = {},
): string {
    const agent = String(runtimeConfig.agent || 'hermes').trim()
    const provider = String(runtimeConfig.provider || '').trim()
    const model = String(runtimeConfig.model || '').trim()
    const apiMode = agent === 'hermes' ? '' : String(runtimeConfig.apiMode || '').trim()
    const reasoningEffort = String(runtimeConfig.reasoningEffort || '').trim()
    const runtimeKey = agent !== 'hermes' || provider || model || apiMode || reasoningEffort
        ? `_${agent}_${provider}_${model}_${apiMode}_${reasoningEffort}`
        : ''
    const rawKey = `gc_${roomId}_${profile}_${name}_${sessionSeed || '0'}${runtimeKey}`
    const safePrefix = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const keyHash = createHash('sha256').update(rawKey).digest('hex').slice(0, 16)
    const suffix = `_h_${keyHash}`
    return `${safePrefix.slice(0, Math.max(0, 120 - suffix.length))}${suffix}`
}

export function groupRuntimeSessionId(roomId: string, profile: string, name: string): string {
    const prefix = `gc_run_${safeId(roomId)}_${safeId(profile)}_${safeId(name)}`.slice(0, 96)
    return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

function groupMessageId(roomId: string, profile: string, name: string): string {
    const raw = `gcmsg_${safeId(roomId)}_${safeId(profile)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
}

function groupMessagePartId(runMessageId: string, partIndex: number): string {
    return `${safeId(runMessageId)}_part_${partIndex}`
}

function inferResponseRunId(messageId: string): string {
    const match = String(messageId || '').match(/^(.+)_part_\d+(?:_tool(?:call|result)_.+)?$/)
    return match?.[1] || String(messageId || '')
}

function groupToolCallId(rawToolCallId: unknown, toolName: string, index: number): string {
    const raw = String(rawToolCallId || '').trim()
    if (raw) return raw
    return `cli_${safeId(toolName || 'tool')}_${Date.now()}_${index}`
}

function safeId(value: string): string {
    return String(value || 'item').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

function bridgeToolOutput(ev: Record<string, unknown>): string {
    const value = ev.result ?? ev.output ?? ev.result_preview ?? ev.preview ?? ev.error ?? ''
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function normalizeToolArgs(value: unknown): Record<string, unknown> {
    if (!value) return {}
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value)
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value }
        } catch {
            return { value }
        }
    }
    return typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : { value }
}

function extractBridgeFinalText(chunk: AgentBridgeOutput | null): string {
    const result = chunk?.result as any
    const output = result?.final_response || chunk?.output || ''
    return typeof output === 'string' ? output.trim() : ''
}

// ─── AgentClients (roomId -> agents) ──────────────────────────

export class AgentClients {
    private rooms = new Map<string, Map<string, GroupAgentExecutor>>()
    private _storage: any = null
    private _workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null
    private _chatRunService: GroupChatRunService | null = null
    private _roomSummaryService: GroupRoomSummaryService | null = null
    private _activityBroadcaster: AgentActivityBroadcaster | null = null

    // Per-room processing lock + mention queue
    private _processingRooms = new Set<string>()
    private _mentionQueue = new Map<string, Array<{ agents: GroupAgentExecutor[]; msg: MentionMessage }>>()
    private _pausedRooms = new Set<string>()
    private _scheduledAgentCounts = new Map<string, Map<string, number>>()

    /**
     * Create an agent client and connect it to the server.
     * The agent will NOT auto-join any room — call addAgentToRoom separately.
     */
    async createAgent(config: AgentConfig, handlers?: AgentEventHandler, port?: number): Promise<AgentClient> {
        const client = new AgentClient(config, handlers)
        await client.connect(port)

        // Auto-apply stored references (fixes propagation for agents created after set*)
        if (this._storage) client.setStorage(this._storage)
        client.setWorkspaceDiffBroadcaster(this._workspaceDiffBroadcaster)
        client.setChatRunService(this._chatRunService)

        logger.info(`[AgentClients] Connected: ${client.name} (${client.agentId})`)
        return client
    }

    /**
     * Connect an agent to a room.
     */
    async addAgentToRoom(roomId: string, client: AgentClient): Promise<JoinResult> {
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new Map()
            this.rooms.set(roomId, room)
        }

        room.set(client.agentId, client)
        try {
            const result = await client.joinRoom(roomId)
            logger.info(`[AgentClients] ${client.name} joined room: ${roomId}`)
            return result
        } catch (err) {
            room.delete(client.agentId)
            if (room.size === 0) this.rooms.delete(roomId)
            client.disconnect()
            throw err
        }
    }

    /**
     * Register an executor whose transport has already joined the room.
     * Used by authenticated outbound relay connections.
     */
    registerAgentForRoom(roomId: string, executor: GroupAgentExecutor): void {
        let room = this.rooms.get(roomId)
        if (!room) {
            room = new Map()
            this.rooms.set(roomId, room)
        }
        executor.setStorage?.(this._storage)
        executor.setWorkspaceDiffBroadcaster?.(this._workspaceDiffBroadcaster)
        executor.setChatRunService?.(this._chatRunService)
        room.set(executor.agentId, executor)
        logger.info(`[AgentClients] Registered relay executor: ${executor.name} (${executor.agentId})`)
    }

    /**
     * Remove an agent from a room and disconnect it.
     */
    removeAgentFromRoom(roomId: string, agentId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        const client = room.get(agentId)
        if (client) {
            client.disconnect()
            room.delete(agentId)
            logger.info(`[AgentClients] ${client.name} left room: ${roomId}`)

        }

        if (room.size === 0) {
            this.rooms.delete(roomId)
        }
    }

    /**
     * Get all agents in a room.
     */
    getAgents(roomId: string): GroupAgentExecutor[] {
        const room = this.rooms.get(roomId)
        return room ? Array.from(room.values()) : []
    }

    getConnectedAgents(roomId: string): GroupAgentExecutor[] {
        return this.getAgents(roomId).filter(agent => agent.connected !== false)
    }

    /**
     * Get a specific agent in a room.
     */
    getAgent(roomId: string, agentId: string): GroupAgentExecutor | undefined {
        return this.rooms.get(roomId)?.get(agentId)
    }

    activeSessionIds(roomId: string): string[] {
        return this.getAgents(roomId)
            .map(agent => agent.getActiveSessionId(roomId))
            .filter((sessionId): sessionId is string => Boolean(sessionId))
    }

    agentSessionIsCurrent(roomId: string, agentId: string, sessionId: string): boolean {
        return this.getAgent(roomId, agentId)?.isActiveSession(roomId, sessionId) === true
    }

    /**
     * Get all room IDs that have agents.
     */
    getRoomIds(): string[] {
        return Array.from(this.rooms.keys())
    }

    /**
     * Send a message from a specific agent in a room.
     */
    async sendMessage(roomId: string, agentId: string, content: string): Promise<string> {
        const client = this.getAgent(roomId, agentId)
        if (!client) {
            throw new Error(`Agent "${agentId}" not found in room "${roomId}"`)
        }
        return client.sendMessage(roomId, content)
    }

    /**
     * Broadcast a message from all agents in a room.
     */
    async broadcastFromRoom(roomId: string, content: string): Promise<string[]> {
        const agents = this.getAgents(roomId)
        return Promise.all(agents.map((agent) => agent.sendMessage(roomId, content)))
    }

    private buildUnsyncedInterruptError(roomId: string): Error {
        const err = new Error(`Room "${roomId}" still has running bridge sessions; try again after the interrupt completes`) as Error & { status?: number }
        err.status = 409
        return err
    }

    private reportAgentActivity(
        roomId: string,
        agentName: string,
        status: 'compressing' | 'replying' | 'ready',
    ): void {
        this._activityBroadcaster?.(roomId, agentName, status)
        logger.debug(`[AgentClients] room ${roomId} agent ${agentName} status: ${status}`)
    }

    private scheduleAgentActivity(roomId: string, agentName: string): void {
        let roomCounts = this._scheduledAgentCounts.get(roomId)
        if (!roomCounts) {
            roomCounts = new Map()
            this._scheduledAgentCounts.set(roomId, roomCounts)
        }
        const count = roomCounts.get(agentName) || 0
        roomCounts.set(agentName, count + 1)
        if (count === 0) this.reportAgentActivity(roomId, agentName, 'replying')
    }

    private finishAgentActivity(roomId: string, agentName: string): void {
        const roomCounts = this._scheduledAgentCounts.get(roomId)
        const count = roomCounts?.get(agentName) || 0
        if (count > 1) {
            roomCounts!.set(agentName, count - 1)
            return
        }
        roomCounts?.delete(agentName)
        if (roomCounts?.size === 0) this._scheduledAgentCounts.delete(roomId)
        if (count > 0) this.reportAgentActivity(roomId, agentName, 'ready')
    }

    private clearScheduledAgentActivity(roomId: string, agentName: string): void {
        const roomCounts = this._scheduledAgentCounts.get(roomId)
        const hadScheduledWork = (roomCounts?.get(agentName) || 0) > 0
        roomCounts?.delete(agentName)
        if (roomCounts?.size === 0) this._scheduledAgentCounts.delete(roomId)
        const queue = this._mentionQueue.get(roomId)
        if (queue) {
            for (const entry of queue) {
                entry.agents = entry.agents.filter(agent => agent.name !== agentName)
            }
        }
        if (hadScheduledWork) this.reportAgentActivity(roomId, agentName, 'ready')
    }

    private clearMentionQueuesForRoom(roomId: string): void {
        this._mentionQueue.delete(roomId)
        const roomCounts = this._scheduledAgentCounts.get(roomId)
        this._scheduledAgentCounts.delete(roomId)
        for (const agentName of roomCounts?.keys() || []) {
            this.reportAgentActivity(roomId, agentName, 'ready')
        }
    }

    private queueMention(roomId: string, agents: GroupAgentExecutor[], msg: MentionMessage): void {
        let queue = this._mentionQueue.get(roomId)
        if (!queue) {
            queue = []
            this._mentionQueue.set(roomId, queue)
        }
        queue.push({ agents, msg })
        for (const agent of agents) this.scheduleAgentActivity(roomId, agent.name)
    }

    async interruptAgent(roomId: string, agentName: string): Promise<void> {
        const agent = this.getAgents(roomId).find(a => a.name === agentName)
        if (!agent) throw new Error(`Agent "${agentName}" not found in room "${roomId}"`)
        const synced = await agent.interrupt(roomId)
        if (!synced) throw this.buildUnsyncedInterruptError(roomId)
        this.clearScheduledAgentActivity(roomId, agentName)
    }

    async interruptRoom(roomId: string): Promise<void> {
        const agents = this.getAgents(roomId)
        this._pausedRooms.add(roomId)
        const results = await Promise.allSettled(agents.map(agent => agent.interrupt(roomId)))
        let unsynced = false
        for (const result of results) {
            if (result.status === 'rejected') {
                unsynced = true
                logger.warn(`[AgentClients] failed to interrupt room ${roomId}: ${result.reason?.message || result.reason}`)
            } else if (result.value === false) {
                unsynced = true
                logger.warn(`[AgentClients] bridge interrupt for room ${roomId} was not synchronized`)
            }
        }
        this._pausedRooms.delete(roomId)
        if (unsynced) {
            throw this.buildUnsyncedInterruptError(roomId)
        }
        this.clearMentionQueuesForRoom(roomId)
    }

    /**
     * Disconnect all agents in a room.
     */
    disconnectRoom(roomId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        room.forEach((client) => client.disconnect())
        this.rooms.delete(roomId)
        this.clearMentionQueuesForRoom(roomId)
        this._pausedRooms.delete(roomId)
        logger.info(`[AgentClients] All agents disconnected from room: ${roomId}`)

    }

    resetRoomContext(roomId: string): void {
        this.clearMentionQueuesForRoom(roomId)
        this._pausedRooms.delete(roomId)
        this._processingRooms.delete(roomId)
    }

    /**
     * Disconnect all agents in all rooms.
     */
    disconnectAll(): void {
        this.rooms.forEach((room) => {
            room.forEach((client) => client.disconnect())
        })
        this.rooms.clear()
        logger.info('[AgentClients] All agents disconnected')
    }

    /**
     * Set message storage for all existing and future agents.
     */
    setStorage(storage: any): void {
        this._storage = storage
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setStorage(storage))
        })
    }

    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void {
        this._workspaceDiffBroadcaster = broadcaster
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setWorkspaceDiffBroadcaster(broadcaster))
        })
    }

    setChatRunService(service: GroupChatRunService | null): void {
        this._chatRunService = service
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setChatRunService(service))
        })
    }

    setRoomSummaryService(service: GroupRoomSummaryService | null): void {
        this._roomSummaryService = service
    }

    setActivityBroadcaster(broadcaster: AgentActivityBroadcaster | null): void {
        this._activityBroadcaster = broadcaster
    }


    /**
     * Server-side: parse @mentions and forward to matching agents directly.
     * If the room is already processing (compressing/replying), queue the mention.
     */
    async processMentions(roomId: string, msg: MentionMessage): Promise<void> {
        const agents = this.getConnectedAgents(roomId)
        const mentioned = resolveMentionTargets(agents, msg.content, msg.senderId)
        if (mentioned.length === 0 && msg.role !== 'user') return

        if (mentioned.length > 0) {
            logger.debug(`[AgentClients] ${mentioned.map(a => a.name).join(', ')} mentioned by ${msg.senderName}`)
        }

        this.queueMention(roomId, mentioned, msg)
        if (!this._processingRooms.has(roomId) && !this._pausedRooms.has(roomId)) {
            await this._drainRoomQueue(roomId)
        }
    }

    async processSummaryCheck(roomId: string, messageId: string): Promise<void> {
        this.queueMention(roomId, [], {
            messageId,
            content: '',
            senderName: '',
            senderId: '',
            timestamp: Date.now(),
            role: 'user',
        })
        if (!this._processingRooms.has(roomId) && !this._pausedRooms.has(roomId)) {
            await this._drainRoomQueue(roomId)
        }
    }

    private async _drainRoomQueue(roomId: string): Promise<void> {
        if (this._processingRooms.has(roomId) || this._pausedRooms.has(roomId)) return
        this._processingRooms.add(roomId)
        try {
            while (!this._pausedRooms.has(roomId)) {
                const queue = this._mentionQueue.get(roomId)
                const next = queue?.shift()
                if (!next) break
                if (queue?.length === 0) this._mentionQueue.delete(roomId)

                const runtimeContext = this._roomSummaryService
                    ? await this._roomSummaryService.prepareForMessage(roomId, next.msg.messageId)
                    : { summary: '', history: [] }
                const results = await Promise.allSettled(next.agents.map(async (agent) => {
                    const onStatus = (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => {
                        if (status !== 'ready') this.reportAgentActivity(roomId, agent.name, status)
                    }
                    try {
                        await agent.replyToMention(roomId, next.msg, runtimeContext, onStatus)
                    } finally {
                        this.finishAgentActivity(roomId, agent.name)
                    }
                }))
                for (let index = 0; index < results.length; index += 1) {
                    const result = results[index]
                    if (result.status === 'rejected') {
                        logger.error(`[AgentClients] error processing mention for ${next.agents[index]?.name}: ${result.reason?.message || result.reason}`)
                    }
                }
            }
        } finally {
            this._processingRooms.delete(roomId)
        }
    }
}

function nextMentionDepth(msg: MentionMessage): number {
    return Math.max(0, msg.mentionDepth || 0) + 1
}
