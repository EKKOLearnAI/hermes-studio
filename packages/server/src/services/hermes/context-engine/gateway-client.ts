import { EventSource } from 'eventsource'
import type { StoredMessage, GatewayCaller } from './types'
import {
    buildSummarizationSystemPrompt,
    buildFullSummaryPrompt,
    buildIncrementalUpdatePrompt,
} from './prompt'

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
            const output = await this.pollForResult(upstream, apiKey, run_id)
            return { summary: output, sessionId }
        } finally {
            // Note: session cleanup is handled by the caller (compressor.ts)
        }
    }

    private pollForResult(upstream: string, apiKey: string | null, runId: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                source.close()
                reject(new Error('Summarization timed out'))
            }, this.timeoutMs)

            const eventsUrl = new URL(`${upstream}/v1/runs/${runId}/events`)
            if (apiKey) eventsUrl.searchParams.set('token', apiKey)

            const source = new EventSource(eventsUrl.toString())

            source.onmessage = (event: MessageEvent) => {
                try {
                    const parsed = JSON.parse(event.data)
                    if (parsed.event === 'run.completed') {
                        clearTimeout(timer)
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
