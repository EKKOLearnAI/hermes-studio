import { startRunViaSocket, type RunEvent, type StartRunRequest } from './chat'
import { transcribeSpeech } from './stt'
import type { StoredSttProvider } from './stt-settings'
import { synthesizeSpeech, type TtsProviderId } from './tts'

export type McuInteractionStatus =
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'clearing'
  | 'tool'
  | 'speaking'
  | 'completed'
  | 'failed'
  | 'aborted'

export interface McuStatusEvent {
  type: 'interaction.status'
  interactionId: string
  status: McuInteractionStatus
  text?: string
}

export interface McuToolEvent {
  type: 'tool.started' | 'tool.completed'
  interactionId: string
  tool: string
  preview?: string
  error?: string
}

export interface McuAudioSegment {
  interactionId: string
  segmentId: string
  text: string
  audio: Blob
  mimeType: string
  engine: string
  provider: string
}

export interface McuInteractionTransport {
  clearAudio: (interactionId: string) => void | Promise<void>
  send: (event: McuStatusEvent | McuToolEvent) => void | Promise<void>
  enqueueAudio: (segment: McuAudioSegment) => void | Promise<void>
}

export interface McuSpeechSegmenter {
  pushDelta: (delta: string) => string[]
  flush: () => string | null
  reset: () => void
}

export interface McuSpeechSegmenterOptions {
  maxChars?: number
}

export interface StartMcuVoiceInteractionOptions {
  audio: Blob
  sttProvider: StoredSttProvider
  ttsProvider: TtsProviderId
  transport: McuInteractionTransport
  sessionId?: string
  profile?: string
  language?: string
  prompt?: string
  run?: Omit<StartRunRequest, 'input' | 'session_id' | 'profile'>
  ttsOptions?: Record<string, unknown>
  deps?: Partial<McuInteractionDependencies>
}

export interface McuInteractionHandle {
  interactionId: string
  done: Promise<void>
  abort: () => void
}

interface McuInteractionDependencies {
  startRun: typeof startRunViaSocket
  transcribe: typeof transcribeSpeech
  synthesize: typeof synthesizeSpeech
  makeInteractionId: () => string
}

const PARAGRAPH_END_RE = /[。！？!?.…][\s"'”’）)\]】》]*$/

const defaultDeps: McuInteractionDependencies = {
  startRun: startRunViaSocket,
  transcribe: transcribeSpeech,
  synthesize: synthesizeSpeech,
  makeInteractionId: () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
    return `mcu-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  },
}

function normalizeSpeechText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function paragraphEndsNormally(text: string): boolean {
  return PARAGRAPH_END_RE.test(text.trimEnd())
}

function findReadyParagraphBoundary(text: string): number {
  let inFence = false
  let inInlineCode = false
  let inLinkText = false
  let inLinkUrl = false
  let inUrl = false

  for (let i = 0; i < text.length; i += 1) {
    const rest = text.slice(i)

    if (rest.startsWith('```')) {
      inFence = !inFence
      i += 2
      continue
    }

    if (inFence) continue

    const char = text[i]

    if (char === '`') {
      inInlineCode = !inInlineCode
      continue
    }
    if (inInlineCode) continue

    if (inLinkUrl) {
      if (char === ')') inLinkUrl = false
      continue
    }

    if (inUrl) {
      if (/\s/.test(char)) inUrl = false
      else continue
    }

    if (rest.startsWith('http://') || rest.startsWith('https://') || rest.startsWith('www.')) {
      inUrl = true
      if (rest.startsWith('https://')) i += 7
      else if (rest.startsWith('http://')) i += 6
      else i += 3
      continue
    }
    if (inLinkText) {
      if (char === ']' && text[i + 1] === '(') {
        inLinkText = false
        inLinkUrl = true
        i += 1
      }
      continue
    }
    if (char === '[') {
      inLinkText = true
      continue
    }

    if (char === '\n' || char === '\r') {
      let end = i + 1
      if (char === '\r' && text[i + 1] === '\n') {
        end += 1
        i += 1
      }
      if (paragraphEndsNormally(text.slice(0, end))) return end
    }
  }

  return -1
}

export function createMcuSpeechSegmenter(options: McuSpeechSegmenterOptions = {}): McuSpeechSegmenter {
  void options
  let buffer = ''

  function takeReadySegments(force = false): string[] {
    const segments: string[] = []

    while (buffer.length > 0) {
      let end = findReadyParagraphBoundary(buffer)

      if (end < 0) {
        if (!force) break
        end = buffer.length
      }

      const segment = normalizeSpeechText(buffer.slice(0, end))
      buffer = buffer.slice(end)

      if (segment) {
        segments.push(segment)
      }
    }

    return segments
  }

  return {
    pushDelta(delta: string): string[] {
      if (!delta) return []
      buffer += delta
      return takeReadySegments(false)
    },
    flush(): string | null {
      const segments = takeReadySegments(true)
      return segments.length ? segments.join(' ') : null
    },
    reset(): void {
      buffer = ''
    },
  }
}

