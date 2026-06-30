import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { io, type Socket } from 'socket.io-client'
import WebSocket from 'ws'
import { config } from '../../config'
import { clearSessionMessages } from '../../db/hermes/session-store'
import { getChatRunServer } from '../../routes/hermes/chat-run'
import { logger } from '../logger'
import { cleanTtsText } from '../hermes/tts-providers/text'
import { transcodeToPcmS16le } from '../hermes/stt-providers/audio-convert'
import { MCU_TTS_SAMPLE_RATE, mcuPromptText, mcuPromptUrl } from '../hermes/mcu-prompts'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024
const MAX_RESPONSE_BODY_BYTES = 10 * 1024 * 1024

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const ALLOWED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'x-hermes-profile',
  'x-request-id',
])
const TEXTUAL_RESPONSE_TYPES = [
  'application/json',
  'application/problem+json',
  'application/x-ndjson',
  'application/javascript',
  'application/xml',
  'application/x-www-form-urlencoded',
  'text/',
]
const ALLOWED_SOCKET_NAMESPACES = new Set(['/chat-run'])
const ALLOWED_CHAT_RUN_CLIENT_EVENTS = new Set([
  'run',
  'resume',
  'abort',
  'cancel_queued_run',
  'approval.respond',
  'clarify.respond',
])
const CHAT_RUN_SERVER_EVENTS = [
  'run.started',
  'message.delta',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
  'tool.started',
  'tool.completed',
  'run.completed',
  'run.failed',
  'compression.started',
  'compression.completed',
  'abort.started',
  'abort.timeout',
  'abort.completed',
  'usage.updated',
  'agent.event',
  'subagent.event',
  'session.command',
  'session.title.updated',
  'run.queued',
  'approval.requested',
  'approval.resolved',
  'clarify.requested',
  'clarify.resolved',
  'peer.user.message',
  'resumed',
]
const NON_STREAMING_SUPPRESSED_EVENTS = new Set([
  'message.delta',
  'reasoning.delta',
  'thinking.delta',
  'reasoning.available',
])
const MCU_TTS_OPTIONS = {
  mcuPlayback: true,
  sampleRate: MCU_TTS_SAMPLE_RATE,
} as const
const MCU_INTERRUPT_DEBOUNCE_MS = 280

