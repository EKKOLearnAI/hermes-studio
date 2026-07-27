import { io, Socket } from 'socket.io-client'
import { createHash, randomBytes } from 'crypto'
import { getToken } from '../../../services/auth'
import { logger } from '../../../services/logger'
import { countTokens } from '../../../lib/context-compressor'
import { AgentBridgeClient, type AgentBridgeContextEstimate, type AgentBridgeMessage, type AgentBridgeOutput } from '../agent-bridge'
import { convertContentBlocksForAgent, isContentBlockArray } from '../run-chat/content-blocks'
import { resolveBridgeRunModelConfig } from '../run-chat/model-config'
import { getSystemPrompt } from '../../../lib/llm-prompt'
import { getModelContextLength } from '../model-context'
import {
    sendCodingAgentRunInput,
    startCodingAgentRun,
} from '../../coding-agents'
import { codingAgentRunManager } from '../../agent-runner/coding-agent-run-manager'
import {
    completeWorkspaceRunCheckpointDraft,
    discardWorkspaceRunCheckpoint,
    startWorkspaceRunCheckpoint,
} from '../run-chat/workspace-diff-tracker'
import type { ContentBlock } from '../run-chat/types'
import type { StoredMessage } from '../context-engine/types'
import { buildProjectedGroupChatHistory, isWorkspaceDiffToolMessage, projectGroupChatMessage } from './context-projection'
import { sliceGroupMessagesForSnapshotTail } from './group-message-ordering'
import {
    isAllAgentsMentioned,
    resolveMentionTargets,
    stripMentionRoutingTokens,
} from './mention-routing'

export const GROUP_CHAT_AGENT_SOCKET_SECRET = randomBytes(32).toString('hex')

// ─── Types ────────────────────────────────────────────────────

interface AgentConfig {
    agentId?: string
    profile: string
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
}

type MentionMessage = {
    messageId?: string
    content: string
    senderName: string
    senderId: string
    timestamp: number
    role?: string
    input?: string | ContentBlock[]
    mentionDepth?: number
    handoffJobId?: string
    handoffLeaseToken?: string
    handoffChainId?: string
    handoffKind?: 'mention' | 'fixed' | 'fanout'
    targetSessionId?: string
}

