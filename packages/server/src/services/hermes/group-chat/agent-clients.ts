import { io, Socket } from 'socket.io-client'
import { EventSource } from 'eventsource'
import { getToken } from '../../../services/auth'
import type { GatewayManager } from '../gateway-manager'
import { deleteSession as hermesDeleteSession } from '../hermes-cli'
import { getActiveProfileName } from '../hermes-profile'
import { logger } from '../../../services/logger'
import { updateUsage } from '../../../db/hermes/usage-store'
import { getSessionDetailFromDbWithProfile } from '../../../db/hermes/sessions-db'

// ─── Types ────────────────────────────────────────────────────

interface AgentConfig {
    profile: string
    name: string
    description: string
    invited: number
}

interface MessageData {
    id: string
    roomId: string
    senderId: string
    senderName: string
    content: string
    timestamp: number
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
    readonly name: string
    readonly description: string
    private socket: Socket | null = null
    private joinedRooms = new Set<string>()
    private handlers: AgentEventHandler
    private _reconnecting = false
    private gatewayManager: GatewayManager | null = null
    private contextEngine: any = null
    private storage: any = null

    constructor(config: AgentConfig, handlers: AgentEventHandler = {}) {
        this.agentId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
        this.profile = config.profile
        this.name = config.name
        this.description = config.description
        this.handlers = handlers
    }

    get connected(): boolean {
        return this.socket?.connected ?? false
    }

    get id(): string | undefined {
        return this.socket?.id
    }

    setGatewayManager(manager: GatewayManager): void {
        this.gatewayManager = manager
    }

    setContextEngine(engine: any): void {
        this.contextEngine = engine
    }

    setStorage(storage: any): void {
        this.storage = storage
    }

