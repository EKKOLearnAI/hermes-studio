import type {
    StoredMessage,
    CompressionConfig,
    CompressedContext,
    BuildContextInput,
    MessageFetcher,
    GatewayCaller,
    SessionCleaner,
} from './types'
import { DEFAULT_COMPRESSION_CONFIG } from './types'
import { GatewaySummarizer } from './gateway-client'
import { buildAgentInstructions, buildSummarizationSystemPrompt } from './prompt'
import { logger } from '../../../services/logger'
import { buildProjectedGroupChatHistory, projectGroupChatMessage } from '../group-chat/context-projection'
import { sliceGroupMessagesForSnapshotTail } from '../group-chat/group-message-ordering'

export class ContextEngine {
    private config: CompressionConfig
    private messageFetcher: MessageFetcher
    private gatewayCaller: GatewayCaller
    /** Per-room compression lock to prevent concurrent snapshot overwrites */
    private _compressLocks = new Map<string, Promise<void>>()
    private _upstream = ''
    private _apiKey: string | null = null

    constructor(opts: {
        config?: Partial<CompressionConfig>
        messageFetcher: MessageFetcher
        gatewayCaller?: GatewayCaller
        sessionCleaner?: SessionCleaner
    }) {
        this.config = { ...DEFAULT_COMPRESSION_CONFIG, ...opts.config }
        this.messageFetcher = opts.messageFetcher
        this.gatewayCaller = opts.gatewayCaller || new GatewaySummarizer(this.config.summarizationTimeoutMs)
        this.sessionCleaner = opts.sessionCleaner
    }

    private sessionCleaner?: SessionCleaner

    setUpstream(upstream: string, apiKey: string | null): void {
        this._upstream = upstream
        this._apiKey = apiKey
    }

    /**
     * Build context for an agent reply.
     *
     * Flow:
     * 1. Read persisted snapshot (summary + lastMessageId) from SQLite
     * 2. If snapshot exists:
     *    a. Collect new messages after lastMessageId
     *    b. Estimate tokens = summary + new messages
     *    c. Under threshold → return as-is
     *    d. Over threshold → incremental compress, update snapshot, return
     * 3. If no snapshot:
     *    a. Estimate tokens for all messages
     *    b. Under threshold → return all verbatim
     *    c. Over threshold → full compress, save snapshot, return
     */
    async buildContext(input: BuildContextInput): Promise<CompressedContext> {
        // Serialize compression per room to prevent concurrent snapshot overwrites
        const existing = this._compressLocks.get(input.roomId)
        if (existing) {
            await existing
        }
        let resolveLock!: () => void
        const lock = new Promise<void>(r => { resolveLock = r })
        this._compressLocks.set(input.roomId, lock)
        try {
            return await this._buildContextImpl(input)
        } finally {
            resolveLock()
            this._compressLocks.delete(input.roomId)
        }
    }