export function participantContextRevision(
    participantCursor: number,
    triggerRoomSeq: number,
    messages: Array<{ roomSeq?: number }>,
): number {
    return Math.max(
        Math.max(0, Math.floor(Number(participantCursor || 0))),
        Math.max(0, Math.floor(Number(triggerRoomSeq || 0))),
        ...messages.map(message => Math.max(0, Math.floor(Number(message.roomSeq || 0)))),
    )
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
export type GroupCompressionInput = {
    triggerTokens: number
    maxHistoryTokens: number
    tailMessageCount: number
}

type WorkspaceDiffTerminalStatus = 'completed' | 'failed' | 'aborted'
type WorkspaceDiffBroadcaster = (roomId: string, message: MessageData & Record<string, unknown>, totalTokens: number) => void

function isUnknownBridgeSessionError(err: unknown): boolean {
    const message = String((err as any)?.message || err || '').toLowerCase()
    return message.includes('unknown session') || message.includes('session not found')
}

interface WorkspaceDiffRunState {
    roomId: string
    sessionId: string
    runId: string
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

type PersistedParticipantBinding = {
    agentId: string
    profile: string
    name: string
    description: string
    runtime?: 'hermes' | 'coding_agent'
    codingAgentId?: '' | 'claude-code' | 'codex'
    sessionId?: string
    sessionGeneration?: number
    mode?: 'scoped' | 'global'
    provider?: string
    model?: string
    apiMode?: string
    reasoningEffort?: string
    lastSeenRoomSeq?: number
    lastSuccessfulRunId?: string
    checkpoint?: string
    checkpointSourceMessageIds?: string
    checkpointFromRoomSeq?: number
    checkpointThroughRoomSeq?: number
}

const GROUP_CODING_AGENT_RUN_TIMEOUT_MS = 30 * 60 * 1000
const GROUP_CODING_AGENT_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000

export async function resolveGroupAgentModelContext(profile: string): Promise<GroupModelContext> {
    return resolveBridgeRunModelConfig({ profile })
}

const GROUP_CONTEXT_TRIGGER_RATIO = 0.6
const GROUP_CONTEXT_TARGET_RATIO = 0.5
const GROUP_SINGLE_MESSAGE_RATIO = 0.25

export function effectiveGroupCompressionConfig(
    roomConfig: GroupCompressionInput,
    modelContextLength: number,
): GroupCompressionInput {
    const modelWindow = Math.max(1, Math.floor(Number(modelContextLength) || 0))
    const modelTrigger = Math.max(1, Math.floor(modelWindow * GROUP_CONTEXT_TRIGGER_RATIO))
    const triggerTokens = Math.max(1, Math.min(Math.floor(roomConfig.triggerTokens), modelTrigger))
    const targetTokens = Math.max(1, Math.floor(triggerTokens * GROUP_CONTEXT_TARGET_RATIO))
    return {
        triggerTokens,
        maxHistoryTokens: Math.max(1, Math.min(Math.floor(roomConfig.maxHistoryTokens), targetTokens)),
        tailMessageCount: Math.max(1, Math.floor(roomConfig.tailMessageCount)),
    }
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

interface MemberData {
    id: string
    name: string
    joinedAt: number
}

interface JoinResult {
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

// ─── Agent Client (single connection) ─────────────────────────

class AgentClient {
    readonly agentId: string
    readonly profile: string
    private _name: string
    private _description: string
    private readonly backgroundDelegationEnabled: false
    private socket: Socket | null = null
    private joinedRooms = new Set<string>()
    private handlers: AgentEventHandler
    private _reconnecting = false
    private contextEngine: any = null
    private storage: any = null
    private pendingToolCallIds = new Map<string, string[]>()
    private pendingToolBaseIds = new Map<string, string>()
    private bridgeContextCache = new Map<string, BridgeContextCache>()
    private workspaceDiffRuns = new Map<string, WorkspaceDiffRunState>()
    private interruptVersions = new Map<string, number>()
    private codingAgentReplyCancels = new Map<string, () => void>()
    private workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null

    constructor(config: AgentConfig, handlers: AgentEventHandler = {}) {
        this.agentId = config.agentId || Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.profile = config.profile
        this._name = config.name
        this._description = config.description
        this.backgroundDelegationEnabled = config.backgroundDelegationEnabled ?? false
        this.handlers = handlers
    }

    get connected(): boolean {
        return this.socket?.connected ?? false
    }

    get id(): string | undefined {
        return this.socket?.id
    }

    get name(): string {
        return this._name
    }

    get description(): string {
        return this._description
    }

    modelContextLengthForRoom(roomId: string): number {
        const binding = this.storage?.getRoomAgentByAgentId?.(roomId, this.agentId)
        return getModelContextLength({
            profile: this.profile,
            model: String(binding?.model || '').trim(),
            provider: String(binding?.provider || '').trim(),
        })
    }

    updateIdentity(name: string, description: string): void {
        this._name = name
        this._description = description
    }

    setContextEngine(engine: any): void {
        this.contextEngine = engine
    }

    setStorage(storage: any): void {
        this.storage = storage
    }

    setWorkspaceDiffBroadcaster(broadcaster: WorkspaceDiffBroadcaster | null): void {
        this.workspaceDiffBroadcaster = broadcaster
    }

    async connect(port?: number): Promise<void> {
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
        this.socket!.emit('typing', { roomId })
    }

    stopTyping(roomId: string): void {
        this.ensureConnected()
        this.socket!.emit('stop_typing', { roomId })
    }

    emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>, agentSessionId?: string): void {
        this.ensureConnected()
        this.socket!.emit('context_status', { roomId, agentName: this.name, status, ...extra, ...(agentSessionId ? { agentSessionId } : {}) })
    }

    emitApprovalRequested(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        this.socket!.emit('approval.requested', { roomId, agentName: this.name, ...payload })
    }

    emitApprovalResolved(roomId: string, payload: Record<string, unknown>): void {
        this.ensureConnected()
        this.socket!.emit('approval.resolved', { roomId, agentName: this.name, ...payload })
    }

    async interrupt(roomId: string): Promise<boolean> {
        const binding = this.participantBinding(roomId)
        const sessionId = this.currentSessionId(roomId)
        if (binding?.runtime === 'coding_agent') {
            this.markSessionInterrupted(sessionId)
            const runId = codingAgentRunManager.runIdForSession(sessionId) || 'interrupted'
            const workspaceRunChange = codingAgentRunManager.completeWorkspaceDiffForSession(sessionId)
            const stopped = await codingAgentRunManager.stopAndWait(sessionId, { reportClosed: false, graceMs: 15_000 })
            if (!stopped && codingAgentRunManager.runIdForSession(sessionId)) return false
            this.codingAgentReplyCancels.get(sessionId)?.()
            await this.persistCodingAgentWorkspaceDiff(roomId, sessionId, {
                run_id: runId,
                workspace_run_change: workspaceRunChange,
            }, 'aborted', null, String(this.storage?.getRoom?.(roomId)?.workspace || '').trim())
            try {
                this.stopTyping(roomId)
                this.emitContextStatus(roomId, 'ready', undefined, sessionId)
            } catch (err: any) {
                logger.warn(`[AgentClients] ${this.name}: failed to publish coding-agent interrupt state: ${err.message || err}`)
            }
            // stopAndWait() returns false when there was no managed run. That is
            // already-idle success, not a reason to block participant/Room deletion.
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

    emitMessageStreamStart(roomId: string, messageId: string, agentSessionId?: string): void {
        this.ensureConnected()
        this.socket!.emit('message_stream_start', {
            roomId,
            id: messageId,
            senderId: this.socket?.id || this.agentId,
            senderName: this.name,
            timestamp: Date.now(),
            ...(agentSessionId ? { agentSessionId } : {}),
        })
    }

    emitMessageStreamDelta(roomId: string, messageId: string, delta: string, agentSessionId?: string): void {
        if (!delta) return
        this.ensureConnected()
        this.socket!.emit('message_stream_delta', { roomId, id: messageId, delta, ...(agentSessionId ? { agentSessionId } : {}) })
    }

    emitMessageReasoningDelta(roomId: string, messageId: string, delta: string, agentSessionId?: string): void {
        if (!delta) return
        this.ensureConnected()
        this.socket!.emit('message_reasoning_delta', { roomId, id: messageId, delta, ...(agentSessionId ? { agentSessionId } : {}) })
    }

    emitMessageStreamEnd(roomId: string, messageId: string, agentSessionId?: string): void {
        this.ensureConnected()
        this.socket!.emit('message_stream_end', { roomId, id: messageId, ...(agentSessionId ? { agentSessionId } : {}) })
    }

    getJoinedRooms(): string[] {
        return Array.from(this.joinedRooms)
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
        if (!this.socket?.connected) {
            throw new Error(`Agent "${this.name}" is not connected`)
        }
    }

    private workspaceDiffKey(roomId: string, sessionId: string, runId: string): string {
        return `${roomId}\u0000${sessionId}\u0000${runId}`
    }

    private beginWorkspaceDiffIfNeeded(args: { roomId: string; sessionId: string; runId: string; workspace: string }): WorkspaceDiffRunState | null {
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
        return this.currentSessionId(roomId) === sessionId
    }

    private participantBinding(roomId: string): PersistedParticipantBinding | null {
        return this.storage?.getRoomAgentByAgentId?.(roomId, this.agentId) || null
    }

    private currentSessionId(roomId: string): string {
        const binding = this.participantBinding(roomId)
        const persisted = String(binding?.sessionId || '').trim()
        if (persisted) return persisted
        const sessionSeed = String(this.storage?.getRoom?.(roomId)?.sessionSeed || '0')
        return groupBridgeSessionId(roomId, this.profile, this.name, sessionSeed)
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
    async replyToMention(
        roomId: string,
        msg: MentionMessage,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        if (this.participantBinding(roomId)?.runtime === 'coding_agent') {
            await this.replyToCodingAgentMention(roomId, msg, onStatus)
            return
        }
        logger.debug(`[AgentClients] ${this.name} mentioned by ${msg.senderName}: "${msg.content.slice(0, 50)}"`)
        const runMessageId = groupMessageId(roomId, this.profile, this.name, msg.handoffJobId)
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

            // Build compressed context if context engine is available
            let conversationHistory: Array<{ role: string; content: string }> = []
            let instructions: string | undefined
            const bridge = new AgentBridgeClient()
            const sessionId = this.currentSessionId(roomId)
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
            const participantSnapshot = { ...(this.participantBinding(roomId) || {}) }
            const profileModelContext = await resolveGroupAgentModelContext(this.profile)
            const modelContext = {
                model: String(participantSnapshot.model || profileModelContext.model || '').trim(),
                provider: String(participantSnapshot.provider || profileModelContext.provider || '').trim(),
            }
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
            const directInputTokenEstimate = countTokens(isContentBlockArray(input)
                ? input.map(block => block.type === 'text' ? String(block.text || '') : `[${block.type}]`).join('\n')
                : input)

            if (this.contextEngine && this.storage) {
                try {
                    logger.debug(`[AgentClients] ${this.name}: building context...`)
                    // Get room members with descriptions for context
                    const roomMembers: Array<{ userId: string; name: string; description: string }> = this.storage.getRoomMembers(roomId) || []
                    const memberNames = roomMembers.map((m: any) => m.name)
                    const members = roomMembers.map((m: any) => ({ userId: m.userId, name: m.name, description: m.description }))

                    // Get room compression config
                    const roomInfo = this.storage.getRoom(roomId)
                    const compression = roomInfo ? effectiveGroupCompressionConfig({
                        triggerTokens: roomInfo.triggerTokens,
                        maxHistoryTokens: roomInfo.maxHistoryTokens,
                        tailMessageCount: roomInfo.tailMessageCount,
                    }, getModelContextLength({
                        profile: this.profile,
                        model: modelContext.model,
                        provider: modelContext.provider,
                    })) : undefined

                    const ctx = await this.contextEngine.buildContext({
                        roomId,
                        agentId: this.agentId,
                        agentName: this.name,
                        agentDescription: this.description,
                        agentSocketId: this.socket?.id || '',
                        roomName: roomId,
                        memberNames,
                        members,
                        upstream: '',
                        apiKey: null,
                        currentMessage: mentionMessageToStoredContextMessage(roomId, msg),
                        excludeCurrentMessageFromHistory: true,
                        directInputTokenEstimate,
                        compression,
                        profile: this.profile,
                        onProgress: (event: { status: 'compressing'; messageCount: number; tokenCount: number }) => {
                            reportStatus('compressing', {
                                messageCount: event.messageCount,
                                totalTokens: event.tokenCount,
                            })
                        },
                        contextTokenEstimator: async (history: Array<{ role: 'user' | 'assistant'; content: string }>, estimateInstructions: string) => {
                            return this.estimateGroupContextTokens(
                                roomId,
                                sessionId,
                                bridge,
                                history,
                                estimateInstructions,
                                modelContext,
                                'build',
                            )
                        },
                    })
                    if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                        await stopStaleStartedRun?.()
                        return
                    }
                    conversationHistory = ctx.conversationHistory
                    instructions = ctx.instructions
                    if (typeof ctx.meta.contextTokenEstimate === 'number' && Number.isFinite(ctx.meta.contextTokenEstimate)) {
                        this.storage.updateRoomTotalTokens?.(roomId, ctx.meta.contextTokenEstimate)
                        reportStatus('replying', { totalTokens: ctx.meta.contextTokenEstimate })
                    }
                    logger.debug(`[AgentClients] ${this.name}: context built — historyLen=${conversationHistory.length}, meta=%j`, ctx.meta)
                    reportStatus('replying')
                } catch (err: any) {
                    logger.warn(`[AgentClients] ${this.name}: context engine failed: ${err.message}`)
                    throw err
                }
            }

            // Keep routing explicit while removing only the mention tokens that
            // selected this agent. This avoids making @all look like an
            // instruction for the model to fan out another routing cycle.
            const runPrompt = 'When calling Hermes Web UI endpoints from tools or skills, include the current Hermes profile as the X-Hermes-Profile header if the endpoint supports profile-scoped behavior.'
            instructions = instructions ? `${runPrompt}\n${instructions}` : runPrompt
            const bridgeInput: AgentBridgeMessage = isContentBlockArray(input)
                ? await convertContentBlocksForAgent(input)
                : input
            if (!this.storage?.getRoom?.(roomId) || !this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
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
                    ...(participantSnapshot.reasoningEffort && participantSnapshot.reasoningEffort !== 'default'
                        ? { reasoning_effort: String(participantSnapshot.reasoningEffort) }
                        : {}),
                    source: 'group_chat',
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
                    workspace: roomWorkspace,
                })
            }

            this.emitMessageStreamStart(roomId, streamMessageId, sessionId)
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
                                mentionDepth: nextMentionDepth(msg),
                                reasoning: toolReasoning || null,
                                reasoning_content: toolReasoning || null,
                            }, sessionId)
                            flushedAssistantParts.add(streamMessageId)
                            currentContent = ''
                        }
                        await this.sendMessage(roomId, currentContent, streamMessageId, {
                            role: 'assistant',
                            mentionDepth: nextMentionDepth(msg),
                            handoffChainId: msg.handoffChainId || '',
                            handoffDepth: nextMentionDepth(msg),
                            sourceHandoffJobId: msg.handoffJobId || '',
                            sourceHandoffLeaseToken: msg.handoffLeaseToken || '',
                            handoffFinal: false,
                            reasoning: reasoningContent || null,
                            reasoning_content: reasoningContent || null,
                        }, sessionId)
                        flushedAssistantParts.add(streamMessageId)
                        currentContent = ''
                    }
                    this.emitMessageStreamEnd(roomId, toolBaseId, sessionId)
                    partIndex += 1
                    streamMessageId = groupMessagePartId(runMessageId, partIndex)
                    this.emitMessageStreamStart(roomId, streamMessageId, sessionId)
                    streamStarted = true
                    return toolBaseId
                })
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
                await this.sendAgentErrorMessage(roomId, streamMessageId, lastChunk.error || 'Run failed', msg, reasoningContent, sessionId)
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
                    mentionDepth: nextMentionDepth(msg),
                    handoffChainId: msg.handoffChainId || '',
                    handoffDepth: nextMentionDepth(msg),
                    sourceHandoffJobId: msg.handoffJobId || '',
                    sourceHandoffLeaseToken: msg.handoffLeaseToken || '',
                    handoffFinal: true,
                    reasoning: reasoningContent || null,
                    reasoning_content: reasoningContent || null,
                }, sessionId)
                this.emitMessageStreamEnd(roomId, streamMessageId, sessionId)
                await this.finalizeWorkspaceDiffOnce(workspaceRunState, 'completed', streamMessageId)
                await this.refreshRoomFullContextEstimate(roomId, sessionId, bridge, instructions, modelContext)
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
                await this.sendAgentErrorMessage(roomId, streamMessageId, err, msg, reasoningContent, activeSessionId || undefined)
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
        }
    }

    private async replyToCodingAgentMention(
        roomId: string,
        msg: MentionMessage,
        onStatus?: (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => void,
    ): Promise<void> {
        const binding = this.participantBinding(roomId)
        const codingAgentId = binding?.codingAgentId
        if (!binding || binding.runtime !== 'coding_agent' || (codingAgentId !== 'claude-code' && codingAgentId !== 'codex')) {
            throw new Error(`Coding agent participant "${this.name}" is not configured`)
        }

        const sessionId = this.currentSessionId(roomId)
        const replyInterruptVersion = this.interruptVersion(sessionId)
        const roomWorkspace = String(this.storage?.getRoom?.(roomId)?.workspace || '').trim()
        const messageId = groupMessagePartId(groupMessageId(roomId, this.profile, this.name, msg.handoffJobId), 0)
        let output = ''
        let reasoning = ''
        let settled = false
        let inactivityTimer: ReturnType<typeof setTimeout> | undefined
        let runTimer: ReturnType<typeof setTimeout> | undefined
        let unsubscribe = () => {}
        let resolveRun: () => void = () => {}
        let roomContextInstructions = ''
        let contextRevision = 0
        const eventToken = `${sessionId}:${messageId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`

        const runDone = new Promise<void>((resolve) => { resolveRun = resolve })
        const reportStatus = (status: 'compressing' | 'replying' | 'ready') => {
            onStatus?.(status, { agentSessionId: sessionId })
        }
        const cleanup = () => {
            if (settled) return
            settled = true
            if (inactivityTimer) clearTimeout(inactivityTimer)
            if (runTimer) clearTimeout(runTimer)
            unsubscribe()
            this.codingAgentReplyCancels.delete(sessionId)
            resolveRun()
        }
        this.codingAgentReplyCancels.set(sessionId, cleanup)
        const stopForTimeout = async (reason: string) => {
            if (settled) return
            await codingAgentRunManager.stopAndWait(sessionId, { reportClosed: false, graceMs: 15_000 })
            if (this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                await this.sendAgentErrorMessage(roomId, messageId, reason, msg, reasoning, sessionId)
                this.emitMessageStreamEnd(roomId, messageId, sessionId)
            }
            this.stopTyping(roomId)
            reportStatus('ready')
            cleanup()
        }
        const armInactivityTimer = () => {
            if (inactivityTimer) clearTimeout(inactivityTimer)
            inactivityTimer = setTimeout(() => {
                void stopForTimeout('Coding agent run stopped after 5 minutes without output')
            }, GROUP_CODING_AGENT_INACTIVITY_TIMEOUT_MS)
        }

        try {
            this.startTyping(roomId)
            reportStatus('replying')
            this.emitMessageStreamStart(roomId, messageId, sessionId)

            const participantCursor = Math.max(0, Math.floor(Number(binding.lastSeenRoomSeq || 0)))
            const canResolveStoredTrigger = typeof this.storage?.getMessage === 'function'
            const storedTriggerMessage = this.storage?.getMessage?.(msg.messageId)
            if (canResolveStoredTrigger && !storedTriggerMessage) {
                throw new Error('The triggering Room message is no longer available; refusing to advance Coding Agent continuity')
            }
            const triggerMessage = storedTriggerMessage || mentionMessageToStoredContextMessage(roomId, msg)
            const triggerRoomSeq = Math.max(0, Math.floor(Number(triggerMessage.roomSeq || 0)))
            if (canResolveStoredTrigger && triggerRoomSeq <= 0) {
                throw new Error('The triggering Room message has no persisted sequence; refusing to advance Coding Agent continuity')
            }
            const canonicalMessages = this.storage?.getMessagesForContext?.(roomId, triggerRoomSeq > 0
                ? {
                    throughRoomSeq: triggerRoomSeq,
                    ...(participantCursor > 0 ? { afterRoomSeq: participantCursor } : {}),
                }
                : { throughMessageId: msg.messageId }) || []
            contextRevision = participantContextRevision(participantCursor, triggerRoomSeq, canonicalMessages)
            if (this.contextEngine && this.storage) {
                const roomInfo = this.storage.getRoom(roomId)
                const roomMembers: Array<{ userId: string; name: string; description: string }> = this.storage.getRoomMembers(roomId) || []
                const compression = roomInfo ? effectiveGroupCompressionConfig({
                    triggerTokens: roomInfo.triggerTokens,
                    maxHistoryTokens: roomInfo.maxHistoryTokens,
                    tailMessageCount: roomInfo.tailMessageCount,
                }, getModelContextLength({
                    profile: this.profile,
                    model: binding.model,
                    provider: binding.provider,
                })) : undefined
                const participantCheckpoint = binding.checkpoint &&
                    Number(binding.checkpointFromRoomSeq || 0) === participantCursor + 1 &&
                    Number(binding.checkpointThroughRoomSeq || 0) >= Number(binding.checkpointFromRoomSeq || 0) &&
                    Number(binding.checkpointThroughRoomSeq || 0) < triggerRoomSeq
                    ? {
                        summary: String(binding.checkpoint),
                        fromRoomSeq: Number(binding.checkpointFromRoomSeq),
                        throughRoomSeq: Number(binding.checkpointThroughRoomSeq),
                    }
                    : undefined
                const context = await this.contextEngine.buildContext({
                    roomId,
                    agentId: this.agentId,
                    agentName: this.name,
                    agentDescription: this.description,
                    agentSocketId: this.socket?.id || '',
                    roomName: String(roomInfo?.name || roomId),
                    memberNames: roomMembers.map(member => member.name),
                    members: roomMembers,
                    upstream: '',
                    apiKey: null,
                    currentMessage: triggerMessage,
                    excludeCurrentMessageFromHistory: true,
                    directInputTokenEstimate: countTokens(stripMentionRoutingTokens(msg.content, this.name) || msg.content),
                    compression,
                    profile: this.profile,
                    participantCursor: Number(binding.lastSeenRoomSeq || 0),
                    participantCheckpoint,
                    onProgress: (event: { messageCount: number; tokenCount: number }) => {
                        onStatus?.('compressing', { agentSessionId: sessionId, messageCount: event.messageCount, totalTokens: event.tokenCount })
                    },
                })
                roomContextInstructions = [
                    context.instructions,
                    context.conversationHistory.length
                        ? `Canonical Room context through the triggering message:\n${context.conversationHistory.map((entry: { role: string; content: string }) => `${entry.role.toUpperCase()}: ${entry.content}`).join('\n')}`
                        : '',
                ].filter(Boolean).join('\n\n')
            }

            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) return

            unsubscribe = codingAgentRunManager.subscribe(sessionId, (event, payload) => {
                if (settled || !this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) return
                armInactivityTimer()
                if (event === 'message.delta') {
                    const delta = String(payload?.delta || '')
                    if (!delta) return
                    output += delta
                    this.emitMessageStreamDelta(roomId, messageId, delta, sessionId)
                    return
                }
                if (event === 'reasoning.delta' || event === 'thinking.delta') {
                    const delta = String(payload?.delta || payload?.text || '')
                    if (!delta) return
                    reasoning += delta
                    this.emitMessageReasoningDelta(roomId, messageId, delta, sessionId)
                    return
                }
                if (event === 'tool.started') {
                    this.recordToolStarted(roomId, sessionId, payload || {}, messageId)
                    return
                }
                if (event === 'tool.completed' || event === 'tool.failed') {
                    this.recordToolCompleted(roomId, sessionId, payload || {})
                    return
                }
                if (event === 'usage.updated') {
                    const totalTokens = Number(payload?.contextTokens ?? ((payload?.inputTokens || 0) + (payload?.outputTokens || 0)))
                    if (Number.isFinite(totalTokens) && totalTokens >= 0) {
                        this.storage?.updateRoomTotalTokens?.(roomId, Math.floor(totalTokens))
                        reportStatus('replying')
                    }
                    return
                }
                if (event !== 'run.completed' && event !== 'run.failed') return
                void (async () => {
                    const finalOutput = String(payload?.output || '').trim()
                    if (!output && finalOutput) {
                        output = finalOutput
                        this.emitMessageStreamDelta(roomId, messageId, finalOutput, sessionId)
                    }
                    if (event === 'run.failed') {
                        await this.persistCodingAgentWorkspaceDiff(roomId, sessionId, payload, 'failed', messageId, roomWorkspace)
                        await this.sendAgentErrorMessage(roomId, messageId, payload?.error || 'Coding agent run failed', msg, reasoning, sessionId)
                    } else if (output) {
                        this.stopTyping(roomId)
                        await this.sendMessage(roomId, output, messageId, {
                            role: 'assistant',
                            mentionDepth: nextMentionDepth(msg),
                            handoffChainId: msg.handoffChainId || '',
                            handoffDepth: nextMentionDepth(msg),
                            sourceHandoffJobId: msg.handoffJobId || '',
                            sourceHandoffLeaseToken: msg.handoffLeaseToken || '',
                            handoffFinal: true,
                            reasoning: reasoning || null,
                            reasoning_content: reasoning || null,
                        }, sessionId)
                        await this.persistCodingAgentWorkspaceDiff(roomId, sessionId, payload, 'completed', messageId, roomWorkspace)
                    } else {
                        await this.persistCodingAgentWorkspaceDiff(roomId, sessionId, payload, 'completed', messageId, roomWorkspace)
                    }
                    if (event === 'run.completed' && this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                        this.storage?.updateRoomAgentContinuity?.(roomId, this.agentId, {
                            lastSeenRoomSeq: contextRevision,
                            lastSuccessfulRunId: String(payload?.run_id || codingAgentRunManager.runIdForSession(sessionId) || ''),
                        })
                    }
                    this.emitMessageStreamEnd(roomId, messageId, sessionId)
                    this.stopTyping(roomId)
                    reportStatus('ready')
                    cleanup()
                })().catch(async (err) => {
                    logger.error(`[AgentClients] ${this.name}: failed to publish coding-agent result: ${err.message || err}`)
                    await stopForTimeout(err?.message || 'Failed to publish coding agent result')
                })
            }, eventToken)

            const launch = {
                agentId: codingAgentId,
                mode: binding.mode || 'scoped',
                provider: binding.provider,
                model: binding.model,
                apiMode: binding.apiMode as any,
                reasoningEffort: binding.reasoningEffort,
            }
            let runId = codingAgentRunManager.runIdForSession(sessionId)
            if (runId && !codingAgentRunManager.isSessionLaunchCompatible(sessionId, launch)) {
                const stopped = await codingAgentRunManager.stopAndWait(sessionId, { reportClosed: false, graceMs: 15_000 })
                if (!stopped) throw new Error('Previous coding-agent run did not stop cleanly')
                runId = undefined
            }
            if (!runId) {
                await startCodingAgentRun(codingAgentId, {
                    sessionId,
                    mode: binding.mode || 'scoped',
                    profile: binding.profile || this.profile,
                    provider: binding.provider,
                    model: binding.model,
                    apiMode: binding.apiMode as any,
                    reasoningEffort: binding.reasoningEffort,
                    workspace: roomWorkspace || null,
                    runtimeContext: 'group_chat',
                })
                if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await codingAgentRunManager.stopAndWait(sessionId, { reportClosed: false, graceMs: 15_000 })
                    return
                }
            }

            if (!this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) return
            const routedInput = stripMentionRoutingTokens(msg.content, this.name) || msg.content
            const systemPrompt = [
                getSystemPrompt(undefined, { source: 'coding_agent' }),
                `You are ${this.name}, a participant in Group Chat room ${roomId}. Reply to the triggering message for the shared room.`,
                roomContextInstructions,
            ].filter(Boolean).join('\n\n')
            sendCodingAgentRunInput(sessionId, routedInput, systemPrompt, [], undefined, eventToken)
            armInactivityTimer()
            runTimer = setTimeout(() => {
                void stopForTimeout('Coding agent run exceeded the 30 minute deadline')
            }, GROUP_CODING_AGENT_RUN_TIMEOUT_MS)
            await runDone
        } catch (err: any) {
            if (!settled) {
                if (this.replySessionIsCurrent(roomId, sessionId, replyInterruptVersion)) {
                    await this.sendAgentErrorMessage(roomId, messageId, err, msg, reasoning, sessionId)
                    this.emitMessageStreamEnd(roomId, messageId, sessionId)
                }
                this.stopTyping(roomId)
                reportStatus('ready')
                cleanup()
            }
        }
    }

    private async persistCodingAgentWorkspaceDiff(
        roomId: string,
        sessionId: string,
        payload: any,
        status: 'completed' | 'failed' | 'aborted',
        parentMessageId: string | null,
        workspace: string,
    ): Promise<void> {
        const draft = payload?.workspace_run_change
        if (!draft || !workspace || !this.storage?.saveWorkspaceDiffMessageForRun) return
        if (!this.roomSessionIsCurrent(roomId, sessionId)) return
        try {
            const saved = this.storage.saveWorkspaceDiffMessageForRun({
                roomId,
                senderId: this.agentId,
                senderName: this.name,
                sessionId,
                runId: String(payload?.run_id || draft.run_id || codingAgentRunManager.runIdForSession(sessionId) || 'run'),
                status,
                workspace,
                draft,
                parentMessageId,
            })
            if (saved?.message) this.workspaceDiffBroadcaster?.(roomId, saved.message, saved.totalTokens)
        } catch (err) {
            logger.warn({ err, roomId, sessionId }, '[GroupChat] failed to persist coding-agent workspace diff')
        }
    }

    private async refreshRoomFullContextEstimate(
        roomId: string,
        sessionId: string,
        bridge: AgentBridgeClient,
        instructions?: string,
        modelContext: GroupModelContext = { model: '', provider: '' },
    ): Promise<void> {
        if (!this.storage?.getMessagesForContext) return
        try {
            const history = this.buildRoomEstimateHistory(roomId)
            const cachedTokens = await this.estimateGroupContextTokens(
                roomId,
                sessionId,
                bridge,
                history,
                instructions,
                modelContext,
                'final',
            )
            if (cachedTokens == null || cachedTokens <= 0) return
            if (!this.roomSessionIsCurrent(roomId, sessionId)) return
            const rounded = Math.floor(cachedTokens)
            this.storage.updateRoomTotalTokens?.(roomId, rounded)
            this.emitContextStatus(roomId, 'replying', { totalTokens: rounded }, sessionId)
        } catch (err: any) {
            logger.warn(`[GroupChat] failed to refresh final context estimate room=${roomId} agent=${this.name}: ${err.message}`)
        }
    }

    private buildRoomEstimateHistory(roomId: string): Array<{ role: 'user' | 'assistant'; content: string }> {
        const messages: StoredMessage[] = this.storage?.getMessagesForContext?.(roomId) || []
        const snapshot = this.storage?.getContextSnapshot?.(roomId)
        if (snapshot?.summary) {
            const tail = Number(snapshot.lastRoomSeq || 0) > 0
                ? messages.filter(message => Number(message.roomSeq || 0) > Number(snapshot.lastRoomSeq || 0))
                : sliceGroupMessagesForSnapshotTail(messages, snapshot.lastMessageId).messages
            return buildProjectedGroupChatHistory(snapshot.summary, tail, { agentId: this.agentId, socketId: this.socket?.id, name: this.name })
        }
        return messages
            .filter((message: any) => !isWorkspaceDiffToolMessage(message))
            .map((message: any) => this.mapRoomMessageForEstimate(message))
    }

    private mapRoomMessageForEstimate(message: any): { role: 'user' | 'assistant'; content: string } {
        return projectGroupChatMessage(message, { agentId: this.agentId, socketId: this.socket?.id, name: this.name })
    }

    private async sendAgentErrorMessage(
        roomId: string,
        messageId: string,
        error: unknown,
        sourceMsg: MentionMessage,
        reasoningContent = '',
        sessionId?: string,
    ): Promise<void> {
        const detail = error instanceof Error ? error.message : String(error || 'Run failed')
        const content = detail.startsWith('Error:') ? detail : `Error: ${detail}`
        await this.sendMessage(roomId, content, messageId, {
            role: 'assistant',
            mentionDepth: nextMentionDepth(sourceMsg),
            handoffChainId: sourceMsg.handoffChainId || '',
            handoffDepth: nextMentionDepth(sourceMsg),
            sourceHandoffJobId: sourceMsg.handoffJobId || '',
            sourceHandoffLeaseToken: sourceMsg.handoffLeaseToken || '',
            handoffFinal: true,
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
                this.recordToolStarted(roomId, sessionId, ev as Record<string, unknown>, toolBaseId, toolReasoning)
                reasoning = ''
            } else if (eventType === 'tool.completed') {
                if (!this.replySessionIsCurrent(roomId, sessionId, interruptVersion)) return reasoning
                this.recordToolCompleted(roomId, sessionId, ev as Record<string, unknown>)
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
        reasoning = '',
    ): void {
        const toolName = String(ev.tool_name || ev.tool || ev.name || '')
        const toolCallId = groupToolCallId(ev.tool_call_id, toolName, this.nextToolIndex(roomId, toolName))
        this.trackPendingToolCall(roomId, toolName, toolCallId)
        this.pendingToolBaseIds.set(toolCallId, runMessageId)
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
            senderId: this.socket?.id || this.agentId,
            senderName: this.name,
            content: '',
            timestamp,
            role: 'assistant',
            tool_calls: [toolCall],
            finish_reason: 'tool_calls',
            reasoning: reasoning || null,
            reasoning_content: reasoning || null,
        }
        this.sendMessage(roomId, '', msg.id, {
            role: 'assistant',
            tool_calls: msg.tool_calls,
            finish_reason: 'tool_calls',
            reasoning: reasoning || null,
            reasoning_content: reasoning || null,
            timestamp,
        }, sessionId).catch((err: any) => logger.warn(`[AgentClients] failed to record tool call: ${err.message}`))
    }

    private recordToolCompleted(roomId: string, sessionId: string, ev: Record<string, unknown>): void {
        const toolName = String(ev.tool_name || ev.tool || ev.name || '')
        const rawId = String(ev.tool_call_id || '').trim()
        const toolCallId = rawId || this.takePendingToolCall(roomId, toolName) || groupToolCallId(null, toolName, this.nextToolIndex(roomId, toolName))
        const runMessageId = this.pendingToolBaseIds.get(toolCallId) || groupMessagePartId(groupMessageId(roomId, this.profile, this.name), 0)
        this.pendingToolBaseIds.delete(toolCallId)
        const output = bridgeToolOutput(ev)
        const timestamp = Date.now()
        const msg: MessageData & Record<string, any> = {
            id: `${runMessageId}_toolresult_${safeId(toolCallId)}_${Date.now()}`,
            roomId,
            senderId: this.socket?.id || this.agentId,
            senderName: this.name,
            content: output,
            timestamp,
            role: 'tool',
            tool_call_id: toolCallId,
            tool_name: toolName || null,
        }
        this.sendMessage(roomId, output, msg.id, {
            role: 'tool',
            tool_call_id: toolCallId,
            tool_name: toolName || null,
            timestamp,
        }, sessionId).catch((err: any) => logger.warn(`[AgentClients] failed to record tool result: ${err.message}`))
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

export function groupBridgeSessionId(roomId: string, profile: string, name: string, sessionSeed: string): string {
    const rawKey = `gc_${roomId}_${profile}_${name}_${sessionSeed || '0'}`
    const safePrefix = rawKey.replace(/[^a-zA-Z0-9_-]/g, '_')
    const keyHash = createHash('sha256').update(rawKey).digest('hex').slice(0, 16)
    const suffix = `_h_${keyHash}`
    return `${safePrefix.slice(0, Math.max(0, 120 - suffix.length))}${suffix}`
}

function groupMessageId(roomId: string, profile: string, name: string, handoffJobId?: string): string {
    if (handoffJobId) return `gcmsg_handoff_${safeId(handoffJobId)}`
    const raw = `gcmsg_${safeId(roomId)}_${safeId(profile)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160)
}

function groupMessagePartId(runMessageId: string, partIndex: number): string {
    return `${safeId(runMessageId)}_part_${partIndex}`
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
    const value = ev.result ?? ev.output ?? ev.result_preview ?? ev.preview ?? ''
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
    private rooms = new Map<string, Map<string, AgentClient>>()
    private _contextEngine: any = null
    private _storage: any = null
    private _workspaceDiffBroadcaster: WorkspaceDiffBroadcaster | null = null

    // Per-room processing lock + mention queue
    private _processingRooms = new Set<string>()
    private _mentionQueue = new Map<string, Array<{ agent: AgentClient; msg: MentionMessage }>>()
    private _pausedRooms = new Set<string>()

    /**
     * Create an agent client and connect it to the server.
     * The agent will NOT auto-join any room — call addAgentToRoom separately.
     */
    async createAgent(config: AgentConfig, handlers?: AgentEventHandler, port?: number): Promise<AgentClient> {
        const client = new AgentClient(config, handlers)
        await client.connect(port)

        // Auto-apply stored references (fixes propagation for agents created after set*)
        if (this._contextEngine) client.setContextEngine(this._contextEngine)
        if (this._storage) client.setStorage(this._storage)
        client.setWorkspaceDiffBroadcaster(this._workspaceDiffBroadcaster)

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

            // Invalidate context engine cache for this agent
            if (this._contextEngine) {
                try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
            }
        }

        if (room.size === 0) {
            this.rooms.delete(roomId)
        }
    }

    /**
     * Get all agents in a room.
     */
    getAgents(roomId: string): AgentClient[] {
        const room = this.rooms.get(roomId)
        return room ? Array.from(room.values()) : []
    }

    /**
     * Get a specific agent in a room.
     */
    getAgent(roomId: string, agentId: string): AgentClient | undefined {
        return this.rooms.get(roomId)?.get(agentId)
    }

    updateAgentIdentity(roomId: string, agentId: string, name: string, description: string): boolean {
        const client = this.getAgent(roomId, agentId)
        if (!client) return false
        client.updateIdentity(name, description)
        return true
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

    private mentionQueueKeysForRoom(roomId: string): string[] {
        return Array.from(this._mentionQueue.keys()).filter(key => key === roomId || key.startsWith(`${roomId}:`))
    }

    private clearMentionQueuesForRoom(roomId: string): void {
        for (const key of this.mentionQueueKeysForRoom(roomId)) this._mentionQueue.delete(key)
    }

    private queueMention(agentKey: string, agent: AgentClient, msg: MentionMessage): void {
        let queue = this._mentionQueue.get(agentKey)
        if (!queue) {
            queue = []
            this._mentionQueue.set(agentKey, queue)
        }
        queue.push({ agent, msg })
    }

    private agentQueueKey(roomId: string, agent: Pick<AgentClient, 'agentId'>): string {
        return `${roomId}:${agent.agentId}`
    }

    async interruptAgent(roomId: string, agentRef: string): Promise<void> {
        const agent = this.getAgents(roomId).find(a => a.agentId === agentRef || a.id === agentRef || a.name === agentRef)
        if (!agent) throw new Error(`Agent "${agentRef}" not found in room "${roomId}"`)
        const synced = await agent.interrupt(roomId)
        if (!synced) throw this.buildUnsyncedInterruptError(roomId)
        this._mentionQueue.delete(this.agentQueueKey(roomId, agent))
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

        // Invalidate context engine cache for this room
        if (this._contextEngine) {
            try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
        }
    }

    resetRoomContext(roomId: string): void {
        this.clearMentionQueuesForRoom(roomId)
        this._pausedRooms.delete(roomId)
        for (const key of Array.from(this._processingRooms)) {
            if (key.startsWith(`${roomId}:`)) this._processingRooms.delete(key)
        }
        if (this._contextEngine) {
            try { this._contextEngine.invalidateRoom(roomId) } catch { /* ignore */ }
        }
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
     * Set context engine for all existing and future agents.
     */
    setContextEngine(engine: any): void {
        this._contextEngine = engine
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setContextEngine(engine))
        })
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


    /**
     * Validate a single Room message against the smallest actually mentioned participant window.
     * Non-text attachment payloads are represented by their compact text reference before this call.
     */
    validateMessageInput(roomId: string, content: string, senderId: string): { ok: true } | { ok: false; error: string } {
        const agents = this.getAgents(roomId)
        const mentioned = resolveMentionTargets(agents, content, senderId)
        const targets = mentioned.length > 0 ? mentioned : agents
        if (targets.length === 0) return { ok: true }

        let strictest: { name: string; maxTokens: number } | null = null
        for (const agent of targets) {
            const modelWindow = agent.modelContextLengthForRoom(roomId)
            const maxTokens = Math.max(1, Math.floor(modelWindow * GROUP_CONTEXT_TRIGGER_RATIO * GROUP_SINGLE_MESSAGE_RATIO))
            if (!strictest || maxTokens < strictest.maxTokens) strictest = { name: agent.name, maxTokens }
        }
        const tokens = countTokens(content)
        if (strictest && tokens > strictest.maxTokens) {
            return {
                ok: false,
                error: `Message exceeds the safe input limit for @${strictest.name} (${strictest.maxTokens} tokens). Upload a file or split the message.`,
            }
        }
        return { ok: true }
    }

    /**
     * Server-side: parse @mentions and forward to matching agents directly.
     * If the room is already processing (compressing/replying), queue the mention.
     */
    async processMentions(roomId: string, msg: MentionMessage): Promise<void> {
        const agents = this.getAgents(roomId)
        const mentioned = resolveMentionTargets(agents, msg.content, msg.senderId)
        if (mentioned.length === 0) return

        logger.debug(`[AgentClients] ${mentioned.map(a => a.name).join(', ')} mentioned by ${msg.senderName}`)

        for (const agent of mentioned) {
            this._processAgentMention(roomId, agent, msg).catch((err) => {
                logger.error(`[AgentClients] error processing mention for ${agent.name}: ${err.message}`)
            })
        }
    }

    async processHandoffJob(job: {
        id: string
        roomId: string
        chainId: string
        targetAgentId: string
        targetSessionId: string
        depth: number
        kind: 'mention' | 'fixed' | 'fanout'
        leaseToken: string
    }, source: MentionMessage): Promise<void> {
        const agent = this.getAgents(job.roomId).find(candidate => candidate.agentId === job.targetAgentId)
        if (!agent) {
            const err = new Error(`Handoff target ${job.targetAgentId} is not connected`) as Error & { safeRetry?: boolean }
            err.safeRetry = true
            throw err
        }
        const binding = this._storage?.getRoomAgentByAgentId?.(job.roomId, job.targetAgentId)
        if (!binding || String(binding.sessionId || '') !== job.targetSessionId) {
            throw new Error(`Handoff target session changed for ${job.targetAgentId}`)
        }
        await this._processAgentMention(job.roomId, agent, {
            ...source,
            mentionDepth: job.depth,
            handoffJobId: job.id,
            handoffLeaseToken: job.leaseToken,
            handoffChainId: job.chainId,
            handoffKind: job.kind,
            targetSessionId: job.targetSessionId,
        })
        const completed = this._storage?.getHandoffJob?.(job.id)
        if (!completed || !['completed', 'failed'].includes(completed.status)) {
            throw new Error(`Handoff ${job.id} ended without a durable final response`)
        }
    }

    /**
     * Process a single agent mention with status reporting and queue drain.
     */
    private async _processAgentMention(
        roomId: string,
        agent: AgentClient,
        msg: MentionMessage,
    ): Promise<void> {
        const agentKey = this.agentQueueKey(roomId, agent)
        if (this._pausedRooms.has(roomId)) {
            if (msg.handoffJobId) {
                const err = new Error(`Room ${roomId} is paused`) as Error & { retryWithoutAttempt?: boolean }
                err.retryWithoutAttempt = true
                throw err
            }
            this.queueMention(agentKey, agent, msg)
            logger.debug(`[AgentClients] room ${roomId} is interrupting, queued mention for agent ${agent.name}`)
            return
        }
        if (this._processingRooms.has(agentKey)) {
            if (msg.handoffJobId) {
                const err = new Error(`Agent ${agent.name} is already processing`) as Error & { retryWithoutAttempt?: boolean }
                err.retryWithoutAttempt = true
                throw err
            }
            this.queueMention(agentKey, agent, msg)
            logger.debug(`[AgentClients] agent ${agent.name} is processing, queued mention in room ${roomId}`)
            return
        }

        this._processingRooms.add(agentKey)
        const onStatus = (status: 'compressing' | 'replying' | 'ready', extra?: Record<string, unknown>) => {
            agent.emitContextStatus(roomId, status, extra)
            logger.debug(`[AgentClients] room ${roomId} agent ${agent.name} status: ${status}`)
        }

        try {
            await agent.replyToMention(roomId, msg, onStatus)
        } finally {
            this._processingRooms.delete(agentKey)
            if (!this._pausedRooms.has(roomId)) {
                await this._drainQueue(agentKey, roomId)
            }
        }
    }

    /**
     * Drain queued mentions for a room after processing completes.
     */
    private async _drainQueue(agentKey: string, roomId: string): Promise<void> {
        const queue = this._mentionQueue.get(agentKey)
        if (!queue || queue.length === 0) return

        this._mentionQueue.delete(agentKey)
        logger.debug(`[AgentClients] draining ${queue.length} queued mention(s) for ${agentKey}`)

        // Process the last queued mention only (most recent, discards stale intermediate ones)
        const last = queue[queue.length - 1]
        await this._processAgentMention(roomId, last.agent, last.msg)
    }
}

function nextMentionDepth(msg: MentionMessage): number {
    return Math.max(0, msg.mentionDepth || 0) + 1
}
