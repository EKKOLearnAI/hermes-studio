import { ref } from 'vue'

export type BrowserSpeechRecognitionStatus = 'idle' | 'listening' | 'stopping' | 'error'

export interface BrowserSpeechRecognitionStartOptions {
  language?: string
}

interface SpeechRecognitionAlternativeLike {
  transcript?: string
}

interface SpeechRecognitionResultLike {
  isFinal?: boolean
  0?: SpeechRecognitionAlternativeLike
  length?: number
}

interface SpeechRecognitionResultListLike {
  length: number
  [index: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike {
  resultIndex?: number
  results?: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike {
  error?: string
}

interface BrowserSpeechRecognitionInstance {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognitionInstance

const UNSUPPORTED_ERROR_MESSAGE = 'Browser speech recognition is not supported in this browser.'
const STOP_TIMEOUT_MS = 1000

function normalizeError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function normalizeTranscript(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function joinTranscriptParts(parts: string[]) {
  return normalizeTranscript(parts.filter(Boolean).join(' '))
}

function transcriptFromResult(result: SpeechRecognitionResultLike | undefined) {
  return normalizeTranscript(result?.[0]?.transcript ?? '')
}

function collectResultText(event: SpeechRecognitionEventLike) {
  const results = event.results
  const startIndex = typeof event.resultIndex === 'number' ? event.resultIndex : 0
  const finalParts: string[] = []
  const interimParts: string[] = []

  if (!results || typeof results.length !== 'number') {
    return { finalText: '', interimText: '' }
  }

  for (let index = startIndex; index < results.length; index += 1) {
    const result = results[index]
    const transcript = transcriptFromResult(result)

    if (!transcript) {
      continue
    }

    if (result?.isFinal) {
      finalParts.push(transcript)
    } else {
      interimParts.push(transcript)
    }
  }

  return {
    finalText: joinTranscriptParts(finalParts),
    interimText: joinTranscriptParts(interimParts),
  }
}

function getSpeechRecognitionConstructor(): BrowserSpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') {
    return null
  }

  const browserWindow = window as Window & {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor
  }

  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null
}

export function useBrowserSpeechRecognition() {
  const isSupported = ref(Boolean(getSpeechRecognitionConstructor()))
  const status = ref<BrowserSpeechRecognitionStatus>('idle')
  const transcript = ref('')
  const partialTranscript = ref('')
  const error = ref<Error | null>(null)

  let activeRecognition: BrowserSpeechRecognitionInstance | null = null
  let sessionToken = 0
  let stopPromise: Promise<string> | null = null
  let resolvePendingStop: ((text: string) => void) | null = null
  let rejectPendingStop: ((error: Error) => void) | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null

  function clearStopTimer() {
    if (stopTimer !== null) {
      clearTimeout(stopTimer)
      stopTimer = null
    }
  }

  function clearPendingStop() {
    stopPromise = null
    resolvePendingStop = null
    rejectPendingStop = null
    clearStopTimer()
  }

  function detachRecognition(recognition: BrowserSpeechRecognitionInstance | null) {
    if (!recognition) {
      return
    }

    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
  }

  function resolveStop(text: string) {
    const resolve = resolvePendingStop
    clearPendingStop()
    resolve?.(normalizeTranscript(text))
  }

  function rejectStop(cause: unknown) {
    const reject = rejectPendingStop
    const normalizedError = normalizeError(cause)
    clearPendingStop()
    reject?.(normalizedError)
  }

  function resetState(options: { clearTranscript?: boolean; clearError?: boolean } = {}) {
    status.value = 'idle'
    if (options.clearTranscript) {
      transcript.value = ''
      partialTranscript.value = ''
    } else {
      partialTranscript.value = ''
    }
    if (options.clearError) {
      error.value = null
    }
  }

  function resolvedTranscriptText() {
    return transcript.value || partialTranscript.value
  }

  function clearError() {
    error.value = null
    if (status.value === 'error') {
      status.value = 'idle'
    }
  }

  function finishRecognition(token: number, text = resolvedTranscriptText()) {
    if (token !== sessionToken) {
      return
    }

    const recognition = activeRecognition
    activeRecognition = null
    detachRecognition(recognition)
    resetState()
    resolveStop(text)
  }

  function failRecognition(token: number, cause: unknown) {
    if (token !== sessionToken) {
      return normalizeError(cause)
    }

    const normalizedError = normalizeError(cause)
    const recognition = activeRecognition
    activeRecognition = null
    detachRecognition(recognition)
    partialTranscript.value = ''
    status.value = 'error'
    error.value = normalizedError
    rejectStop(normalizedError)
    return normalizedError
  }

  async function start(options: BrowserSpeechRecognitionStartOptions = {}) {
    const recognitionConstructor = getSpeechRecognitionConstructor()
    isSupported.value = Boolean(recognitionConstructor)

    if (!recognitionConstructor) {
      const unsupportedError = new Error(UNSUPPORTED_ERROR_MESSAGE)
      status.value = 'error'
      error.value = unsupportedError
      throw unsupportedError
    }

    cancel()

    const token = ++sessionToken
    const recognition = new recognitionConstructor()
    activeRecognition = recognition
    transcript.value = ''
    partialTranscript.value = ''
    error.value = null
    status.value = 'listening'

    recognition.lang = typeof options.language === 'string' ? options.language.trim() : ''
    recognition.interimResults = true
    recognition.continuous = false

    recognition.onresult = (event) => {
      if (token !== sessionToken || activeRecognition !== recognition) {
        return
      }

      const { finalText, interimText } = collectResultText(event)

      if (finalText) {
        transcript.value = joinTranscriptParts([transcript.value, finalText])
      }

      partialTranscript.value = interimText
    }

    recognition.onerror = (event) => {
      const detail = typeof event.error === 'string' && event.error.trim()
        ? `Browser speech recognition failed: ${event.error}.`
        : 'Browser speech recognition failed.'
      failRecognition(token, new Error(detail))
    }

    recognition.onend = () => {
      finishRecognition(token)
    }

    try {
      recognition.start()
    } catch (cause) {
      throw failRecognition(token, cause)
    }
  }

  function stop() {
    const token = sessionToken
    const recognition = activeRecognition

    if (!recognition) {
      if (status.value !== 'error') {
        resetState()
      }
      return Promise.resolve(normalizeTranscript(resolvedTranscriptText()))
    }

    if (stopPromise) {
      return stopPromise
    }

    status.value = 'stopping'

    stopPromise = new Promise<string>((resolve, reject) => {
      resolvePendingStop = resolve
      rejectPendingStop = reject
      clearStopTimer()
      stopTimer = setTimeout(() => {
        finishRecognition(token)
      }, STOP_TIMEOUT_MS)

      try {
        recognition.stop()
      } catch (cause) {
        failRecognition(token, cause)
      }
    })

    return stopPromise
  }

  function cancel() {
    sessionToken += 1

    const recognition = activeRecognition
    activeRecognition = null
    detachRecognition(recognition)

    try {
      recognition?.abort()
    } catch {
      // Ignore abort errors during cancellation.
    }

    resolveStop('')
    resetState({ clearTranscript: true, clearError: true })
  }

  return {
    isSupported,
    status,
    transcript,
    partialTranscript,
    error,
    start,
    stop,
    cancel,
    clearError,
  }
}