    private async _buildContextImpl(input: BuildContextInput): Promise<CompressedContext> {
        const config = { ...this.config, ...input.compression }
        const cursor = Math.max(0, Math.floor(Number(input.participantCursor || 0)))
        const usesParticipantSequence = input.participantCursor != null
        const triggerRoomSeq = usesParticipantSequence
            ? Math.max(0, Math.floor(Number(input.currentMessage.roomSeq || 0)))
            : 0
        const participantCheckpoint = usesParticipantSequence && input.participantCheckpoint &&
            Math.max(0, Math.floor(Number(input.participantCheckpoint.fromRoomSeq || 0))) === cursor + 1 &&
            Math.max(0, Math.floor(Number(input.participantCheckpoint.throughRoomSeq || 0))) >= Math.max(0, Math.floor(Number(input.participantCheckpoint.fromRoomSeq || 0))) &&
            Math.max(0, Math.floor(Number(input.participantCheckpoint.throughRoomSeq || 0))) < triggerRoomSeq
            ? {
                summary: String(input.participantCheckpoint.summary || '').trim(),
                fromRoomSeq: Math.max(0, Math.floor(Number(input.participantCheckpoint.fromRoomSeq || 0))),
                throughRoomSeq: Math.max(0, Math.floor(Number(input.participantCheckpoint.throughRoomSeq || 0))),
            }
            : null
        const effectiveCursor = participantCheckpoint?.summary ? participantCheckpoint.throughRoomSeq : cursor
        const allMessages = this.messageFetcher.getMessagesForContext(input.roomId, triggerRoomSeq > 0
            ? {
                throughRoomSeq: triggerRoomSeq,
                ...(effectiveCursor > 0 ? { afterRoomSeq: effectiveCursor } : {}),
            }
            : { throughMessageId: input.currentMessage.id })
        const messages = allMessages.filter((message) => {
            if (input.excludeCurrentMessageFromHistory && message.id === input.currentMessage.id) return false
            const roomSeq = Number(message.roomSeq || 0)
            if (effectiveCursor > 0 && roomSeq > 0 && roomSeq <= effectiveCursor) return false
            if (triggerRoomSeq > 0 && roomSeq > 0 && roomSeq > triggerRoomSeq) return false
            return true
        })
        const total = messages.length

        logger.debug({
            roomId: input.roomId,
            agentName: input.agentName,
            profile: input.profile || 'default',
            retainedMessages: total,
            throughMessageId: input.currentMessage.id,
        }, '[ContextEngine] buildContext start')

        const instructions = buildAgentInstructions({
            agentName: input.agentName,
            roomName: input.roomName,
            agentDescription: input.agentDescription,
            memberNames: input.memberNames,
            members: input.members,
        })

        const meta: CompressedContext['meta'] = {
            totalMessages: total,
            verbatimCount: 0,
            hadSnapshot: false,
            compressed: false,
            summaryTokenEstimate: 0,
        }

        // Participant delivery is a bounded sequence window. A shared Room snapshot may
        // summarize messages beyond that window (for example when an older queued trigger
        // runs after a newer Room compression), and legacy snapshots do not carry a
        // verifiable roomSeq anchor. Fail closed: participant windows build from their
        // explicit sequence range and never consume the shared Room snapshot.
        const snapshot = usesParticipantSequence
            ? (participantCheckpoint?.summary ? {
                roomId: input.roomId,
                summary: participantCheckpoint.summary,
                lastMessageId: `participant-checkpoint:${participantCheckpoint.throughRoomSeq}`,
                lastMessageTimestamp: 0,
                lastRoomSeq: participantCheckpoint.throughRoomSeq,
                updatedAt: Date.now(),
            } : null)
            : this.messageFetcher.getContextSnapshot(input.roomId)
        logger.debug({
            roomId: input.roomId,
            agentName: input.agentName,
            path: snapshot ? 'snapshot' : 'full',
            snapshot: snapshot ? 'hit' : 'miss',
            lastMessageId: snapshot?.lastMessageId,
            summaryChars: snapshot?.summary.length || 0,
            messageCount: total,
        }, '[ContextEngine] snapshot lookup')

        const estimateFullContextTokens = async (
            history: Array<{ role: 'user' | 'assistant'; content: string }>,
            messageTokenEstimate: number,
        ): Promise<number> => {
            const directInputTokens = Math.max(0, Math.floor(Number(input.directInputTokenEstimate) || 0))
            try {
                const estimate = await input.contextTokenEstimator?.(history, instructions)
                if (typeof estimate === 'number' && Number.isFinite(estimate) && estimate > 0) {
                    return Math.floor(estimate) + directInputTokens
                }
            } catch (err: any) {
                logger.warn(`[ContextEngine] full context estimate failed room=${input.roomId}, agent=${input.agentName}: ${err.message}`)
            }
            return messageTokenEstimate + directInputTokens
        }

        const fitCompressedHistory = async (
            summary: string,
            candidateTail: StoredMessage[],
        ): Promise<{
            history: Array<{ role: 'user' | 'assistant'; content: string }>
            retainedTail: StoredMessage[]
            contextTokens: number
        }> => {
            const retainedTail = [...candidateTail]
            let history = this.buildHistory(summary, retainedTail, input.agentId, input.agentSocketId, input.agentName)
            let historyTokens = this.estimateTokens(history)
            let contextTokens = await estimateFullContextTokens(history, historyTokens)

            while (
                (historyTokens > config.maxHistoryTokens || contextTokens > config.triggerTokens) &&
                retainedTail.length > 1
            ) {
                const sequencedIndexes = retainedTail
                    .map((message, index) => ({ index, roomSeq: Math.max(0, Number(message.roomSeq || 0)) }))
                    .filter(item => item.roomSeq > 0)
                const dropIndex = sequencedIndexes.length
                    ? sequencedIndexes.reduce((oldest, item) => item.roomSeq < oldest.roomSeq ? item : oldest).index
                    : 0
                retainedTail.splice(dropIndex, 1)
                history = this.buildHistory(summary, retainedTail, input.agentId, input.agentSocketId, input.agentName)
                historyTokens = this.estimateTokens(history)
                contextTokens = await estimateFullContextTokens(history, historyTokens)
            }

            if (historyTokens > config.maxHistoryTokens || contextTokens > config.triggerTokens) {
                throw new Error(
                    `Compressed context is still too large for group chat agent ${input.agentName}: ` +
                    `history uses ~${historyTokens}/${config.maxHistoryTokens} tokens and full context uses ` +
                    `~${contextTokens}/${config.triggerTokens} tokens after preserving the newest message.`,
                )
            }

            return { history, retainedTail, contextTokens }
        }

        const logThresholdCheck = (path: string, messageTokens: number, fullTokens: number): void => {
            meta.messageTokenEstimate = messageTokens
            meta.contextTokenEstimate = fullTokens
            logger.info({
                roomId: input.roomId,
                agentName: input.agentName,
                profile: input.profile || 'default',
                path,
                messages: total,
                messageOnlyTokens: messageTokens,
                fullContextTokens: fullTokens,
                triggerTokens: config.triggerTokens,
                decision: fullTokens > config.triggerTokens ? 'compress' : 'skip',
            }, '[ContextEngine] threshold check')
        }

        // ── Path A: Snapshot exists — incremental ────────────
        if (snapshot) {
            meta.hadSnapshot = true

            const snapshotTail = Number(snapshot.lastRoomSeq || 0) > 0
                ? {
                    messages: messages.filter(message => Number(message.roomSeq || 0) > Number(snapshot.lastRoomSeq || 0)),
                    snapshotCursorFound: true,
                }
                : sliceGroupMessagesForSnapshotTail(messages, snapshot.lastMessageId)
            const newMessages = snapshotTail.messages

            if (!snapshotTail.snapshotCursorFound) {
                logger.warn({
                    roomId: input.roomId,
                    agentName: input.agentName,
                    path: 'snapshot',
                    reason: 'snapshot_cursor_missing',
                    lastMessageId: snapshot.lastMessageId,
                    messageCount: newMessages.length,
                    preservedTailCount: newMessages.length,
                }, '[ContextEngine] snapshot cursor missing')
            }

            const summaryTokens = this.countTokens(snapshot.summary)
            const newTokens = this.estimateTokensFromMessages(newMessages)
            const messageOnlyTokens = summaryTokens + newTokens

            meta.verbatimCount = newMessages.length
            meta.summaryTokenEstimate = summaryTokens

            const snapshotHistory = this.buildHistory(snapshot.summary, newMessages, input.agentId, input.agentSocketId, input.agentName)
            const totalTokens = await estimateFullContextTokens(snapshotHistory, messageOnlyTokens)
            logThresholdCheck('snapshot', messageOnlyTokens, totalTokens)
            logger.debug({
                roomId: input.roomId,
                agentName: input.agentName,
                path: 'snapshot',
                snapshotCursorFound: snapshotTail.snapshotCursorFound,
                lastMessageId: snapshot.lastMessageId,
                messageCount: newMessages.length,
                summaryTokenEstimate: summaryTokens,
                messageTailTokenEstimate: newTokens,
                messageOnlyTokens,
                fullContextTokens: totalTokens,
                triggerTokens: config.triggerTokens,
                preservedTailCount: newMessages.length,
                decision: totalTokens <= config.triggerTokens ? 'reuse_summary' : 'incremental_compress',
            }, '[ContextEngine] snapshot path evaluated')

            // Under threshold — return summary + new messages directly.
            // If the cursor anchor was pruned, the retained transcript is our conservative
            // verbatim tail after the still-valid summary.
            if (totalTokens <= config.triggerTokens) {
                logger.debug({
                    roomId: input.roomId,
                    agentName: input.agentName,
                    path: 'snapshot',
                    messageCount: newMessages.length,
                    fullContextTokens: totalTokens,
                    preservedTailCount: newMessages.length,
                    decision: 'skip_compression',
                }, '[ContextEngine] using snapshot summary with verbatim tail')
                this.logHistory('Path A (no compress)', snapshotHistory)
                return { conversationHistory: snapshotHistory, instructions, meta }
            }

            // Over threshold — incremental compress
            const fixedContextTokens = Math.max(0, totalTokens - messageOnlyTokens)
            if (messageOnlyTokens < config.triggerTokens && fixedContextTokens >= config.triggerTokens) {
                throw new Error(
                    `Context window is too small for group chat agent ${input.agentName}: fixed prompt/tool overhead uses ~${fixedContextTokens} tokens, exceeding trigger ${config.triggerTokens}, so message compression cannot make the request fit.`,
                )
            }
            logger.info({
                roomId: input.roomId,
                agentName: input.agentName,
                path: 'snapshot',
                messageCount: newMessages.length,
                summaryTokenEstimate: summaryTokens,
                messageTailTokenEstimate: newTokens,
                messageOnlyTokens,
                fullContextTokens: totalTokens,
                triggerTokens: config.triggerTokens,
                preservedTailCount: newMessages.length,
                decision: 'incremental_compress',
            }, '[ContextEngine] compression started')
            meta.compressed = true
            input.onProgress?.({
                status: 'compressing',
                path: 'snapshot',
                messageCount: newMessages.length,
                tokenCount: totalTokens,
            })

            const t0 = Date.now()
            const result = await this.summarize(
                input.roomId,
                newMessages,
                input.upstream,
                input.apiKey,
                input.profile || 'default',
                snapshot.summary,
            )
            const elapsed = Date.now() - t0

            if (result.summary) {
                const fitted = await fitCompressedHistory(result.summary, this.latestSequenceTail(newMessages, config.tailMessageCount))
                const summaryAnchor = this.latestSequenceMessage(newMessages)

                meta.summaryTokenEstimate = this.countTokens(result.summary)
                meta.contextTokenEstimate = fitted.contextTokens
                meta.verbatimCount = fitted.retainedTail.length
                if (!usesParticipantSequence) {
                    this.messageFetcher.saveContextSnapshot(input.roomId, result.summary, summaryAnchor.id, summaryAnchor.timestamp, Number(summaryAnchor.roomSeq || 0))
                }
                logger.info({
                    roomId: input.roomId,
                    agentName: input.agentName,
                    path: 'snapshot',
                    messageCount: newMessages.length,
                    summaryTokenEstimate: meta.summaryTokenEstimate,
                    fullContextTokens: meta.contextTokenEstimate,
                    preservedTailCount: fitted.retainedTail.length,
                    savedLastMessageId: summaryAnchor.id,
                    elapsedMs: elapsed,
                }, '[ContextEngine] compression completed')
                this.logHistory('Path A (after incremental compress)', fitted.history)
                if (result.sessionId) this.sessionCleaner?.(result.sessionId)
                return { conversationHistory: fitted.history, instructions, meta }
            }

            // Compression failed — degrade
            const history = this.buildHistory(snapshot.summary, newMessages, input.agentId, input.agentSocketId, input.agentName)
            this.trimToBudget(history, summaryTokens, config.maxHistoryTokens, 2, 1)
            meta.verbatimCount = Math.max(0, history.length - 2)
            logger.warn({
                roomId: input.roomId,
                agentName: input.agentName,
                path: 'snapshot_degrade',
                reason: 'incremental_compression_failed',
                messageCount: newMessages.length,
                summaryTokenEstimate: summaryTokens,
                messageTailTokenEstimate: newTokens,
                messageOnlyTokens,
                fullContextTokens: totalTokens,
                preservedTailCount: meta.verbatimCount,
                maxHistoryTokens: config.maxHistoryTokens,
                elapsedMs: elapsed,
            }, '[ContextEngine] degraded to summary plus trimmed verbatim tail')
            return { conversationHistory: history, instructions, meta }
        }

        // ── Path B: No snapshot — full context ───────────────
        const messageOnlyTokens = this.estimateTokensFromMessages(messages)
        meta.verbatimCount = total
        const fullHistory = buildProjectedGroupChatHistory('', messages, { agentId: input.agentId, socketId: input.agentSocketId, name: input.agentName })
        const totalTokens = await estimateFullContextTokens(fullHistory, messageOnlyTokens)
        logThresholdCheck('full', messageOnlyTokens, totalTokens)

        logger.debug({
            roomId: input.roomId,
            agentName: input.agentName,
            path: 'full',
            messageCount: total,
            messageOnlyTokens,
            fullContextTokens: totalTokens,
            triggerTokens: config.triggerTokens,
            preservedTailCount: total,
            decision: totalTokens <= config.triggerTokens ? 'skip_compression' : 'full_compress',
        }, '[ContextEngine] full path evaluated')

        // Under threshold — pass all messages verbatim
        if (totalTokens <= config.triggerTokens) {
            logger.debug({
                roomId: input.roomId,
                agentName: input.agentName,
                path: 'full',
                messageCount: total,
                fullContextTokens: totalTokens,
                preservedTailCount: total,
                decision: 'skip_compression',
            }, '[ContextEngine] using full verbatim history')
            this.logHistory('Path B (no compress)', fullHistory)
            return { conversationHistory: fullHistory, instructions, meta }
        }

        // Over threshold — full compress
        const fixedContextTokens = Math.max(0, totalTokens - messageOnlyTokens)
        if (messageOnlyTokens < config.triggerTokens && fixedContextTokens >= config.triggerTokens) {
            throw new Error(
                `Context window is too small for group chat agent ${input.agentName}: fixed prompt/tool overhead uses ~${fixedContextTokens} tokens, exceeding trigger ${config.triggerTokens}, so message compression cannot make the request fit.`,
            )
        }
        logger.info({
            roomId: input.roomId,
            agentName: input.agentName,
            path: 'full',
            messageCount: total,
            messageOnlyTokens,
            fullContextTokens: totalTokens,
            triggerTokens: config.triggerTokens,
            preservedTailCount: messages.length > config.tailMessageCount ? config.tailMessageCount : 0,
            decision: 'full_compress',
        }, '[ContextEngine] compression started')
        meta.compressed = true
        input.onProgress?.({
            status: 'compressing',
            path: 'full',
            messageCount: total,
            tokenCount: totalTokens,
        })

        const t0 = Date.now()
        const result = await this.summarize(
            input.roomId,
            messages,
            input.upstream,
            input.apiKey,
            input.profile || 'default',
        )
        const elapsed = Date.now() - t0

        if (result.summary) {
            // The summary covers every message through the trigger. Recent tail messages are
            // repeated verbatim only for this turn and do not move the persisted coverage boundary.
            const candidateTail = this.latestSequenceTail(messages, config.tailMessageCount)
            const fitted = await fitCompressedHistory(result.summary, candidateTail)
            const summaryAnchor = this.latestSequenceMessage(messages)

            meta.summaryTokenEstimate = this.countTokens(result.summary)
            meta.contextTokenEstimate = fitted.contextTokens
            meta.verbatimCount = fitted.retainedTail.length
            if (!usesParticipantSequence) {
                this.messageFetcher.saveContextSnapshot(input.roomId, result.summary, summaryAnchor.id, summaryAnchor.timestamp, Number(summaryAnchor.roomSeq || 0))
            }
            logger.info({
                roomId: input.roomId,
                agentName: input.agentName,
                path: 'full',
                messageCount: total,
                compressedMessageCount: messages.length,
                preservedTailCount: fitted.retainedTail.length,
                summaryTokenEstimate: meta.summaryTokenEstimate,
                fullContextTokens: meta.contextTokenEstimate,
                savedLastMessageId: summaryAnchor.id,
                elapsedMs: elapsed,
            }, '[ContextEngine] compression completed')
            this.logHistory('Path B (after full compress)', fitted.history)
            if (result.sessionId) this.sessionCleaner?.(result.sessionId)
            return { conversationHistory: fitted.history, instructions, meta }
        }

        // Compression failed — degrade
        const history = buildProjectedGroupChatHistory('', messages, { agentId: input.agentId, socketId: input.agentSocketId, name: input.agentName })
        this.trimToBudget(history, 0, config.maxHistoryTokens, 0, 1)
        meta.verbatimCount = history.length
        logger.warn({
            roomId: input.roomId,
            agentName: input.agentName,
            path: 'full_degrade',
            reason: 'full_compression_failed',
            messageCount: total,
            messageOnlyTokens,
            fullContextTokens: totalTokens,
            preservedTailCount: history.length,
            maxHistoryTokens: config.maxHistoryTokens,
            elapsedMs: elapsed,
        }, '[ContextEngine] degraded to trimmed verbatim history')
        return { conversationHistory: history, instructions, meta }
    }

