import { computed, ref, shallowRef } from 'vue'

export type MicRecorderStatus = 'idle' | 'requesting' | 'recording' | 'stopping' | 'error'

export interface MicRecorderState {
  status: MicRecorderStatus
  error: Error | null
  startedAt: number | null
  mimeType: string | null
}

export interface MicRecorderOptions {
  constraints?: MediaStreamConstraints
  maxDurationMs?: number
  mimeTypes?: string[]
  messages?: {
    unsupported?: string
    recordingFailed?: string
  }
}

const DEFAULT_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/wav',
] as const

const DEFAULT_BLOB_TYPE = 'audio/webm'
const DEFAULT_MAX_DURATION_MS = 120_000
const SUPPORT_ERROR_MESSAGE = 'Microphone capture is not supported in this browser.'

export function useMicRecorder(options: MicRecorderOptions = {}) {
  const state = ref<MicRecorderState>({
    status: 'idle',
    error: null,
    startedAt: null,
    mimeType: null,
  })

  const isRecording = computed(() => state.value.status === 'recording')
  const streamRef = shallowRef<MediaStream | null>(null)

  let activeRecorder: MediaRecorder | null = null
  let activeStream: MediaStream | null = null
  let recordedChunks: Blob[] = []
  let maxDurationTimer: ReturnType<typeof setTimeout> | null = null
  let stopPromise: Promise<Blob> | null = null
  let resolvePendingStop: ((blob: Blob) => void) | null = null
  let rejectPendingStop: ((error: Error) => void) | null = null
  let pendingStartToken: number | null = null
  let resolvePendingStart: (() => void) | null = null
  let rejectPendingStart: ((error: Error) => void) | null = null
  let sessionToken = 0

  function setIdleState() {
    state.value = {
      status: 'idle',
      error: null,
      startedAt: null,
      mimeType: null,
    }
  }

  function setErrorState(error: unknown) {
    const normalizedError = normalizeError(error)
    state.value = {
      status: 'error',
      error: normalizedError,
      startedAt: null,
      mimeType: state.value.mimeType,
    }
    return normalizedError
  }

  function clearTimer() {
    if (maxDurationTimer !== null) {
      clearTimeout(maxDurationTimer)
      maxDurationTimer = null
    }
  }

  function stopTracks(stream: MediaStream | null) {
    if (!stream) {
      return
    }

    for (const track of stream.getTracks()) {
      track.stop()
    }
  }

  function clearSession({ stopStream = true, clearChunks = true }: { stopStream?: boolean; clearChunks?: boolean } = {}) {
    clearTimer()

    if (stopStream) {
      stopTracks(activeStream)
    }

    activeRecorder = null
    activeStream = null
    streamRef.value = null

    if (clearChunks) {
      recordedChunks = []
    }
  }

  function resolveStop(blob: Blob) {
    const resolver = resolvePendingStop
    stopPromise = null
    resolvePendingStop = null
    rejectPendingStop = null
    resolver?.(blob)
  }

  function rejectStop(error: Error) {
    const rejecter = rejectPendingStop
    stopPromise = null
    resolvePendingStop = null
    rejectPendingStop = null
    rejecter?.(error)
  }

  function cancelPendingStop() {
    if (!resolvePendingStop && !rejectPendingStop) {
      return
    }

    resolveStop(createEmptyBlob(state.value.mimeType ?? activeRecorder?.mimeType ?? null))
  }

  function resolveStart(token?: number) {
    if (token !== undefined && token !== pendingStartToken) {
      return
    }

    const resolver = resolvePendingStart
    pendingStartToken = null
    resolvePendingStart = null
    rejectPendingStart = null
    resolver?.()
  }

  function rejectStart(error: Error, token?: number) {
    if (token !== undefined && token !== pendingStartToken) {
      return
    }

    const rejecter = rejectPendingStart
    pendingStartToken = null
    resolvePendingStart = null
    rejectPendingStart = null
    rejecter?.(error)
  }

  function cancelPendingStart() {
    if (!resolvePendingStart && !rejectPendingStart) {
      return
    }

    resolveStart()
  }

  function createEmptyBlob(mimeType?: string | null) {
    return new Blob([], { type: mimeType || DEFAULT_BLOB_TYPE })
  }

  function getMediaRecorderConstructor(): typeof MediaRecorder | null {
    return typeof MediaRecorder === 'undefined' ? null : MediaRecorder
  }

  function ensureSupport() {
    const mediaRecorderConstructor = getMediaRecorderConstructor()

    if (!mediaRecorderConstructor || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(options.messages?.unsupported || SUPPORT_ERROR_MESSAGE)
    }

    return mediaRecorderConstructor
  }

  function selectMimeType(mediaRecorderConstructor: typeof MediaRecorder, preferredMimeTypes?: string[]) {
    const candidates = preferredMimeTypes?.length ? preferredMimeTypes : [...DEFAULT_MIME_TYPES]

    if (typeof mediaRecorderConstructor.isTypeSupported !== 'function') {
      return candidates[0]
    }

    return candidates.find(type => mediaRecorderConstructor.isTypeSupported(type))
  }

  function start() {
    if (state.value.status === 'recording' || state.value.status === 'requesting' || state.value.status === 'stopping') {
      return Promise.resolve()
    }

    try {
      const mediaRecorderConstructor = ensureSupport()
      const token = ++sessionToken

      state.value = {
        status: 'requesting',
        error: null,
        startedAt: null,
        mimeType: null,
      }

      return new Promise<void>((resolve, reject) => {
        pendingStartToken = token
        resolvePendingStart = resolve
        rejectPendingStart = reject

        void navigator.mediaDevices.getUserMedia(options.constraints ?? { audio: true }).then((stream) => {
          if (token !== sessionToken) {
            stopTracks(stream)
            resolveStart(token)
            return
          }

          const mimeType = selectMimeType(mediaRecorderConstructor, options.mimeTypes)
          const recorder = mimeType
            ? new mediaRecorderConstructor(stream, { mimeType })
            : new mediaRecorderConstructor(stream)

          activeStream = stream
          streamRef.value = stream
          activeRecorder = recorder
          recordedChunks = []

          recorder.ondataavailable = (event: BlobEvent | { data: Blob }) => {
            const chunk = event.data
            if (chunk && chunk.size > 0) {
              recordedChunks.push(chunk)
            }
          }

          recorder.onerror = (event: Event & { error?: unknown }) => {
            const error = setErrorState(event.error ?? new Error(options.messages?.recordingFailed || 'Microphone recording failed.'))
            clearSession()
            rejectStop(error)
          }

          recorder.start()

          state.value = {
            status: 'recording',
            error: null,
            startedAt: Date.now(),
            mimeType: recorder.mimeType || mimeType || DEFAULT_BLOB_TYPE,
          }

          maxDurationTimer = setTimeout(() => {
            void stop()
          }, options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS)

          resolveStart(token)
        }).catch((error) => {
          if (token !== sessionToken) {
            resolveStart(token)
            return
          }

          clearSession()
          rejectStart(setErrorState(error), token)
        })
      })
    } catch (error) {
      clearSession()
      return Promise.reject(setErrorState(error))
    }
  }

  async function stop() {
    if (state.value.status === 'requesting') {
      sessionToken += 1
      cancelPendingStart()
      clearSession()
      setIdleState()
      return createEmptyBlob()
    }

    const recorder = activeRecorder

    if (!recorder) {
      const mimeType = state.value.mimeType
      setIdleState()
      return createEmptyBlob(mimeType)
    }

    if (stopPromise) {
      return stopPromise
    }

    if (recorder.state === 'inactive') {
      const mimeType = recorder.mimeType || state.value.mimeType
      clearSession()
      setIdleState()
      return createEmptyBlob(mimeType)
    }

    state.value = {
      ...state.value,
      status: 'stopping',
      error: null,
    }

    clearTimer()

    stopPromise = new Promise<Blob>((resolve, reject) => {
      resolvePendingStop = resolve
      rejectPendingStop = reject

      const mimeType = recorder.mimeType || state.value.mimeType || DEFAULT_BLOB_TYPE

      recorder.onstop = () => {
        const blob = new Blob(recordedChunks, { type: mimeType })
        clearSession()
        setIdleState()
        resolveStop(blob)
      }

      recorder.onerror = (event: Event & { error?: unknown }) => {
        const error = setErrorState(event.error ?? new Error(options.messages?.recordingFailed || 'Microphone recording failed.'))
        clearSession()
        rejectStop(error)
      }

      try {
        recorder.stop()
      } catch (error) {
        const normalizedError = setErrorState(error)
        clearSession()
        rejectStop(normalizedError)
      }
    })

    return stopPromise
  }

  function cancel() {
    sessionToken += 1

    const recorder = activeRecorder

    clearTimer()

    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      recorder.onerror = null

      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // Ignore stop errors during cancellation.
        }
      }
    }

    clearSession()
    cancelPendingStart()
    cancelPendingStop()
    setIdleState()
  }

  return {
    state,
    isRecording,
    stream: streamRef,
    start,
    stop,
    cancel,
  }
}

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}