export function mcuEventsFromRunEvent(event: RunEvent, interactionId: string): Array<McuStatusEvent | McuToolEvent> {
  if (event.event === 'run.started') {
    return [{ type: 'interaction.status', interactionId, status: 'thinking' }]
  }

  if (event.event === 'tool.started') {
    return [
      {
        type: 'interaction.status',
        interactionId,
        status: 'tool',
        text: event.tool || event.name || 'tool',
      },
      {
        type: 'tool.started',
        interactionId,
        tool: event.tool || event.name || 'tool',
        preview: event.preview,
      },
    ]
  }

  if (event.event === 'tool.completed') {
    return [
      {
        type: 'tool.completed',
        interactionId,
        tool: event.tool || event.name || 'tool',
        preview: event.preview,
        error: event.error,
      },
      { type: 'interaction.status', interactionId, status: 'thinking' },
    ]
  }

  if (event.event === 'run.failed') {
    return [{
      type: 'interaction.status',
      interactionId,
      status: 'failed',
      text: event.error || 'run failed',
    }]
  }

  if (event.event === 'abort.completed') {
    return [{ type: 'interaction.status', interactionId, status: 'aborted' }]
  }

  return []
}

export function startMcuVoiceInteraction(options: StartMcuVoiceInteractionOptions): McuInteractionHandle {
  const deps = { ...defaultDeps, ...options.deps }
  const interactionId = options.sessionId || deps.makeInteractionId()
  const segmenter = createMcuSpeechSegmenter()
  let runHandle: { abort: () => void } | null = null
  let aborted = false
  let ttsQueue = Promise.resolve()
  let segmentIndex = 0

  const emit = async (event: McuStatusEvent | McuToolEvent) => {
    await options.transport.send(event)
  }

  const enqueueSpeech = (text: string) => {
    const segmentText = normalizeSpeechText(text)
    if (!segmentText) return
    const segmentId = `${interactionId}-${++segmentIndex}`

    ttsQueue = ttsQueue.then(async () => {
      if (aborted) return
      await emit({ type: 'interaction.status', interactionId, status: 'speaking', text: segmentText })
      const result = await deps.synthesize({
        provider: options.ttsProvider,
        text: segmentText,
        options: options.ttsOptions || {},
      })
      if (aborted) return
      await options.transport.enqueueAudio({
        interactionId,
        segmentId,
        text: segmentText,
        audio: result.audio,
        mimeType: result.audio.type || 'audio/mpeg',
        engine: result.engine,
        provider: result.provider,
      })
    })
  }

  const done = (async () => {
    try {
      await options.transport.clearAudio(interactionId)
      await emit({ type: 'interaction.status', interactionId, status: 'transcribing' })

      const transcript = await deps.transcribe({
        audio: options.audio,
        provider: options.sttProvider,
        language: options.language,
        prompt: options.prompt,
      })
      if (aborted) return

      await emit({ type: 'interaction.status', interactionId, status: 'thinking', text: transcript.text })

      await new Promise<void>((resolve, reject) => {
        runHandle = deps.startRun(
          {
            ...(options.run || {}),
            input: transcript.text,
            session_id: interactionId,
            profile: options.profile,
            source: 'global_agent',
            session_source: 'global_agent',
          },
          event => {
            for (const mapped of mcuEventsFromRunEvent(event, interactionId)) {
              void emit(mapped)
            }

            if (event.event === 'message.delta' && event.delta) {
              for (const segment of segmenter.pushDelta(event.delta)) {
                enqueueSpeech(segment)
              }
            }
          },
          () => {
            const tail = segmenter.flush()
            if (tail) enqueueSpeech(tail)
            resolve()
          },
          reject,
        )
      })

      await ttsQueue
      if (!aborted) {
        await emit({ type: 'interaction.status', interactionId, status: 'completed' })
      }
    } catch (err) {
      if (aborted) return
      await emit({
        type: 'interaction.status',
        interactionId,
        status: 'failed',
        text: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  })()

  return {
    interactionId,
    done,
    abort: () => {
      if (aborted) return
      aborted = true
      segmenter.reset()
      runHandle?.abort()
      void options.transport.clearAudio(interactionId)
      void emit({ type: 'interaction.status', interactionId, status: 'aborted' })
    },
  }
}