    async summarizeParticipantRange(
        roomId: string,
        profile: string,
        messages: StoredMessage[],
        previousSummary?: string,
    ): Promise<string | null> {
        if (messages.length === 0) return previousSummary || null
        const chunks: StoredMessage[][] = []
        let chunk: StoredMessage[] = []
        let chunkTokens = 0
        const maxChunkTokens = Math.max(1, this.config.maxHistoryTokens)
        for (const message of messages) {
            const messageTokens = Math.max(1, this.estimateTokensFromMessages([message]))
            if (chunk.length > 0 && chunkTokens + messageTokens > maxChunkTokens) {
                chunks.push(chunk)
                chunk = []
                chunkTokens = 0
            }
            chunk.push(message)
            chunkTokens += messageTokens
        }
        if (chunk.length > 0) chunks.push(chunk)

        let summary = previousSummary || undefined
        for (const messageChunk of chunks) {
            const result = await this.summarize(
                roomId,
                messageChunk,
                this._upstream,
                this._apiKey,
                profile,
                summary,
            )
            if (result.sessionId) this.sessionCleaner?.(result.sessionId)
            if (!result.summary) return null
            summary = result.summary
        }
        return summary || null
    }

    invalidateRoom(roomId: string): void {
        this.messageFetcher.deleteContextSnapshot(roomId)
    }

