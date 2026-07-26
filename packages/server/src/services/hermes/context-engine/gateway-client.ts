import type { StoredMessage, GatewayCaller, GatewaySessionLease } from './types'
import {
    buildSummarizationSystemPrompt,
    buildFullSummaryPrompt,
    buildIncrementalUpdatePrompt,
} from './prompt'
import { logger } from '../../logger'
import { AgentBridgeClient, type AgentBridgeRunResult } from '../agent-bridge'

/**
 * Calls the local bridge to produce LLM-generated summaries.
 * The context engine owns history assembly; gateway storage/chaining is not used.
 */
export class GatewaySummarizer implements GatewayCaller {
    private timeoutMs: number

    constructor(timeoutMs = 30_000) {
        this.timeoutMs = timeoutMs
    }

    async summarize(
        _upstream: string,
        _apiKey: string | null,
        systemPrompt: string,
        messages: StoredMessage[],
        roomId: string,
        profile: string,
        previousSummary: string | undefined,
        sessionRegistrar: () => GatewaySessionLease,
    ): Promise<{ summary: string; sessionId: string }> {
        const registeredSession = sessionRegistrar()
        try {
            if (!/^gc_h_[0-9a-f]{32}$/.test(registeredSession.sessionId)) {
                throw new Error('Registered group chat summary session ID is invalid')
            }
            assertGatewaySessionLeaseCurrent(registeredSession)

            const history: Array<{ role: string; content: string }> = messages.map(m => ({
                role: 'user',
                content: summarizeMessageForPrompt(m),
            }))

            if (previousSummary) {
                history.unshift(
                    { role: 'user', content: `[Previous summary]\n${previousSummary}` },
                    { role: 'assistant', content: 'Understood, I will update the summary.' },
                )
            }

            const userPrompt = previousSummary
                ? buildIncrementalUpdatePrompt()
                : buildFullSummaryPrompt()

            const bridge = new AgentBridgeClient({ timeoutMs: this.timeoutMs + 15_000 })
            const sessionId = registeredSession.sessionId
            assertGatewaySessionLeaseCurrent(registeredSession)
            const result = await bridge.request<AgentBridgeRunResult>({
                action: 'chat',
                session_id: sessionId,
                message: userPrompt,
                instructions: systemPrompt || buildSummarizationSystemPrompt(),
                conversation_history: history,
                profile,
                source: 'api_server',
                wait: true,
                timeout: Math.ceil(this.timeoutMs / 1000),
            }, { timeoutMs: this.timeoutMs + 15_000 })
            assertGatewaySessionLeaseCurrent(registeredSession)

            if (result.status === 'error') {
                throw new Error(result.error || 'Summarization bridge run failed')
            }

            const payload = result.result as any
            const output = String(payload?.final_response || result.output || '').trim()
            if (!output) throw new Error('Empty summarization response')

            logger.debug(`[GatewaySummarizer] Bridge compression completed for room ${roomId} (profile=${profile})`)
            return { summary: output, sessionId }
        } finally {
            try {
                registeredSession.release()
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : 'unknown error'
                logger.warn(`[GatewaySummarizer] Failed to activate durable cleanup for registered summary session: ${message}`)
            }
        }
    }
}

function assertGatewaySessionLeaseCurrent(lease: GatewaySessionLease): void {
    try {
        if (lease.authorizationGuard()) return
    } catch {
        // Guard/storage failures are authorization failures.
    }
    throw new Error('Group chat summary session authorization changed')
}

function summarizeMessageForPrompt(message: StoredMessage): string {
    if (message.role === 'tool') {
        const label = message.tool_name ? `Tool result: ${message.tool_name}` : 'Tool result'
        return `[${label}]\n${message.content || ''}`
    }

    if (message.role === 'assistant' && message.tool_calls?.length) {
        const toolsInfo = message.tool_calls.map(tc => {
            const name = tc.function?.name || 'tool'
            const args = tc.function?.arguments || '{}'
            return `${name}(${args})`
        }).join(', ')
        const content = message.content?.trim()
        return `[${message.senderName}]: ${content ? `${content}\n` : ''}[Tool calls: ${toolsInfo}]`
    }

    return `[${message.senderName}]: ${message.content}`
}
