import { computed, ref } from 'vue'
import {
  createVoiceEventSequencer,
  type CreateVoiceDialogueEventOptions,
  type VoiceDialogueEvent,
  type VoiceDialogueEventType,
} from '@/utils/voiceDialogueEvents'

export type TranscribeFn = (audio: Blob) => Promise<{ text: string }>
export type SendMessageFn = (text: string) => Promise<void> | void

export interface VoiceDialogueDeps {
  transcribe: TranscribeFn
  sendMessage: SendMessageFn
  stopOutputAudio?: () => void | Promise<void>
  stopActiveRun?: () => void
}

export type VoiceDialogueStatus = 'idle' | 'capturing' | 'transcribing' | 'sending' | 'error'

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function normalizeTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

export function useVoiceDialogue(deps: VoiceDialogueDeps) {
  const sessionId = id('voice-session')
  const nextEvent = createVoiceEventSequencer(sessionId)

  const events = ref<VoiceDialogueEvent[]>([])
  const status = ref<VoiceDialogueStatus>('idle')
  const activeCaptureId = ref<string | null>(null)
  const activeTurnId = ref<string | null>(null)
  const transcript = ref('')
  const error = ref<Error | null>(null)
  const isBusy = computed(() => status.value !== 'idle')

  function emit<TPayload = unknown>(
    type: VoiceDialogueEventType,
    options: CreateVoiceDialogueEventOptions<TPayload> = {},
  ) {
    const event = nextEvent(type, {
      ...options,
      captureId: options.captureId ?? activeCaptureId.value ?? undefined,
      turnId: options.turnId ?? activeTurnId.value ?? undefined,
    })

    events.value.push(event)
    if (events.value.length > 50) {
      events.value.splice(0, events.value.length - 50)
    }

    return event
  }

  function setErrorState(
    cause: unknown,
    options: { captureId?: string; turnId?: string } = {},
  ) {
    const normalizedError = normalizeError(cause)
    error.value = normalizedError
    status.value = 'error'
    emit('session.error', {
      captureId: options.captureId,
      turnId: options.turnId,
      final: true,
      payload: normalizedError,
    })
    return normalizedError
  }

  function cancelActiveLifecycle(options: { captureId?: string | null; turnId?: string | null } = {}) {
    const captureId = options.captureId ?? activeCaptureId.value
    const turnId = options.turnId ?? activeTurnId.value

    if (turnId) {
      emit('turn.cancelled', {
        captureId: captureId ?? undefined,
        turnId,
        final: true,
      })
    }

    if (captureId) {
      emit('capture.cancelled', {
        captureId,
        turnId: turnId ?? undefined,
        final: true,
      })
    }

    activeCaptureId.value = null
    activeTurnId.value = null
    transcript.value = ''
    error.value = null
    status.value = 'idle'
  }

  emit('session.started', { final: true })

  async function beginCapture() {
    try {
      await Promise.resolve(deps.stopOutputAudio?.())
    } catch (cause) {
      console.warn('[useVoiceDialogue] Failed to stop output audio before capture:', normalizeError(cause))
    }
    if (activeCaptureId.value || activeTurnId.value) {
      cancelActiveLifecycle()
    }
    error.value = null
    transcript.value = ''
    status.value = 'capturing'
    activeTurnId.value = null

    const captureId = id('capture')
    activeCaptureId.value = captureId
    emit('capture.started', { captureId })

    return { captureId }
  }

  async function commitTranscript(captureId: string, text: string) {
    if (activeCaptureId.value !== captureId) {
      return
    }

    const normalizedTranscript = normalizeTranscript(text)

    if (!normalizedTranscript) {
      transcript.value = ''
      cancelCapture(captureId)
      return
    }

    error.value = null
    transcript.value = normalizedTranscript
    status.value = 'sending'
    emit('transcript.done', {
      captureId,
      final: true,
      payload: { text: normalizedTranscript },
    })

    const turnId = id('turn')
    activeTurnId.value = turnId
    emit('turn.started', {
      captureId,
      turnId,
      payload: { text: normalizedTranscript },
    })

    try {
      await Promise.resolve(deps.sendMessage(normalizedTranscript))
    } catch (cause) {
      if (activeCaptureId.value === captureId && activeTurnId.value === turnId) {
        setErrorState(cause, { captureId, turnId })
        throw cause
      }
      return
    }

    if (activeCaptureId.value !== captureId || activeTurnId.value !== turnId) {
      return
    }

    emit('turn.ended', {
      captureId,
      turnId,
      final: true,
      payload: { text: normalizedTranscript },
    })

    activeCaptureId.value = null
    activeTurnId.value = null
    transcript.value = ''
    status.value = 'idle'
  }

  async function transcribeAndSend(captureId: string, audio: Blob) {
    if (activeCaptureId.value !== captureId) {
      return
    }

    error.value = null
    status.value = 'transcribing'

    try {
      const result = await deps.transcribe(audio)

      if (activeCaptureId.value !== captureId) {
        return
      }

      await commitTranscript(captureId, result.text)
    } catch (cause) {
      if (activeCaptureId.value === captureId) {
        if (error.value === null) {
          setErrorState(cause, {
            captureId,
            turnId: activeTurnId.value ?? undefined,
          })
        }
        throw cause
      }
      return
    }
  }

  function cancelCapture(captureId: string | null = activeCaptureId.value) {
    if (!captureId || activeCaptureId.value !== captureId) {
      return
    }

    cancelActiveLifecycle({
      captureId,
      turnId: activeTurnId.value,
    })
  }

  function markOutputStarted(payload?: unknown) {
    emit('output.audio.started', { payload })
  }

  function markOutputDone(payload?: unknown) {
    emit('output.audio.done', { final: true, payload })
  }

  return {
    sessionId,
    events,
    status,
    activeCaptureId,
    activeTurnId,
    transcript,
    error,
    isBusy,
    beginCapture,
    transcribeAndSend,
    commitTranscript,
    cancelCapture,
    markOutputStarted,
    markOutputDone,
  }
}