function normalizeMcuSpeechText(text: string): string {
  return cleanTtsText(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function chooseMcuApprovalChoice(event: Record<string, unknown>): 'once' | 'session' | 'always' | null {
  const rawChoices = Array.isArray(event.choices) ? event.choices.map(choice => String(choice)) : []
  const choices = rawChoices.length > 0 ? rawChoices : ['once', 'session', 'deny']
  if (choices.includes('session')) return 'session'
  if (choices.includes('once')) return 'once'
  if (choices.includes('always')) return 'always'
  return null
}

export interface RelayHttpRequest {
  id?: string
  method?: string
  path?: string
  headers?: Record<string, string | string[] | undefined>
  body?: unknown
  bodyBase64?: string
  timeoutMs?: number
}

export interface RelayHttpResponse {
  id?: string
  status?: number
  headers?: Record<string, string>
  body?: string
  bodyBase64?: string
  truncated?: boolean
  error?: {
    code: string
    message: string
  }
}

export interface RelaySocketOpenRequest {
  id?: string
  namespace?: string
  auth?: Record<string, unknown>
  query?: Record<string, string | number | boolean | undefined>
  stream?: boolean
}

export interface RelaySocketEventRequest {
  id?: string
  event?: string
  payload?: unknown
  stream?: boolean
}

export interface RelaySocketCloseRequest {
  id?: string
}

export interface RelaySocketResponse {
  id?: string
  ok?: boolean
  namespace?: string
  event?: string
  stream?: boolean
  payload?: unknown
  error?: {
    code: string
    message: string
  }
}

interface StartOutboundRelayClientOptions {
  connectionId?: string
  relayUrl?: string
  relayToken?: string
  userToken?: string
  instanceId?: string
  localBaseUrl?: string
  fetchImpl?: typeof fetch
  relayProtocol?: 'socket.io' | 'websocket'
}

type OutboundRelayClientOptions =
  Required<Omit<StartOutboundRelayClientOptions, 'connectionId' | 'relayProtocol' | 'userToken'>> &
  Pick<StartOutboundRelayClientOptions, 'userToken'>
type RelayClient = Pick<OutboundRelayClient, 'start' | 'stop'> | PlainWebSocketRelayClient

interface LocalSocketBridge {
  id: string
  namespace: string
  socket: Socket
  stream: boolean
  output: string
  reasoning: string
}

interface McuVoiceMeta {
  interactionId: string
  mimeType: string
  bytes: number
  profile: string
}

class PlainWebSocketRelayClient {
  private socket: WebSocket | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelayMs = 1000
  private stopped = false
  private pendingVoice: McuVoiceMeta | null = null
  private pendingVoiceStream: (McuVoiceMeta & {
    sampleRate: number
    channels: number
    bitsPerSample: number
    chunks: Buffer[]
  }) | null = null
  private readonly audioWaiters = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>()
  private readonly activeRuns = new Map<string, { socket: Socket; sessionId: string }>()
  private readonly sessionRuns = new Map<string, { interactionId: string; socket: Socket }>()
  private readonly interruptedInteractions = new Set<string>()
  private readonly recentlyInterruptedSessions = new Map<string, number>()
  private readonly pendingInterrupts = new Map<string, { profile: string; interactionId: string; timer: NodeJS.Timeout }>()

  constructor(private readonly options: OutboundRelayClientOptions) {}

  start(): void {
    if (this.socket || this.reconnectTimer) return
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.cancelPendingInterrupts()
    this.rejectAudioWaiters(new Error('MCU websocket stopped'))
  }

  private connect(): void {
    if (this.stopped) return
    const socket = new WebSocket(this.options.relayUrl)
    this.socket = socket

    socket.on('open', () => {
      this.reconnectDelayMs = 1000
      logger.info({ relayUrl: this.redactedRelayUrl() }, '[outbound-relay:ws] connected')
      this.sendJson({
        type: 'mcu.auth',
        token: this.options.relayToken || undefined,
        instanceId: this.options.instanceId || undefined,
        role: 'hermes-studio',
      })
    })

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        const audio = this.binaryBuffer(data)
        if (this.pendingVoiceStream) {
          this.pendingVoiceStream.chunks.push(audio)
          this.pendingVoiceStream.bytes += audio.length
          return
        }
        logger.info({
          relayUrl: this.redactedRelayUrl(),
          bytes: audio.length,
          interactionId: this.pendingVoice?.interactionId,
        }, '[outbound-relay:ws] binary received')
        void this.handleVoiceAudio(audio)
        return
      }
      const text = Buffer.isBuffer(data) ? data.toString('utf-8') : String(data)
      this.handleText(text)
    })

    socket.on('error', (err) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[outbound-relay:ws] connection error')
    })

    socket.on('close', (code, reason) => {
      if (this.socket === socket) this.socket = null
      this.rejectAudioWaiters(new Error('MCU websocket disconnected'))
      logger.info({
        code,
        reason: reason.toString(),
        relayUrl: this.redactedRelayUrl(),
      }, '[outbound-relay:ws] disconnected')
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.reconnectDelayMs
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return
    this.socket.send(JSON.stringify(payload))
  }

  private rejectAudioWaiters(error: Error): void {
    for (const [segmentId, waiter] of this.audioWaiters.entries()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
      this.audioWaiters.delete(segmentId)
    }
  }

  private handleText(text: string): void {
    let event: Record<string, unknown>
    try {
      event = JSON.parse(text) as Record<string, unknown>
    } catch {
      logger.warn({ relayUrl: this.redactedRelayUrl(), text: text.slice(0, 300) }, '[outbound-relay:ws] invalid json')
      return
    }
    logger.info({
      relayUrl: this.redactedRelayUrl(),
      type: typeof event.type === 'string' ? event.type : undefined,
      status: typeof event.status === 'string' ? event.status : undefined,
      text: typeof event.text === 'string' ? event.text.slice(0, 300) : undefined,
      interactionId: typeof event.interactionId === 'string' ? event.interactionId : undefined,
    }, '[outbound-relay:ws] event')
    if (event.type === 'voice.recorded') {
      this.pendingVoice = {
        interactionId: typeof event.interactionId === 'string' && event.interactionId.trim() ? event.interactionId.trim() : `mcu-voice-${Date.now()}`,
        mimeType: typeof event.mimeType === 'string' && event.mimeType.trim() ? event.mimeType.trim() : 'audio/wav',
        bytes: Number.isFinite(Number(event.bytes)) ? Number(event.bytes) : 0,
        profile: typeof event.profile === 'string' && event.profile.trim() ? event.profile.trim() : 'default',
      }
      return
    }
    if (event.type === 'voice.stream.start') {
      this.pendingVoice = null
      this.pendingVoiceStream = {
        interactionId: typeof event.interactionId === 'string' && event.interactionId.trim() ? event.interactionId.trim() : `mcu-voice-${Date.now()}`,
        mimeType: 'audio/wav',
        bytes: 0,
        profile: typeof event.profile === 'string' && event.profile.trim() ? event.profile.trim() : 'default',
        sampleRate: Number.isFinite(Number(event.sampleRate)) ? Number(event.sampleRate) : MCU_TTS_SAMPLE_RATE,
        channels: Number(event.channels) === 1 ? 1 : 2,
        bitsPerSample: Number(event.bitsPerSample) === 16 ? 16 : 16,
        chunks: [],
      }
      return
    }
    if (event.type === 'voice.stream.end') {
      const stream = this.pendingVoiceStream
      this.pendingVoiceStream = null
      if (!stream) {
        this.sendJson({ type: 'interaction.status', status: 'failed', text: 'missing voice stream metadata' })
        return
      }
      const pcm = Buffer.concat(stream.chunks, stream.bytes)
      logger.info({
        relayUrl: this.redactedRelayUrl(),
        bytes: pcm.length,
        interactionId: stream.interactionId,
      }, '[outbound-relay:ws] voice stream completed')
      const wav = this.wrapPcmAsWav(pcm, stream.sampleRate, stream.channels, stream.bitsPerSample)
      void this.handleVoiceAudio(wav, {
        interactionId: stream.interactionId,
        mimeType: 'audio/wav',
        bytes: wav.length,
        profile: stream.profile,
      })
      return
    }
    if (event.type === 'audio.done' || event.type === 'audio.interrupted' || event.type === 'audio.dropped') {
      if (event.type === 'audio.interrupted' && typeof event.interactionId === 'string') {
        this.abortActiveRun(event.interactionId)
      }
      const segmentId = typeof event.segmentId === 'string' ? event.segmentId : ''
      if (!segmentId) return
      const waiter = this.audioWaiters.get(segmentId)
      if (!waiter) return
      clearTimeout(waiter.timer)
      this.audioWaiters.delete(segmentId)
      if (event.type === 'audio.done') {
        waiter.resolve()
      } else {
        waiter.reject(new Error(event.type))
      }
      return
    }
    if (event.type === 'mcu.interrupt') {
      const interactionId = typeof event.interactionId === 'string' ? event.interactionId.trim() : ''
      const profile = typeof event.profile === 'string' && event.profile.trim() ? event.profile.trim() : 'default'
      this.scheduleMcuInterrupt(profile, interactionId)
      this.sendJson({ type: 'mcu.interrupt.ack', interactionId, profile })
      return
    }
    if (event.type === 'mcu.session.clear') {
      const profile = typeof event.profile === 'string' && event.profile.trim() ? event.profile.trim() : 'default'
      const interactionId = typeof event.interactionId === 'string' ? event.interactionId.trim() : ''
      this.clearMcuSession(profile, interactionId)
    }
  }

  private binaryBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data
    if (Array.isArray(data)) return Buffer.concat(data)
    return Buffer.from(data)
  }

  private wrapPcmAsWav(pcm: Buffer, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44)
    const byteRate = sampleRate * channels * bitsPerSample / 8
    const blockAlign = channels * bitsPerSample / 8
    header.write('RIFF', 0, 'ascii')
    header.writeUInt32LE(36 + pcm.length, 4)
    header.write('WAVE', 8, 'ascii')
    header.write('fmt ', 12, 'ascii')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(1, 20)
    header.writeUInt16LE(channels, 22)
    header.writeUInt32LE(sampleRate, 24)
    header.writeUInt32LE(byteRate, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(bitsPerSample, 34)
    header.write('data', 36, 'ascii')
    header.writeUInt32LE(pcm.length, 40)
    return Buffer.concat([header, pcm], 44 + pcm.length)
  }

  private async handleVoiceAudio(audio: Buffer, voiceOverride?: McuVoiceMeta): Promise<void> {
    const voice = voiceOverride || this.pendingVoice
    if (!voiceOverride) this.pendingVoice = null
    if (!voice) {
      this.sendJson({ type: 'interaction.status', status: 'failed', text: 'missing voice metadata' })
      return
    }
    if (!this.options.userToken) {
      this.sendJson({
        type: 'interaction.status',
        interactionId: voice.interactionId,
        status: 'failed',
        text: 'missing Web UI auth token',
      })
      return
    }

    this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'transcribing' })
    try {
      const response = await this.options.fetchImpl(`${this.options.localBaseUrl.replace(/\/$/, '')}/api/hermes/mcu/voice-turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.userToken}`,
          'Content-Type': voice.mimeType,
          'X-Hermes-Mcu-Interaction-Id': voice.interactionId,
          'X-Hermes-Profile': voice.profile,
        },
        body: new Uint8Array(audio),
      })
      const text = await response.text()
      let payload: Record<string, unknown> = {}
      try {
        payload = text ? JSON.parse(text) as Record<string, unknown> : {}
      } catch {
        payload = { error: text }
      }
      if (!response.ok || payload.ok === false) {
        if (payload.ok === false && await this.enqueuePromptAudioFromVoiceTurn(voice.interactionId, payload)) {
          return
        }
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'failed',
          text: typeof payload.error === 'string' ? payload.error : `voice turn failed: ${response.status}`,
        })
        return
      }
      const transcript = typeof payload.transcript === 'string' ? payload.transcript : ''
      if (!transcript.trim()) {
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'completed',
          text: '',
        })
        return
      }
      this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'thinking', text: transcript })
      await this.runChatFromTranscript(voice, transcript)
    } catch (err) {
      this.sendJson({
        type: 'interaction.status',
        interactionId: voice.interactionId,
        status: 'failed',
        text: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private async runChatFromTranscript(
    voice: { interactionId: string; profile: string },
    transcript: string,
  ): Promise<void> {
    await new Promise<void>((resolve) => {
      const sessionId = this.mcuSessionId(voice.profile)
      this.interruptedInteractions.delete(voice.interactionId)
      const socket: Socket = io(`${this.options.localBaseUrl.replace(/\/$/, '')}/chat-run`, {
        auth: this.options.userToken ? { token: this.options.userToken } : {},
        query: { profile: voice.profile },
        transports: ['websocket', 'polling'],
        reconnection: false,
        timeout: 30_000,
      })
      let output = ''
      let spokenOutputLength = 0
      let segmentIndex = 0
      let ttsQueue = Promise.resolve()
      let settled = false
      const enqueueSpeech = (text: string) => {
        if (this.interruptedInteractions.has(voice.interactionId)) return
        const segmentText = normalizeMcuSpeechText(text)
        if (!segmentText) return
        const segmentId = `${voice.interactionId}-tts-${++segmentIndex}`
        ttsQueue = ttsQueue.then(() => this.enqueueMcuSpeechSegment(voice.profile, voice.interactionId, segmentId, segmentText))
          .catch((err) => {
            if (err instanceof Error && err.message === 'audio.interrupted') {
              this.interruptedInteractions.add(voice.interactionId)
              logger.info({
                interactionId: voice.interactionId,
                segmentId,
              }, '[outbound-relay:ws] MCU speech interrupted by user')
              return
            }
            logger.warn({
              err,
              interactionId: voice.interactionId,
              segmentId,
            }, '[outbound-relay:ws] failed to enqueue MCU speech')
            this.sendJson({
              type: 'interaction.status',
              interactionId: voice.interactionId,
              status: 'failed',
              text: err instanceof Error ? err.message : String(err),
            })
            this.sendJson({
              type: 'audio.enqueue',
              interactionId: voice.interactionId,
              segmentId: `${segmentId}-failed-prompt`,
              text: mcuPromptText('tts-failed'),
              url: mcuPromptUrl('tts-failed'),
              mimeType: 'audio/x-pcm',
              format: 's16le',
              channels: 1,
              sampleRate: MCU_TTS_SAMPLE_RATE,
            })
          })
      }
      const flushCompletedAssistantMessage = () => {
        const text = output.slice(spokenOutputLength)
        spokenOutputLength = output.length
        enqueueSpeech(text)
      }
      const finish = () => {
        if (settled) return
        settled = true
        this.activeRuns.delete(voice.interactionId)
        this.sessionRuns.delete(sessionId)
        this.interruptedInteractions.delete(voice.interactionId)
        clearTimeout(timer)
        socket.removeAllListeners()
        socket.disconnect()
        resolve()
      }
      const fail = (message: string) => {
        this.sendJson({
          type: 'interaction.status',
          interactionId: voice.interactionId,
          status: 'failed',
          text: message,
        })
        finish()
      }
      const timer = setTimeout(() => {
        fail('chat-run timed out')
      }, 300_000)

      socket.on('connect_error', (err: Error) => {
        fail(err.message || 'chat-run connection failed')
      })
      socket.on('connect', () => {
        logger.info({
          interactionId: voice.interactionId,
          sessionId,
          profile: voice.profile,
          transcriptLength: transcript.length,
        }, '[outbound-relay:ws] starting chat-run')
        this.activeRuns.set(voice.interactionId, { socket, sessionId })
        this.sessionRuns.set(sessionId, { interactionId: voice.interactionId, socket })
        const runPayload = {
          input: transcript,
          session_id: sessionId,
          profile: voice.profile,
          source: 'global_agent',
          session_source: 'global_agent',
        }
        const interruptedAt = this.recentlyInterruptedSessions.get(sessionId) || 0
        if (Date.now() - interruptedAt < 10_000) {
          socket.emit('abort', { session_id: sessionId })
          setTimeout(() => socket.emit('run', runPayload), 800)
          this.recentlyInterruptedSessions.delete(sessionId)
          return
        }
        socket.emit('run', runPayload)
      })
      socket.on('run.started', () => {
        this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'thinking' })
      })
      socket.on('run.queued', () => {
        this.sendJson({ type: 'interaction.status', interactionId: voice.interactionId, status: 'thinking' })
      })
      socket.on('tool.started', (event: Record<string, unknown> = {}) => {
        flushCompletedAssistantMessage()
        const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'tool'
        const preview = typeof event.preview === 'string' ? event.preview : undefined
        this.sendJson({ type: 'tool.started', interactionId: voice.interactionId, tool, preview })
      })
      socket.on('tool.completed', (event: Record<string, unknown> = {}) => {
        const tool = typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : 'tool'
        const preview = typeof event.preview === 'string' ? event.preview : undefined
        const error = typeof event.error === 'string' ? event.error : undefined
        this.sendJson({ type: 'tool.completed', interactionId: voice.interactionId, tool, preview, error })
      })
      socket.on('message.delta', (event: Record<string, unknown> = {}) => {
        if (typeof event.delta === 'string') {
          output += event.delta
        }
      })
      socket.on('run.completed', (event: Record<string, unknown> = {}) => {
        if (typeof event.output === 'string' && event.output.trim()) output = event.output
        if (spokenOutputLength > output.length) spokenOutputLength = 0
        flushCompletedAssistantMessage()
        ttsQueue.finally(() => {
          if (this.interruptedInteractions.has(voice.interactionId)) {
            finish()
            return
          }
          this.sendJson({
            type: 'interaction.status',
            interactionId: voice.interactionId,
            status: 'completed',
          })
          finish()
        })
      })
      socket.on('run.failed', (event: Record<string, unknown> = {}) => {
        fail(typeof event.error === 'string' ? event.error : 'chat-run failed')
      })
      socket.on('approval.requested', (event: Record<string, unknown> = {}) => {
        const approvalId = typeof event.approval_id === 'string' ? event.approval_id : ''
        const choice = chooseMcuApprovalChoice(event)
        if (!approvalId || !choice) {
          fail('approval required')
          return
        }
        logger.info({
          interactionId: voice.interactionId,
          sessionId,
          approvalId,
          choice,
        }, '[outbound-relay:ws] auto-approving MCU chat-run approval')
        this.sendJson({
          type: 'tool.started',
          interactionId: voice.interactionId,
          tool: 'approval',
          preview: choice,
        })
        socket.emit('approval.respond', {
          session_id: sessionId,
          approval_id: approvalId,
          choice,
        })
      })
      socket.on('approval.resolved', (event: Record<string, unknown> = {}) => {
        const resolved = event.resolved !== false
        this.sendJson({
          type: 'tool.completed',
          interactionId: voice.interactionId,
          tool: 'approval',
          error: resolved ? undefined : 'approval failed',
        })
      })
      socket.on('clarify.requested', () => {
        fail('clarification required')
      })
    })
  }

  private async enqueuePromptAudioFromVoiceTurn(interactionId: string, payload: Record<string, unknown>): Promise<boolean> {
    const audio = isRecord(payload.audio) ? payload.audio : payload
    const url = typeof audio.url === 'string' ? audio.url.trim() : ''
    if (!url) return false

    const text = typeof audio.text === 'string' ? audio.text : ''
    const mimeType = typeof audio.mimeType === 'string' && audio.mimeType.trim() ? audio.mimeType.trim() : 'audio/x-pcm'
    const channels = Number(audio.channels) === 1 ? 1 : 2
    const sampleRate = Number.isFinite(Number(audio.sampleRate)) && Number(audio.sampleRate) > 0
      ? Number(audio.sampleRate)
      : MCU_TTS_SAMPLE_RATE
    const durationMs = Number.isFinite(Number(audio.durationMs)) && Number(audio.durationMs) > 0
      ? Number(audio.durationMs)
      : Math.max(1200, Math.min(text.length * 180, 9000))
    const segmentId = `${interactionId}-prompt`

    this.sendJson({ type: 'interaction.status', interactionId, status: 'speaking', text })
    const waitForDone = this.waitForMcuAudioDone(segmentId, Math.max(30_000, durationMs + 20_000))
      .catch((err) => {
        logger.warn({
          err,
          interactionId,
          segmentId,
        }, '[outbound-relay:ws] MCU prompt playback did not complete')
      })
    this.sendJson({
      type: 'audio.enqueue',
      interactionId,
      segmentId,
      text,
      url,
      mimeType,
      channels,
      sampleRate,
      durationMs,
    })
    await waitForDone
    this.sendJson({ type: 'interaction.status', interactionId, status: 'completed' })
    return true
  }

  private abortActiveRun(interactionId: string): void {
    this.interruptedInteractions.add(interactionId)
    const active = this.activeRuns.get(interactionId)
    if (!active) return
    logger.info({ interactionId, sessionId: active.sessionId }, '[outbound-relay:ws] aborting chat-run after MCU audio interrupt')
    active.socket.emit('abort', { session_id: active.sessionId })
    this.activeRuns.delete(interactionId)
    this.sessionRuns.delete(active.sessionId)
  }

  private scheduleMcuInterrupt(profile: string, interactionId: string): void {
    const sessionId = this.mcuSessionId(profile)
    this.cancelPendingInterrupt(sessionId)
    const timer = setTimeout(() => {
      this.pendingInterrupts.delete(sessionId)
      this.interruptMcuSession(profile, interactionId)
    }, MCU_INTERRUPT_DEBOUNCE_MS)
    this.pendingInterrupts.set(sessionId, { profile, interactionId, timer })
  }

  private cancelPendingInterrupt(sessionId: string): void {
    const pending = this.pendingInterrupts.get(sessionId)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingInterrupts.delete(sessionId)
  }

  private cancelPendingInterrupts(): void {
    for (const pending of this.pendingInterrupts.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingInterrupts.clear()
  }

  private forgetMcuSessionRun(sessionId: string, interactionId?: string): void {
    const sessionRun = this.sessionRuns.get(sessionId)
    if (sessionRun) {
      this.interruptedInteractions.add(sessionRun.interactionId)
      this.activeRuns.delete(sessionRun.interactionId)
      this.sessionRuns.delete(sessionId)
    }
    if (interactionId) {
      this.interruptedInteractions.add(interactionId)
      const active = this.activeRuns.get(interactionId)
      if (active?.sessionId === sessionId) {
        this.activeRuns.delete(interactionId)
        this.sessionRuns.delete(sessionId)
      }
    }
  }

  private interruptMcuSession(profile: string, interactionId?: string): void {
    const sessionId = this.mcuSessionId(profile)
    this.recentlyInterruptedSessions.set(sessionId, Date.now())
    if (interactionId) this.interruptedInteractions.add(interactionId)
    const sessionRun = this.sessionRuns.get(sessionId)
    if (sessionRun) {
      this.interruptedInteractions.add(sessionRun.interactionId)
      logger.info({
        interactionId: sessionRun.interactionId,
        sessionId,
      }, '[outbound-relay:ws] aborting chat-run after MCU interrupt')
      sessionRun.socket.emit('abort', { session_id: sessionId })
      this.activeRuns.delete(sessionRun.interactionId)
      this.sessionRuns.delete(sessionId)
      return
    }
    if (interactionId) this.abortActiveRun(interactionId)
  }

  private clearMcuSession(profile: string, interactionId?: string): void {
    const sessionId = this.mcuSessionId(profile)
    this.cancelPendingInterrupt(sessionId)
    this.forgetMcuSessionRun(sessionId, interactionId)
    const cleared = getChatRunServer()?.clearSessionHistory(sessionId)
    const deleted = cleared?.deleted ?? clearSessionMessages(sessionId)
    const memoryCleared = cleared?.hadMemoryState ?? false
    logger.info({ sessionId, deleted, memoryCleared }, '[outbound-relay:ws] cleared MCU chat session')
    this.sendJson({
      type: 'mcu.session.cleared',
      interactionId: interactionId || undefined,
      profile,
      sessionId,
      deleted,
      memoryCleared,
    })
  }

  private mcuSessionId(profile: string): string {
    const instance = (this.options.instanceId || 'device')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'device'
    const profileId = (profile || 'default')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'default'
    return `mcu-${instance}-${profileId}`
  }

  private async enqueueMcuSpeechSegment(profile: string, interactionId: string, segmentId: string, text: string): Promise<void> {
    if (this.interruptedInteractions.has(interactionId)) return
    this.sendJson({ type: 'interaction.status', interactionId, status: 'speaking' })
    const audio = await this.synthesizeMcuSpeech(text, profile)
    if (this.interruptedInteractions.has(interactionId)) return
    const waitForDone = this.waitForMcuAudioDone(segmentId, Math.max(90_000, Math.min(text.length * 1200, 300_000)))
    this.sendJson({
      type: 'audio.enqueue',
      interactionId,
      segmentId,
      text: '',
      url: audio.url,
      mimeType: 'audio/x-pcm',
      channels: 1,
      sampleRate: MCU_TTS_SAMPLE_RATE,
      durationMs: Math.max(1200, Math.min(text.length * 180, 12_000)),
      completionManagedByServer: true,
    })
    await waitForDone
  }

  private waitForMcuAudioDone(segmentId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.audioWaiters.delete(segmentId)
        reject(new Error(`MCU audio playback timed out: ${segmentId}`))
      }, timeoutMs)
      this.audioWaiters.set(segmentId, { resolve, reject, timer })
    })
  }

  private async synthesizeMcuSpeech(text: string, profile: string): Promise<{ url: string }> {
    if (!this.options.userToken) {
      throw new Error('missing Web UI auth token')
    }

    const baseUrl = this.options.localBaseUrl.replace(/\/$/, '')
    const headers = {
      Authorization: `Bearer ${this.options.userToken}`,
      'Content-Type': 'application/json',
      'X-Hermes-Profile': profile || 'default',
    }
    const requestTts = (provider?: 'edge') => this.options.fetchImpl(`${baseUrl}/api/hermes/tts/synthesize`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...(provider ? { provider } : {}),
        text,
        options: MCU_TTS_OPTIONS,
      }),
    })

    const readPcmAudio = async (response: Response, context: string): Promise<Buffer> => {
      let audio: Buffer<ArrayBufferLike> = Buffer.from(await response.arrayBuffer())
      if (!audio.length) {
        throw new Error(`${context} returned empty audio`)
      }
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
      if (contentType === 'audio/x-pcm' || contentType === 'audio/pcm') return audio

      const converted = await transcodeToPcmS16le(audio, contentType || 'application/octet-stream', {
        sampleRate: MCU_TTS_SAMPLE_RATE,
      })
      if (converted.mimeType !== 'audio/x-pcm') {
        throw new Error(`${context} returned ${contentType || 'unknown content type'} and PCM conversion is unavailable`)
      }
      audio = converted.audio
      if (!audio.length) {
        throw new Error(`${context} PCM conversion returned empty audio`)
      }
      return audio
    }

    let response = await requestTts()
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      logger.warn({
        status: response.status,
        detail: detail.slice(0, 200),
      }, '[outbound-relay-client] active MCU TTS failed, falling back to Edge TTS')
      response = await requestTts('edge')
      if (!response.ok) {
        const fallbackDetail = await response.text().catch(() => '')
        throw new Error(`MCU TTS failed and Edge fallback failed: ${response.status}${fallbackDetail ? ` ${fallbackDetail.slice(0, 200)}` : ''}`)
      }
    }

    let audio: Buffer
    try {
      audio = await readPcmAudio(response, 'MCU TTS')
    } catch (err) {
      logger.warn({ err }, '[outbound-relay-client] MCU TTS audio conversion failed, falling back to Edge TTS')
      try {
        const fallback = await this.options.fetchImpl(`${baseUrl}/api/hermes/tts/synthesize`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            provider: 'edge',
            text,
            options: MCU_TTS_OPTIONS,
          }),
        })
        if (!fallback.ok) {
          const detail = await fallback.text().catch(() => '')
          throw new Error(`MCU TTS conversion failed and Edge fallback failed: ${fallback.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
        }
        audio = await readPcmAudio(fallback, 'MCU Edge TTS fallback')
      } catch (fallbackError) {
        throw fallbackError
      }
    }

    const dir = join(config.appHome, 'mcu-audio')
    await mkdir(dir, { recursive: true })
    const file = `${randomUUID()}.pcm`
    await writeFile(join(dir, file), audio)
    return { url: `${baseUrl}/api/hermes/mcu/audio/${file}` }
  }

  private redactedRelayUrl(): string {
    try {
      const url = new URL(this.options.relayUrl)
      if (url.username || url.password) {
        url.username = url.username ? '[redacted]' : ''
        url.password = url.password ? '[redacted]' : ''
      }
      return url.toString()
    } catch {
      return '[invalid relay url]'
    }
  }
}

interface NormalizedBody {
  body?: BodyInit
  contentType?: string
  byteLength: number
}

function relayError(id: string | undefined, code: string, message: string, status?: number): RelayHttpResponse {
  return {
    id,
    ...(status ? { status } : {}),
    error: { code, message },
  }
}

function socketRelayError(id: string | undefined, code: string, message: string): RelaySocketResponse {
  return {
    id,
    ok: false,
    error: { code, message },
  }
}

function isRelayHttpResponse(value: NormalizedBody | RelayHttpResponse): value is RelayHttpResponse {
  return 'error' in value
}

function normalizeMethod(method?: string): string | null {
  const normalized = String(method || 'GET').trim().toUpperCase()
  return ALLOWED_METHODS.has(normalized) ? normalized : null
}

function normalizeRelayPath(path?: string): string | null {
  const raw = String(path || '').trim()
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return null

  const parsed = new URL(raw, 'http://hermes-relay.local')
  const normalized = `${parsed.pathname}${parsed.search}`
  if (parsed.pathname === '/v1' || parsed.pathname.startsWith('/v1/')) return null
  return normalized
}

function normalizeSocketBridgeId(id?: string): string | null {
  const normalized = String(id || '').trim()
  if (!normalized || normalized.length > 128) return null
  return normalized
}

function normalizeSocketNamespace(namespace?: string): string | null {
  const normalized = String(namespace || '').trim()
  return ALLOWED_SOCKET_NAMESPACES.has(normalized) ? normalized : null
}

function normalizeSocketQuery(query?: RelaySocketOpenRequest['query']): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue
    normalized[key] = String(value)
  }
  return normalized
}

function normalizeSocketAuth(auth?: RelaySocketOpenRequest['auth']): Record<string, unknown> {
  const normalized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(auth || {})) {
    if (value == null) continue
    normalized[key] = value
  }
  return normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function streamMode(value: unknown, fallback = true): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeTimeout(timeoutMs?: number): number {
  const value = Number(timeoutMs)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_REQUEST_TIMEOUT_MS
  return Math.min(Math.floor(value), MAX_REQUEST_TIMEOUT_MS)
}

function normalizeHeaders(headers?: RelayHttpRequest['headers']): Headers {
  const normalized = new Headers()
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase()
    if (!ALLOWED_REQUEST_HEADERS.has(lower) || value == null) continue
    const headerValue = Array.isArray(value) ? value.find(Boolean) : value
    if (headerValue) normalized.set(lower, String(headerValue))
  }
  return normalized
}

function normalizeRequestBody(request: RelayHttpRequest, method: string, headers: Headers): NormalizedBody | RelayHttpResponse {
  if (method === 'GET' || method === 'HEAD') {
    return { byteLength: 0 }
  }

  if (typeof request.bodyBase64 === 'string') {
    const buffer = Buffer.from(request.bodyBase64, 'base64')
    if (buffer.byteLength > MAX_REQUEST_BODY_BYTES) {
      return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
    }
    return { body: buffer, byteLength: buffer.byteLength }
  }

  if (request.body == null) {
    return { byteLength: 0 }
  }

  if (typeof request.body === 'string') {
    const byteLength = Buffer.byteLength(request.body)
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
    }
    return { body: request.body, byteLength }
  }

  const serialized = JSON.stringify(request.body)
  const byteLength = Buffer.byteLength(serialized)
  if (byteLength > MAX_REQUEST_BODY_BYTES) {
    return relayError(request.id, 'request_body_too_large', 'Relay request body exceeds the local size limit', 413)
  }
  if (!headers.has('content-type')) {
    return { body: serialized, contentType: 'application/json', byteLength }
  }
  return { body: serialized, byteLength }
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase()
    if (lower === 'connection' || lower === 'transfer-encoding') return
    headers[lower] = value
  })
  return headers
}

function isTextualResponse(contentType: string): boolean {
  const lower = contentType.toLowerCase()
  return TEXTUAL_RESPONSE_TYPES.some(prefix => lower.startsWith(prefix) || lower.includes(prefix))
}

async function readResponseBody(response: Response): Promise<{ body?: string; bodyBase64?: string; truncated?: boolean }> {
  const contentType = response.headers.get('content-type') || ''
  if (!response.body) return {}

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value)
    total += chunk.byteLength
    if (total > MAX_RESPONSE_BODY_BYTES) {
      const remaining = Math.max(0, MAX_RESPONSE_BODY_BYTES - (total - chunk.byteLength))
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining))
      truncated = true
      await reader.cancel()
      break
    }
    chunks.push(chunk)
  }

  const buffer = Buffer.concat(chunks)
  if (isTextualResponse(contentType)) {
    return { body: buffer.toString('utf-8'), truncated }
  }
  return { bodyBase64: buffer.toString('base64'), truncated }
}

export class OutboundRelayClient {
  private socket: Socket | null = null
  private readonly socketBridges = new Map<string, LocalSocketBridge>()
  private readonly relayUrl: string
  private readonly relayToken: string
  private readonly instanceId: string
  private readonly localBaseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: OutboundRelayClientOptions) {
    this.relayUrl = options.relayUrl
    this.relayToken = options.relayToken
    this.instanceId = options.instanceId
    this.localBaseUrl = options.localBaseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl
  }

  start(): void {
    if (this.socket) return
    this.socket = io(this.relayUrl, {
      auth: {
        token: this.relayToken || undefined,
        instanceId: this.instanceId || undefined,
        role: 'hermes-studio',
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })

    this.socket.on('connect', () => {
      logger.info({ relayUrl: this.redactedRelayUrl() }, '[outbound-relay] connected')
      this.socket?.emit('relay.ready', {
        capabilities: ['http.request', 'socket.chat-run'],
        instanceId: this.instanceId || undefined,
      })
    })
    this.socket.on('connect_error', (err: Error) => {
      logger.warn({ err, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] connection failed')
    })
    this.socket.on('disconnect', (reason: string) => {
      logger.info({ reason, relayUrl: this.redactedRelayUrl() }, '[outbound-relay] disconnected')
    })
    this.socket.on('http.request', (request: RelayHttpRequest, ack?: (response: RelayHttpResponse) => void) => {
      void this.handleHttpRequest(request)
        .then((response) => this.respond(response, ack))
        .catch((err) => this.respond(relayError(request?.id, 'relay_internal_error', err instanceof Error ? err.message : String(err), 500), ack))
    })
    this.socket.on('socket.open', (request: RelaySocketOpenRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.openLocalSocket(request), ack)
    })
    this.socket.on('socket.event', (request: RelaySocketEventRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.emitLocalSocketEvent(request), ack)
    })
    this.socket.on('socket.close', (request: RelaySocketCloseRequest, ack?: (response: RelaySocketResponse) => void) => {
      this.respondSocket(this.closeLocalSocket(request), ack)
    })
  }

  stop(): void {
    for (const bridge of this.socketBridges.values()) {
      bridge.socket.disconnect()
    }
    this.socketBridges.clear()
    this.socket?.disconnect()
    this.socket = null
  }

  async handleHttpRequest(request: RelayHttpRequest): Promise<RelayHttpResponse> {
    const method = normalizeMethod(request.method)
    if (!method) {
      return relayError(request.id, 'method_not_allowed', 'Relay request method is not allowed', 405)
    }

    const path = normalizeRelayPath(request.path)
    if (!path) {
      return relayError(request.id, 'path_not_allowed', 'Relay request path is not allowed', 403)
    }

    const headers = normalizeHeaders(request.headers)
    const normalizedBody = normalizeRequestBody(request, method, headers)
    if (isRelayHttpResponse(normalizedBody)) return normalizedBody
    if (normalizedBody.contentType) headers.set('content-type', normalizedBody.contentType)

    const timeoutMs = normalizeTimeout(request.timeoutMs)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await this.fetchImpl(`${this.localBaseUrl}${path}`, {
        method,
        headers,
        body: normalizedBody.body,
        signal: controller.signal,
      })
      const body = await readResponseBody(response)
      return {
        id: request.id,
        status: response.status,
        headers: responseHeaders(response),
        ...body,
      }
    } catch (err) {
      const aborted = controller.signal.aborted
      return relayError(
        request.id,
        aborted ? 'request_timeout' : 'local_request_failed',
        aborted ? `Local relay request timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
        aborted ? 504 : 502,
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  private respond(response: RelayHttpResponse, ack?: (response: RelayHttpResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('http.response', response)
  }

  private openLocalSocket(request: RelaySocketOpenRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const namespace = normalizeSocketNamespace(request.namespace)
    if (!namespace) return socketRelayError(id, 'namespace_not_allowed', 'Relay socket namespace is not allowed')

    this.closeLocalSocket({ id })
    const localSocket = io(`${this.localBaseUrl}${namespace}`, {
      auth: normalizeSocketAuth(request.auth),
      query: normalizeSocketQuery(request.query),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      timeout: 30_000,
    })
    const bridge: LocalSocketBridge = {
      id,
      namespace,
      socket: localSocket,
      stream: streamMode(request.stream),
      output: '',
      reasoning: '',
    }
    this.socketBridges.set(id, bridge)

    localSocket.on('connect', () => {
      this.emitSocketEvent({ id, namespace, event: 'connect', payload: { socketId: localSocket.id } })
    })
    localSocket.on('connect_error', (err: Error) => {
      this.emitSocketEvent({ id, namespace, event: 'connect_error', payload: { message: err.message } })
    })
    localSocket.on('disconnect', (reason: string) => {
      this.emitSocketEvent({ id, namespace, event: 'disconnect', payload: { reason } })
    })
    for (const event of CHAT_RUN_SERVER_EVENTS) {
      localSocket.on(event, (payload: unknown) => {
        this.handleLocalSocketEvent(bridge, event, payload)
      })
    }

    return { id, ok: true, namespace, stream: bridge.stream }
  }

  private emitLocalSocketEvent(request: RelaySocketEventRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const event = String(request.event || '').trim()
    if (!ALLOWED_CHAT_RUN_CLIENT_EVENTS.has(event)) {
      return socketRelayError(id, 'event_not_allowed', 'Relay socket event is not allowed')
    }

    const bridge = this.socketBridges.get(id)
    if (!bridge) return socketRelayError(id, 'socket_not_open', 'Relay socket is not open')
    if (typeof request.stream === 'boolean') {
      bridge.stream = request.stream
    }
    if (event === 'run') {
      bridge.output = ''
      bridge.reasoning = ''
    }

    bridge.socket.emit(event, request.payload)
    return { id, ok: true, namespace: bridge.namespace, event, stream: bridge.stream }
  }

  private closeLocalSocket(request: RelaySocketCloseRequest): RelaySocketResponse {
    const id = normalizeSocketBridgeId(request.id)
    if (!id) return socketRelayError(request.id, 'invalid_socket_id', 'Relay socket id is required')

    const bridge = this.socketBridges.get(id)
    if (!bridge) return { id, ok: true }
    bridge.socket.disconnect()
    this.socketBridges.delete(id)
    return { id, ok: true, namespace: bridge.namespace }
  }

  private emitSocketEvent(event: Required<Pick<RelaySocketResponse, 'id' | 'namespace' | 'event'>> & { payload?: unknown }): void {
    this.socket?.emit('socket.event', {
      id: event.id,
      namespace: event.namespace,
      event: event.event,
      payload: event.payload,
    })
  }

  private handleLocalSocketEvent(bridge: LocalSocketBridge, event: string, payload: unknown): void {
    if (!bridge.stream) {
      if (event === 'message.delta' && isRecord(payload) && typeof payload.delta === 'string') {
        bridge.output += payload.delta
        return
      }
      if ((event === 'reasoning.delta' || event === 'thinking.delta') && isRecord(payload)) {
        const delta = typeof payload.delta === 'string' ? payload.delta : typeof payload.text === 'string' ? payload.text : ''
        bridge.reasoning += delta
        return
      }
      if (NON_STREAMING_SUPPRESSED_EVENTS.has(event)) {
        return
      }
      if (event === 'run.completed') {
        this.emitSocketEvent({
          id: bridge.id,
          namespace: bridge.namespace,
          event,
          payload: this.withNonStreamingOutput(payload, bridge),
        })
        return
      }
    }

    this.emitSocketEvent({ id: bridge.id, namespace: bridge.namespace, event, payload })
  }

  private withNonStreamingOutput(payload: unknown, bridge: LocalSocketBridge): unknown {
    if (!isRecord(payload)) {
      return {
        output: bridge.output,
        ...(bridge.reasoning ? { reasoning: bridge.reasoning } : {}),
      }
    }
    return {
      ...payload,
      output: typeof payload.output === 'string' && payload.output ? payload.output : bridge.output,
      ...(bridge.reasoning && typeof payload.reasoning !== 'string' ? { reasoning: bridge.reasoning } : {}),
    }
  }

  private respondSocket(response: RelaySocketResponse, ack?: (response: RelaySocketResponse) => void): void {
    if (ack) {
      ack(response)
      return
    }
    this.socket?.emit('socket.response', response)
  }

  private redactedRelayUrl(): string {
    try {
      const url = new URL(this.relayUrl)
      url.username = ''
      url.password = ''
      return url.toString()
    } catch {
      return '<invalid-url>'
    }
  }
}

const activeClients = new Map<string, RelayClient>()

function normalizeOutboundRelayConnectionId(options: StartOutboundRelayClientOptions, relayUrl: string): string {
  return (options.connectionId || options.instanceId || relayUrl).trim()
}

export function startOutboundRelayClient(options: StartOutboundRelayClientOptions = {}): RelayClient | null {
  const relayUrl = (options.relayUrl ?? '').trim()
  if (!relayUrl) return null
  const connectionId = normalizeOutboundRelayConnectionId(options, relayUrl)
  const activeClient = activeClients.get(connectionId)
  if (activeClient) return activeClient

  const clientOptions: OutboundRelayClientOptions = {
    relayUrl,
    relayToken: options.relayToken ?? '',
    userToken: options.userToken ?? '',
    instanceId: options.instanceId ?? '',
    localBaseUrl: options.localBaseUrl ?? `http://127.0.0.1:${config.port}`,
    fetchImpl: options.fetchImpl ?? fetch,
  }
  const client = options.relayProtocol === 'websocket'
    ? new PlainWebSocketRelayClient(clientOptions)
    : new OutboundRelayClient(clientOptions)
  client.start()
  activeClients.set(connectionId, client)
  return client
}

export function getOutboundRelayClient(connectionId?: string): RelayClient | null {
  if (connectionId) return activeClients.get(connectionId) || null
  return activeClients.values().next().value || null
}

export function getOutboundRelayClients(): Map<string, RelayClient> {
  return new Map(activeClients)
}

export function stopOutboundRelayClient(connectionId?: string): void {
  if (connectionId) {
    activeClients.get(connectionId)?.stop()
    activeClients.delete(connectionId)
    return
  }
  for (const client of activeClients.values()) {
    client.stop()
  }
  activeClients.clear()
}