    async connect(port = 8648): Promise<void> {
        const token = await getToken()

        this.socket = io(`http://127.0.0.1:${port}/group-chat`, {
            auth: {
                token: token || undefined,
                name: this.name,
            },
            transports: ['websocket'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 30000,
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

    sendMessage(roomId: string, content: string): Promise<string> {
        this.ensureConnected()
        return new Promise((resolve, reject) => {
            this.socket!.emit('message', { roomId, content }, (res: { id?: string; error?: string }) => {
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

    emitContextStatus(roomId: string, status: 'compressing' | 'replying' | 'ready'): void {
        this.ensureConnected()
        this.socket!.emit('context_status', { roomId, agentName: this.name, status })
    }

    getJoinedRooms(): string[] {
        return Array.from(this.joinedRooms)
    }

    private ensureConnected(): void {
        if (!this.socket?.connected) {
            throw new Error(`Agent "${this.name}" is not connected`)
        }
    }

    private async deleteSession(sessionId: string): Promise<void> {
        try {
            const sessionProfile = this.storage?.getSessionProfile?.(sessionId)
            const currentProfile = getActiveProfileName()

            if (sessionProfile && sessionProfile.profile_name !== currentProfile) {
                // Cross-profile: enqueue deferred delete, don't switch profile
                this.storage?.enqueuePendingSessionDelete?.(sessionId, sessionProfile.profile_name)
                logger.info(`[AgentClients] ${this.name}: cross-profile deferred delete session ${sessionId} (session=${sessionProfile.profile_name}, active=${currentProfile})`)
                return
            }

            // Same profile or no mapping: delete directly
            const ok = await hermesDeleteSession(sessionId)
            if (ok) {
                this.storage?.deleteSessionProfile?.(sessionId)
            }
            logger.debug(`[AgentClients] ${this.name}: delete session ${sessionId} (profile=${this.profile}) → ${ok ? 'ok' : 'failed'}`)
        } catch (err: any) {
            logger.warn(`[AgentClients] ${this.name}: failed to delete session ${sessionId}: ${err.message}`)
        }
    }

    // ─── Hermes Gateway Integration ────────────────────────────

    /**
     * Handle an @mention from the server side.
     * Called by AgentClients.processMentions() — no socket round-trip needed.
     * onStatus is called to report context compression progress.
     */
    async replyToMention(
        roomId: string,
        msg: { content: string; senderName: string; senderId: string; timestamp: number },
        onStatus?: (status: 'compressing' | 'replying' | 'ready') => void,
    ): Promise<void> {
        logger.debug(`[AgentClients] ${this.name} mentioned by ${msg.senderName}: "${msg.content.slice(0, 50)}"`)
        if (!this.gatewayManager) {
            logger.debug(`[AgentClients] ${this.name}: gatewayManager is null, skipping`)
            return
        }

        const upstream = this.gatewayManager.getUpstream(this.profile)
        const apiKey = this.gatewayManager.getApiKey(this.profile)
        logger.debug(`[AgentClients] ${this.name}: upstream=${upstream}, profile=${this.profile}`)
        if (!upstream) {
            logger.error(`[AgentClients] ${this.name}: no gateway upstream for profile "${this.profile}"`)
            return
        }

        const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

        try {
            // Notify room that agent is typing
            this.startTyping(roomId)

            // Build compressed context if context engine is available
            let conversationHistory: Array<{ role: string; content: string }> = []
            let instructions: string | undefined

            if (this.contextEngine && this.storage) {
                try {
                    logger.debug(`[AgentClients] ${this.name}: building context...`)
                    onStatus?.('compressing')
                    // Get room members with descriptions for context
                    const roomMembers: Array<{ userId: string; name: string; description: string }> = this.storage.getRoomMembers(roomId) || []
                    const memberNames = roomMembers.map((m: any) => m.name)
                    const members = roomMembers.map((m: any) => ({ userId: m.userId, name: m.name, description: m.description }))

                    // Get room compression config
                    const roomInfo = this.storage.getRoom(roomId)
                    const compression = roomInfo ? {
                        triggerTokens: roomInfo.triggerTokens,
                        maxHistoryTokens: roomInfo.maxHistoryTokens,
                        tailMessageCount: roomInfo.tailMessageCount,
                    } : undefined

                    const ctx = await this.contextEngine.buildContext({
                        roomId,
                        agentId: this.agentId,
                        agentName: this.name,
                        agentDescription: this.description,
                        agentSocketId: this.socket?.id || '',
                        roomName: roomId,
                        memberNames,
                        members,
                        upstream,
                        apiKey,
                        currentMessage: msg,
                        compression,
                        profile: this.profile,
                    })
                    conversationHistory = ctx.conversationHistory
                    instructions = ctx.instructions
                    logger.debug(`[AgentClients] ${this.name}: context built — historyLen=${conversationHistory.length}, meta=%j`, ctx.meta)
                    onStatus?.('replying')
                } catch (err: any) {
                    logger.warn(`[AgentClients] ${this.name}: context engine failed: ${err.message}`)
                    onStatus?.('replying')
                    // Degrade: continue without context
                }
            }

            // Strip @mention from input — agent already knows it was mentioned
            const input = msg.content.replace(new RegExp(`@${this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'gi'), '').trim() || msg.content

            // Start a run on Hermes gateway
            const runRes = await fetch(`${upstream}/v1/runs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    input,
                    session_id: sessionId,
                    ...(conversationHistory.length > 0 ? { conversation_history: conversationHistory } : {}),
                    ...(instructions ? { instructions } : {}),
                }),
                signal: AbortSignal.timeout(120000),
            })

            if (!runRes.ok) {
                const text = await runRes.text().catch(() => '')
                logger.error(`[AgentClients] ${this.name}: gateway run failed (${runRes.status}): ${text}`)
                this.stopTyping(roomId)
                return
            }

            const runData = await runRes.json() as any
            const run_id = runData.run_id
            logger.debug(`[AgentClients] ${this.name}: run started, response=%j`, runData)
            if (!run_id) {
                logger.error(`[AgentClients] ${this.name}: no run_id in response`)
                this.stopTyping(roomId)
                return
            }

            // Save session-to-profile mapping after gateway confirms the run
            const actualSessionId = runData.session_id || sessionId
            if (!this.storage) {
                logger.warn(`[AgentClients] ${this.name}: storage is null, cannot save session profile for ${actualSessionId}`)
            } else {
                this.storage.saveSessionProfile(actualSessionId, roomId, this.agentId, this.profile)
                logger.debug(`[AgentClients] ${this.name}: saved session profile ${actualSessionId} → profile=${this.profile}`)
            }

            // Stream events from Hermes
            const eventsUrl = new URL(`${upstream}/v1/runs/${run_id}/events`)
            if (apiKey) eventsUrl.searchParams.set('token', apiKey)
            logger.debug(`[AgentClients] ${this.name}: streaming events from ${eventsUrl}`)
            const source = new EventSource(eventsUrl.toString())

            let fullContent = ''

            source.onmessage = async (e: any) => {
                try {
                    const parsed = JSON.parse(e.data)
                    logger.debug(`[AgentClients] ${this.name}: event=${parsed.event}`)

                    if (parsed.event === 'run.completed') {
                        // Record usage data from Hermes state.db BEFORE closing source
                        // This ensures we fetch usage before deleteSession can delete it
                        try {
                            const detail = await getSessionDetailFromDbWithProfile(actualSessionId, this.profile)
                            if (detail) {
                                updateUsage(roomId, {
                                    inputTokens: detail.input_tokens,
                                    outputTokens: detail.output_tokens,
                                    cacheReadTokens: detail.cache_read_tokens,
                                    cacheWriteTokens: detail.cache_write_tokens,
                                    reasoningTokens: detail.reasoning_tokens,
                                    model: detail.model,
                                    profile: this.profile,
                                })
                                logger.debug(`[AgentClients] Recorded usage for room ${roomId} (session ${actualSessionId}, profile=${this.profile}): input=${detail.input_tokens}, output=${detail.output_tokens}`)
                            } else {
                                logger.warn(`[AgentClients] Failed to get session detail for ${actualSessionId} (profile=${this.profile})`)
                            }
                        } catch (err: any) {
                            logger.warn(err, '[AgentClients] Failed to record usage from DB')
                        }

                        source.close()
                        logger.debug(`[AgentClients] ${this.name}: run completed, content length=${fullContent.length}`)
                        if (fullContent) {
                            this.stopTyping(roomId)
                            this.sendMessage(roomId, fullContent)
                        }
                        this.deleteSession(actualSessionId).catch(() => { })
                        onStatus?.('ready')
                        return
                    }

                    if (parsed.event === 'run.failed') {
                        source.close()
                        logger.error(`[AgentClients] ${this.name}: run failed`)
                        this.stopTyping(roomId)
                        this.deleteSession(actualSessionId).catch(() => { })
                        onStatus?.('ready')
                        return
                    }

                    // Accumulate message deltas
                    if (parsed.event === 'message.delta' && parsed.delta) {
                        fullContent += parsed.delta
                    }
                } catch {
                    // ignore parse errors
                }
            }

            source.onerror = (err: any) => {
                logger.error(err, `[AgentClients] ${this.name}: EventSource error`)
                source.close()
                this.stopTyping(roomId)
                this.deleteSession(actualSessionId).catch(() => { })
                onStatus?.('ready')
            }
        } catch (err: any) {
            logger.error(`[AgentClients] ${this.name}: error handling message: ${err.message}`)
            this.stopTyping(roomId)
            this.deleteSession(sessionId).catch(() => { })
            onStatus?.('ready')
        }
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

// ─── AgentClients (roomId -> agents) ──────────────────────────

export class AgentClients {
    private rooms = new Map<string, Map<string, AgentClient>>()
    private _gatewayManager: GatewayManager | null = null
    private _contextEngine: any = null
    private _storage: any = null

    // Per-room processing lock + mention queue
    private _processingRooms = new Set<string>()
    private _mentionQueue = new Map<string, Array<{ agent: AgentClient; msg: { content: string; senderName: string; senderId: string; timestamp: number } }>>()

    /**
     * Create an agent client and connect it to the server.
     * The agent will NOT auto-join any room — call addAgentToRoom separately.
     */
    async createAgent(config: AgentConfig, handlers?: AgentEventHandler, port?: number): Promise<AgentClient> {
        const client = new AgentClient(config, handlers)
        await client.connect(port)

        // Auto-apply stored references (fixes propagation for agents created after set*)
        if (this._gatewayManager) client.setGatewayManager(this._gatewayManager)
        if (this._contextEngine) client.setContextEngine(this._contextEngine)
        if (this._storage) client.setStorage(this._storage)

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
        const result = await client.joinRoom(roomId)
        logger.info(`[AgentClients] ${client.name} joined room: ${roomId}`)
        return result
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

    /**
     * Disconnect all agents in a room.
     */
    disconnectRoom(roomId: string): void {
        const room = this.rooms.get(roomId)
        if (!room) return

        room.forEach((client) => client.disconnect())
        this.rooms.delete(roomId)
        logger.info(`[AgentClients] All agents disconnected from room: ${roomId}`)

        // Invalidate context engine cache for this room
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
     * Set gateway manager for all existing and future agents.
     */
    setGatewayManager(manager: GatewayManager): void {
        this._gatewayManager = manager
        this.rooms.forEach((room) => {
            room.forEach((client) => client.setGatewayManager(manager))
        })
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


    /**
     * Server-side: parse @mentions and forward to matching agents directly.
     * If the room is already processing (compressing/replying), queue the mention.
     */
    async processMentions(roomId: string, msg: { content: string; senderName: string; senderId: string; timestamp: number }): Promise<void> {
        if (!this._gatewayManager) return

        const content = msg.content.toLowerCase()
        const agents = this.getAgents(roomId)

        const mentioned = agents.filter(a => content.includes(`@${a.name.toLowerCase()}`))
        if (mentioned.length === 0) return

        logger.debug(`[AgentClients] ${mentioned.map(a => a.name).join(', ')} mentioned by ${msg.senderName}`)

        for (const agent of mentioned) {
            this._processAgentMention(roomId, agent, msg).catch((err) => {
                logger.error(`[AgentClients] error processing mention for ${agent.name}: ${err.message}`)
            })
        }
    }

    /**
     * Process a single agent mention with status reporting and queue drain.
     */
    private async _processAgentMention(
        roomId: string,
        agent: AgentClient,
        msg: { content: string; senderName: string; senderId: string; timestamp: number },
    ): Promise<void> {
        const agentKey = `${roomId}:${agent.name}`
        if (this._processingRooms.has(agentKey)) {
            // Queue for this specific agent
            let queue = this._mentionQueue.get(agentKey)
            if (!queue) {
                queue = []
                this._mentionQueue.set(agentKey, queue)
            }
            queue.push({ agent, msg })
            logger.debug(`[AgentClients] agent ${agent.name} is processing, queued mention in room ${roomId}`)
            return
        }

        this._processingRooms.add(agentKey)
        const onStatus = (status: 'compressing' | 'replying' | 'ready') => {
            agent.emitContextStatus(roomId, status)
            logger.debug(`[AgentClients] room ${roomId} agent ${agent.name} status: ${status}`)
        }

        try {
            await agent.replyToMention(roomId, msg, onStatus)
        } finally {
            this._processingRooms.delete(agentKey)
            await this._drainQueue(agentKey, roomId)
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
        this._processingRooms.add(agentKey)
        this._processAgentMention(roomId, last.agent, last.msg).catch((err) => {
            logger.error(`[AgentClients] error processing queued mention: ${err.message}`)
        })
    }
}
