import type { StoredMessage, GatewayCaller } from './types'
import {
    buildSummarizationSystemPrompt,
    buildFullSummaryPrompt,
    buildIncrementalUpdatePrompt,
} from './prompt'
import { updateUsage } from '../../../db/hermes/usage-store'
import { logger } from '../../logger'

/**
 * Calls Hermes /v1/responses to produce LLM-generated summaries.
 * The context engine owns history assembly; Responses storage/chaining is not used.
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
        const history: Array<{ role: string; content: string }> = messages.map(m => ({
            role: 'user',
            content: `[${m.senderName}]: ${m.content}`,
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

        const res = await fetch(`${upstream.replace(/\/$/, '')}/v1/responses`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            },
            body: JSON.stringify({
                input: userPrompt,
                instructions: systemPrompt || buildSummarizationSystemPrompt(),
                conversation_history: history,
                stream: true,
                store: false,
            }),
            signal: AbortSignal.timeout(this.timeoutMs),
        })

        if (!res.ok) {
            throw new Error(`Summarization response failed: ${res.status}`)
        }
        if (!res.body) {
            throw new Error('Summarization response stream missing')
        }

        let output = ''
        for await (const frame of readSseFrames(res.body)) {
            let parsed: any
            try {
                parsed = JSON.parse(frame.data)
            } catch {
                continue
            }
            const eventType = parsed.type || frame.event || parsed.event

            if (eventType === 'response.output_text.delta' && parsed.delta) {
                output += parsed.delta
                continue
            }

            if (eventType === 'response.completed') {
                const response = parsed.response || parsed
                const finalText = extractResponseText(response)
                if (!output && finalText) output = finalText

                const usage = response.usage || {}
                updateUsage(roomId, {
                    inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
                    outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
                    cacheReadTokens: usage.cache_read_tokens ?? usage.cacheReadTokens ?? 0,
                    cacheWriteTokens: usage.cache_write_tokens ?? usage.cacheWriteTokens ?? 0,
                    reasoningTokens: usage.reasoning_tokens ?? usage.reasoningTokens ?? 0,
                    model: response.model || '',
                    profile,
                })
                logger.debug(`[GatewaySummarizer] Recorded response usage for compression room ${roomId} (profile=${profile}): input=${usage.input_tokens ?? 0}, output=${usage.output_tokens ?? 0}`)

                if (!output || output.trim() === '') {
                    throw new Error('Empty summarization response')
                }
                return { summary: output.trim(), sessionId: '' }
            }

            if (eventType === 'response.failed') {
                throw new Error(parsed.error?.message || parsed.error || 'Summarization response failed')
            }
        }

        throw new Error('Summarization response stream ended without a terminal event')
    }
}

async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let buffer = ''

    try {
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let boundary = buffer.indexOf('\n\n')
            while (boundary >= 0) {
                const raw = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const frame = parseSseFrame(raw)
                if (frame?.data) yield frame
                boundary = buffer.indexOf('\n\n')
            }
        }

        buffer += decoder.decode()
        const frame = parseSseFrame(buffer)
        if (frame?.data) yield frame
    } finally {
        reader.releaseLock()
    }
}

function parseSseFrame(raw: string): { event?: string; data: string } | null {
    let event: string | undefined
    const data: string[] = []
    for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
            event = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart())
        }
    }
    if (data.length === 0) return null
    return { event, data: data.join('\n') }
}

function extractResponseText(response: any): string {
    const output = Array.isArray(response?.output) ? response.output : []
    const parts: string[] = []
    for (const item of output) {
        if (item.type !== 'message') continue
        const content = Array.isArray(item.content) ? item.content : []
        for (const part of content) {
            if (part.type === 'output_text' || part.type === 'text') {
                parts.push(part.text || '')
            }
        }
    }
    if (parts.length > 0) return parts.join('')
    return typeof response?.output_text === 'string' ? response.output_text : ''
}