    /**
     * Force compress all messages in a room (full compression).
     * Used when user manually triggers compression.
     */
    async forceCompress(roomId: string, profile?: string): Promise<string> {
        const allMessages = this.messageFetcher.getMessagesForContext(roomId)
        if (allMessages.length === 0) return ''

        const config = { ...this.config }
        logger.debug(`[ContextEngine] forceCompress room=${roomId}, messages=${allMessages.length}`)

        const t0 = Date.now()
        const result = await this.summarize(roomId, allMessages, this._upstream, this._apiKey, profile || 'default')
        const elapsed = Date.now() - t0

        if (result.summary) {
            const summaryAnchor = this.latestSequenceMessage(allMessages)

            this.messageFetcher.saveContextSnapshot(
                roomId,
                result.summary,
                summaryAnchor.id,
                summaryAnchor.timestamp,
                Number(summaryAnchor.roomSeq || 0),
            )
            logger.debug(`[ContextEngine] forceCompress DONE in ${elapsed}ms`)
            if (result.sessionId) this.sessionCleaner?.(result.sessionId)
            return result.summary
        }

        throw new Error('Compression failed')
    }

    // ─── Private ─────────────────────────────────────────────

    private latestSequenceTail(messages: StoredMessage[], count: number): StoredMessage[] {
        const limit = Math.max(1, Math.floor(Number(count) || 0))
        const sequenced = messages.filter(message => Number(message.roomSeq || 0) > 0)
        if (sequenced.length === 0) return messages.slice(-limit)
        const selectedIds = new Set(
            [...sequenced]
                .sort((left, right) => Number(right.roomSeq || 0) - Number(left.roomSeq || 0))
                .slice(0, limit)
                .map(message => message.id),
        )
        return messages.filter(message => selectedIds.has(message.id))
    }

