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
        const allMessages = this.messageFetcher.getMessages(input.roomId)
        // Filter out messages newer than the current one
        const messages = allMessages.filter(m => m.timestamp <= input.currentMessage.timestamp)
        const total = messages.length

        logger.debug(`[ContextEngine] buildContext START — room=${input.roomId}, agent=${input.agentName}, totalMessagesInDb=${allMessages.length}, afterFilter=${total}`)

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

        const snapshot = this.messageFetcher.getContextSnapshot(input.roomId)
        logger.debug(`[ContextEngine] snapshot=${snapshot ? `EXISTS (lastMsgId=${snapshot.lastMessageId}, summaryLen=${snapshot.summary.length})` : 'NONE'}`)

        // ── Path A: Snapshot exists — incremental ────────────
        if (snapshot) {
            meta.hadSnapshot = true

            // Find the position of lastMessageId in messages
            const snapshotIdx = messages.findIndex(m => m.id === snapshot.lastMessageId)
            // Collect messages after the snapshot position
            const newMessages = snapshotIdx >= 0
                ? messages.slice(snapshotIdx + 1)
                : messages.filter(m => m.timestamp > snapshot.lastMessageTimestamp)

            const summaryTokens = this.countTokens(snapshot.summary)
            const newTokens = this.estimateTokensFromMessages(newMessages)
            const totalTokens = summaryTokens + newTokens

            meta.verbatimCount = newMessages.length
            meta.summaryTokenEstimate = summaryTokens

            logger.debug(`[ContextEngine] [Path A] snapshotIdx=${snapshotIdx}, newMessages=${newMessages.length}, summaryTokens=~${summaryTokens}, newTokens=~${newTokens}, totalTokens=~${totalTokens}, threshold=${config.triggerTokens}`)
            logger.debug(`[ContextEngine] [Path A] EXISTING SUMMARY (${snapshot.summary.length} chars): ${snapshot.summary.slice(0, 300)}`)
            if (newMessages.length > 0) {
                logger.debug(`[ContextEngine] [Path A] NEW MESSAGES (${newMessages.length}): ${newMessages.map(m => `[${m.senderName}]: ${m.content.slice(0, 80)}`).join(' | ')}`)
            }

            // Under threshold — return summary + new messages directly
            if (totalTokens <= config.triggerTokens) {
                logger.debug(`[ContextEngine] [Path A] UNDER threshold — return summary + ${newMessages.length} verbatim msgs directly`)
                const history = this.buildHistory(snapshot.summary, newMessages, input.agentSocketId)
                this.logHistory('Path A (no compress)', history)
                return { conversationHistory: history, instructions, meta }
            }

            // Over threshold — incremental compress
            logger.debug(`[ContextEngine] [Path A] OVER threshold — starting INCREMENTAL compression of ${newMessages.length} msgs...`)
            logger.debug(`[ContextEngine] [Path A] CONTEXT BEFORE COMPRESSION: summary(${snapshot.summary.length} chars) + ${newMessages.length} new msgs`)
            meta.compressed = true

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
                const lastMsg = newMessages[newMessages.length - 1]
                this.messageFetcher.saveContextSnapshot(input.roomId, result.summary, lastMsg.id, lastMsg.timestamp)

                meta.summaryTokenEstimate = this.countTokens(result.summary)
                logger.debug(`[ContextEngine] [Path A] incremental compression DONE in ${elapsed}ms, newSummaryLen=${result.summary.length}, newLastMsgId=${lastMsg.id}`)
                logger.debug(`[ContextEngine] [Path A] NEW SUMMARY (${result.summary.length} chars): ${result.summary.slice(0, 300)}`)
                const history = this.buildHistory(result.summary, newMessages, input.agentSocketId)
                this.logHistory('Path A (after incremental compress)', history)
                if (result.sessionId) this.sessionCleaner?.(result.sessionId)
                return { conversationHistory: history, instructions, meta }
            }

            // Compression failed — degrade
            logger.warn(`[ContextEngine] [Path A] incremental compression FAILED (${elapsed}ms) — degrading to summary + trimmed verbatim`)
            const history = this.buildHistory(snapshot.summary, newMessages, input.agentSocketId)
            this.trimToBudget(history, summaryTokens, config.maxHistoryTokens)
            return { conversationHistory: history, instructions, meta }
        }

        // ── Path B: No snapshot — full context ───────────────
        const totalTokens = this.estimateTokensFromMessages(messages)
        meta.verbatimCount = total

        logger.debug(`[ContextEngine] [Path B] no snapshot, totalMessages=${total}, totalTokens=~${totalTokens}, threshold=${config.triggerTokens}`)

        // Under threshold — pass all messages verbatim
        if (totalTokens <= config.triggerTokens) {
            logger.debug(`[ContextEngine] [Path B] UNDER threshold — return all ${total} msgs verbatim`)
            const history = messages.map(m => this.mapToHistory(m, input.agentSocketId))
            this.logHistory('Path B (no compress)', history)
            return { conversationHistory: history, instructions, meta }
        }

        // Over threshold — full compress
        logger.debug(`[ContextEngine] [Path B] OVER threshold — starting FULL compression of ${total} msgs...`)
        logger.debug(`[ContextEngine] [Path B] CONTEXT BEFORE COMPRESSION: ${total} msgs, ~${totalTokens} tokens`)
        meta.compressed = true

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
            // Keep recent tail messages verbatim, compress the rest
            const { tailMessageCount } = config
            const toCompress = messages.length > tailMessageCount ? messages.slice(0, -tailMessageCount) : messages
            const tail = messages.length > tailMessageCount ? messages.slice(-tailMessageCount) : []
            const lastCompressedMsg = toCompress[toCompress.length - 1]

            this.messageFetcher.saveContextSnapshot(input.roomId, result.summary, lastCompressedMsg.id, lastCompressedMsg.timestamp)

            meta.summaryTokenEstimate = this.countTokens(result.summary)
            logger.debug(`[ContextEngine] [Path B] full compression DONE in ${elapsed}ms, summaryLen=${result.summary.length}, compressed=${toCompress.length} msgs, keptTail=${tail.length} msgs, savedLastMsgId=${lastCompressedMsg.id}`)
            logger.debug(`[ContextEngine] [Path B] COMPRESSED SUMMARY (${result.summary.length} chars): ${result.summary.slice(0, 300)}`)
            const history = this.buildHistory(result.summary, tail, input.agentSocketId)
            this.logHistory('Path B (after full compress)', history)
            if (result.sessionId) this.sessionCleaner?.(result.sessionId)
            return { conversationHistory: history, instructions, meta }
        }

        // Compression failed — degrade
        logger.warn(`[ContextEngine] [Path B] full compression FAILED (${elapsed}ms) — degrading to trimmed verbatim`)
        const history = messages.map(m => this.mapToHistory(m, input.agentSocketId))
        this.trimToBudget(history, 0, config.maxHistoryTokens)
        meta.verbatimCount = history.length
        return { conversationHistory: history, instructions, meta }
    }

    invalidateRoom(roomId: string): void {
        this.messageFetcher.deleteContextSnapshot(roomId)
    }

    /**
     * Force compress all messages in a room (full compression).
     * Used when user manually triggers compression.
     */
    async forceCompress(roomId: string, profile?: string): Promise<string> {
        const allMessages = this.messageFetcher.getMessages(roomId)
        if (allMessages.length === 0) return ''

        const config = { ...this.config }
        logger.debug(`[ContextEngine] forceCompress room=${roomId}, messages=${allMessages.length}`)

        const t0 = Date.now()
        const result = await this.summarize(roomId, allMessages, this._upstream, this._apiKey, profile || 'default')
        const elapsed = Date.now() - t0

        if (result.summary) {
            const { tailMessageCount } = config
            const toCompress = allMessages.length > tailMessageCount ? allMessages.slice(0, -tailMessageCount) : allMessages
            const lastCompressedMsg = toCompress[toCompress.length - 1]

            this.messageFetcher.saveContextSnapshot(roomId, result.summary, lastCompressedMsg.id, lastCompressedMsg.timestamp)
            logger.debug(`[ContextEngine] forceCompress DONE in ${elapsed}ms`)
            if (result.sessionId) this.sessionCleaner?.(result.sessionId)
            return result.summary
        }

        throw new Error('Compression failed')
    }

    // ─── Private ─────────────────────────────────────────────

    /**
     * Build history array: optional summary prefix + verbatim messages.
     */
    private buildHistory(
        summary: string,
        messages: StoredMessage[],
        agentSocketId: string,
    ): Array<{ role: 'user' | 'assistant'; content: string }> {
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = []

        if (summary) {
            history.push(
                { role: 'user', content: '[Previous conversation summary]\n' + summary },
                { role: 'assistant', content: 'I have reviewed the conversation history and understand the context.' },
            )
        }

        history.push(...messages.map(m => this.mapToHistory(m, agentSocketId)))
        return history
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
        agentSocketId: string,
    ): { role: 'user' | 'assistant'; content: string } {
        if (msg.senderId === agentSocketId) {
            return { role: 'assistant', content: msg.content }
        }
        return { role: 'user', content: `[${msg.senderName}]: ${msg.content}` }
    }

    private trimToBudget(
        history: Array<{ role: 'user' | 'assistant'; content: string }>,
        summaryTokens: number,
        maxTokens: number,
    ): void {
        let totalTokens = summaryTokens + this.estimateTokens(history)
        while (totalTokens > maxTokens && history.length > 0) {
            history.pop()
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

    /** Log assembled history for debugging */
    private logHistory(label: string, history: Array<{ role: string; content: string }>): void {
        const totalTokens = this.estimateTokens(history)
        logger.debug(`[ContextEngine] ASSEMBLED HISTORY (${label}): ${history.length} entries, ~${totalTokens} tokens`)
        for (const entry of history) {
            const preview = entry.content.length > 150 ? entry.content.slice(0, 150) + '...' : entry.content
            logger.debug(`  [${entry.role}] ${preview}`)
        }
    }
}
