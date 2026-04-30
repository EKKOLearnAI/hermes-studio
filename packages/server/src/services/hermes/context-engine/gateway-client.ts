import { EventSource } from 'eventsource'
import type { StoredMessage, GatewayCaller } from './types'
import {
    buildSummarizationSystemPrompt,
    buildFullSummaryPrompt,
    buildIncrementalUpdatePrompt,
} from './prompt'
import { updateUsage } from '../../../db/hermes/usage-store'
import { getSessionDetailFromDbWithProfile } from '../../../db/hermes/sessions-db'
import { logger } from '../../logger'

/**
 * Calls Hermes /v1/runs to produce LLM-generated summaries.
 * Uses non-streaming EventSource to wait for run.completed.
 */
export class GatewaySummarizer implements GatewayCaller {
    private timeoutMs: number

    constructor(timeoutMs = 30_000) {
        this.timeoutMs = timeoutMs
    }

    async summarize(
        upstream: string,
        apiKey: string | null,
        systemPrompt: string,
        messages: StoredMessage[],
        roomId: string,
        profile: string,
        previousSummary?: string,
    ): Promise<{ summary: string; sessionId: string }> {
        // Build conversation_history from messages
        const history: Array<{ role: string; content: string }> = messages.map(m => ({
            role: 'user',
            content: `[${m.senderName}]: ${m.content}`,
        }))

        // Inject previous summary for incremental update
        if (previousSummary) {
            history.unshift(
                { role: 'user', content: `[Previous summary]\n${previousSummary}` },
                { role: 'assistant', content: 'Understood, I will update the summary.' },
            )
        }

        const userPrompt = previousSummary
            ? buildIncrementalUpdatePrompt()
            : buildFullSummaryPrompt()

        const sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

        // POST /v1/runs
        const res = await fetch(`${upstream}/v1/runs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                input: userPrompt,
                instructions: systemPrompt || buildSummarizationSystemPrompt(),
                conversation_history: history,
                session_id: sessionId,
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
        })

        if (!res.ok) {
            throw new Error(`Summarization run failed: ${res.status}`)
        }

        const { run_id } = await res.json() as { run_id: string }

        try {
            const output = await this.pollForResult(upstream, apiKey, run_id, sessionId, roomId, profile)
            return { summary: output, sessionId }
        } finally {
            // Note: session cleanup is handled by the caller (compressor.ts)
        }
    }

    private pollForResult(upstream: string, apiKey: string | null, runId: string, sessionId: string, roomId: string, profile: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                source.close()
                reject(new Error('Summarization timed out'))
            }, this.timeoutMs)

            const eventsUrl = new URL(`${upstream}/v1/runs/${runId}/events`)

            // Use Authorization header instead of query parameter for better compatibility
            const eventSourceInit: any = apiKey ? {
                fetch: (url: string, init: any = {}) => fetch(url, {
                  ...init,
                  headers: {
                    ...(init.headers || {}),
                    Authorization: `Bearer ${apiKey}`,
                  },
                }),
              } : {}

            // @ts-ignore - eventsource library types are too strict
            const source = new EventSource(eventsUrl.toString(), eventSourceInit)

            source.onmessage = async (event: MessageEvent) => {
                try {
                    const parsed = JSON.parse(event.data)
                    if (parsed.event === 'run.completed') {
                        clearTimeout(timer)

                        // Record usage data from Hermes state.db BEFORE closing source
                        // This ensures we fetch usage before sessionCleaner can delete it
                        try {
                            const detail = await getSessionDetailFromDbWithProfile(sessionId, profile)
                            if (detail) {
                                updateUsage(roomId, {
                                    inputTokens: detail.input_tokens,
                                    outputTokens: detail.output_tokens,
                                    cacheReadTokens: detail.cache_read_tokens,
                                    cacheWriteTokens: detail.cache_write_tokens,
                                    reasoningTokens: detail.reasoning_tokens,
                                    model: detail.model,
                                    profile,
                                })
                                logger.debug(`[GatewaySummarizer] Recorded usage for compression room ${roomId} (session ${sessionId}, profile=${profile}): input=${detail.input_tokens}, output=${detail.output_tokens}`)
                            } else {
                                logger.warn(`[GatewaySummarizer] Failed to get session detail for ${sessionId} (profile=${profile})`)
                            }
                        } catch (err: any) {
                            logger.warn(err, '[GatewaySummarizer] Failed to record usage from DB')
                        }

                        source.close()

                        const output = parsed.output
                        if (!output || typeof output !== 'string' || output.trim() === '') {
                            reject(new Error('Empty summarization response'))
                            return
                        }
                        resolve(output.trim())
                    } else if (parsed.event === 'run.failed') {
                        clearTimeout(timer)
                        source.close()
                        reject(new Error(parsed.error || 'Summarization run failed'))
                    }
                } catch { /* ignore parse errors for non-JSON events */ }
            }

            source.onerror = () => {
                clearTimeout(timer)
                source.close()
                reject(new Error('Summarization SSE connection error'))
            }
        })
    }

}