    private latestSequenceMessage(messages: StoredMessage[]): StoredMessage {
        if (messages.length === 0) throw new Error('Cannot anchor an empty Group Chat summary')
        return messages.reduce((latest, message) => {
            const latestSeq = Math.max(0, Math.floor(Number(latest.roomSeq || 0)))
            const messageSeq = Math.max(0, Math.floor(Number(message.roomSeq || 0)))
            if (messageSeq > latestSeq) return message
            if (messageSeq === latestSeq && message.timestamp > latest.timestamp) return message
            return latest
        })
    }

    /**
     * Build history array: optional summary prefix + verbatim messages.
     */
    private buildHistory(
        summary: string,
        messages: StoredMessage[],
        agentId: string,
        agentSocketId: string,
        agentName: string,
    ): Array<{ role: 'user' | 'assistant'; content: string }> {
        return buildProjectedGroupChatHistory(summary, messages, { agentId, socketId: agentSocketId, name: agentName })
    }

    /**
     * Summarize messages. If previousSummary is provided, do incremental update.
     */
    private async summarize(
        roomId: string,
        messages: StoredMessage[],
        upstream: string,
        apiKey: string | null,
        profile: string,
        previousSummary?: string,
    ): Promise<{ summary: string | null; sessionId: string | null }> {
        if (messages.length === 0 && !previousSummary) return { summary: null, sessionId: null }

        try {
            const result = await this.gatewayCaller.summarize(
                upstream,
                apiKey,
                buildSummarizationSystemPrompt(),
                messages,
                roomId,
                profile,
                previousSummary,
            )
            return { summary: result.summary, sessionId: result.sessionId }
        } catch (err: any) {
            logger.warn(`[ContextEngine] Summarization failed for room ${roomId}: ${err.message}`)
            return { summary: null, sessionId: null }
        } finally {
            // Session cleanup handled here if sessionCleaner is provided
        }
    }

    private mapToHistory(
        msg: StoredMessage,
        agentId: string,
        agentSocketId: string,
        agentName: string,
    ): { role: 'user' | 'assistant'; content: string } {
        return projectGroupChatMessage(msg, { agentId, socketId: agentSocketId, name: agentName })
    }

    private trimToBudget(
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
        summaryTokens: number,
        maxTokens: number,
        protectedPrefixCount: number,
        minimumVerbatimCount: number,
    ): void {
        const minimumHistoryLength = history.length <= protectedPrefixCount
            ? history.length
            : Math.min(history.length, protectedPrefixCount + Math.max(0, minimumVerbatimCount))
        let totalTokens = summaryTokens + this.estimateTokens(history)
        while (totalTokens > maxTokens && history.length > minimumHistoryLength) {
            history.splice(protectedPrefixCount, 1)
            totalTokens = summaryTokens + this.estimateTokens(history)
        }
    }

    private estimateTokens(history: Array<{ role: string; content: string }>): number {
        const text = history.map(m => m.content).join('')
        return this.countTokens(text)
    }

    private estimateTokensFromMessages(messages: StoredMessage[]): number {
        const text = messages.map(m => m.content).join('')
        return this.countTokens(text)
    }

    /** Estimate tokens distinguishing CJK (~1.5 tok/char) from Latin (config.charsPerToken per char) */
    private countTokens(text: string): number {
        const cjk = (text.match(/[\u2e80-\u9fff\uac00-\ud7af\u3000-\u303f\uff00-\uffef]/g) || []).length
        const other = text.length - cjk
        return Math.ceil(cjk * 1.5 + other / this.config.charsPerToken)
    }

    /** Log assembled history for debugging without persisting message bodies */
    private logHistory(label: string, history: Array<{ role: string; content: string }>): void {
        const totalTokens = this.estimateTokens(history)
        const roleCounts = history.reduce<Record<string, number>>((acc, entry) => {
            acc[entry.role] = (acc[entry.role] || 0) + 1
            return acc
        }, {})
        const charCounts = history.map((entry) => entry.content.length)
        logger.debug({
            label,
            entryCount: history.length,
            totalTokens,
            roleCounts,
            minChars: charCounts.length ? Math.min(...charCounts) : 0,
            maxChars: charCounts.length ? Math.max(...charCounts) : 0,
            tailEntryChars: charCounts.slice(-3),
        }, '[ContextEngine] assembled history')
    }
}
