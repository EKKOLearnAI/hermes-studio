// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserSpeechRecognition } from '../../packages/client/src/composables/useBrowserSpeechRecognition'

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = []

  lang = ''
  interimResults = false
  continuous = false
  onresult: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  onend: (() => void) | null = null
  started = false
  stopCalls = 0
  abortCalls = 0

  constructor() {
    FakeSpeechRecognition.instances.push(this)
  }

  start() {
    this.started = true
  }

  stop() {
    this.stopCalls += 1
  }

  abort() {
    this.abortCalls += 1
  }

  emitResult(results: Array<{ transcript: string; isFinal: boolean }>, resultIndex = 0) {
    this.onresult?.({
      resultIndex,
      results: results.map(result => ({
        isFinal: result.isFinal,
        0: { transcript: result.transcript },
        length: 1,
      })),
    })
  }

  emitError(error: string) {
    this.onerror?.({ error })
  }

  emitEnd() {
    this.onend?.()
  }
}

function installSpeechRecognition(globalName: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'SpeechRecognition') {
  const browserWindow = window as Window & {
    SpeechRecognition?: typeof FakeSpeechRecognition
    webkitSpeechRecognition?: typeof FakeSpeechRecognition
  }

  delete browserWindow.SpeechRecognition
  delete browserWindow.webkitSpeechRecognition
  browserWindow[globalName] = FakeSpeechRecognition
}

function removeSpeechRecognition() {
  const browserWindow = window as Window & {
    SpeechRecognition?: typeof FakeSpeechRecognition
    webkitSpeechRecognition?: typeof FakeSpeechRecognition
  }

  delete browserWindow.SpeechRecognition
  delete browserWindow.webkitSpeechRecognition
  FakeSpeechRecognition.instances = []
}

describe('useBrowserSpeechRecognition', () => {
  beforeEach(() => {
    vi.useRealTimers()
    removeSpeechRecognition()
  })

  afterEach(() => {
    vi.useRealTimers()
    removeSpeechRecognition()
  })

  it('detects SpeechRecognition and webkitSpeechRecognition availability', () => {
    installSpeechRecognition('SpeechRecognition')
    expect(useBrowserSpeechRecognition().isSupported.value).toBe(true)

    removeSpeechRecognition()
    installSpeechRecognition('webkitSpeechRecognition')
    expect(useBrowserSpeechRecognition().isSupported.value).toBe(true)

    removeSpeechRecognition()
    expect(useBrowserSpeechRecognition().isSupported.value).toBe(false)
  })

  it('start creates a recognizer, applies language settings, and enters listening state', async () => {
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en-US' })

    const instance = FakeSpeechRecognition.instances[0]
    expect(instance).toBeDefined()
    expect(instance.lang).toBe('en-US')
    expect(instance.interimResults).toBe(true)
    expect(instance.continuous).toBe(false)
    expect(instance.started).toBe(true)
    expect(recognition.status.value).toBe('listening')
    expect(recognition.error.value).toBeNull()
  })

  it('records interim and final transcripts from onresult callbacks', async () => {
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en' })
    const instance = FakeSpeechRecognition.instances[0]

    instance.emitResult([{ transcript: ' hello  world ', isFinal: false }])
    expect(recognition.partialTranscript.value).toBe('hello world')
    expect(recognition.transcript.value).toBe('')

    instance.emitResult([{ transcript: ' hello  world ', isFinal: true }])
    expect(recognition.transcript.value).toBe('hello world')
    expect(recognition.partialTranscript.value).toBe('')
  })

  it('stop waits for final result and onend, then returns normalized transcript', async () => {
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en' })
    const instance = FakeSpeechRecognition.instances[0]
    const stopPromise = recognition.stop()

    expect(instance.stopCalls).toBe(1)
    expect(recognition.status.value).toBe('stopping')

    instance.emitResult([{ transcript: '  hello   hermes ', isFinal: true }])
    instance.emitEnd()

    await expect(stopPromise).resolves.toBe('hello hermes')
    expect(recognition.status.value).toBe('idle')
  })

  it('stop promotes the latest interim transcript when recognition ends without a final result', async () => {
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en' })
    const instance = FakeSpeechRecognition.instances[0]

    instance.emitResult([{ transcript: '  hello   from   interim ', isFinal: false }])

    const stopPromise = recognition.stop()

    expect(instance.stopCalls).toBe(1)
    instance.emitEnd()

    await expect(stopPromise).resolves.toBe('hello from interim')
    expect(recognition.status.value).toBe('idle')
  })

  it('stop timeout falls back to the latest interim transcript when no final result arrives', async () => {
    vi.useFakeTimers()
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en' })
    const instance = FakeSpeechRecognition.instances[0]
    instance.emitResult([{ transcript: '  hello   timeout   fallback ', isFinal: false }])

    const stopPromise = recognition.stop()

    expect(instance.stopCalls).toBe(1)

    await vi.advanceTimersByTimeAsync(1000)

    await expect(stopPromise).resolves.toBe('hello timeout fallback')
    expect(recognition.status.value).toBe('idle')
  })

  it('cancel aborts the active recognizer, clears state, and ignores stale final callbacks', async () => {
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en' })
    const instance = FakeSpeechRecognition.instances[0]

    recognition.cancel()

    expect(instance.abortCalls).toBe(1)
    expect(recognition.status.value).toBe('idle')
    expect(recognition.transcript.value).toBe('')
    expect(recognition.partialTranscript.value).toBe('')

    instance.emitResult([{ transcript: 'stale result', isFinal: true }])
    instance.emitEnd()

    expect(recognition.transcript.value).toBe('')
    expect(recognition.partialTranscript.value).toBe('')
  })

  it('ignores stale callbacks from older recognition sessions', async () => {
    installSpeechRecognition()
    const recognition = useBrowserSpeechRecognition()

    await recognition.start({ language: 'en' })
    const first = FakeSpeechRecognition.instances[0]

    await recognition.start({ language: 'fr' })
    const second = FakeSpeechRecognition.instances[1]

    first.emitResult([{ transcript: 'old transcript', isFinal: true }])
    first.emitEnd()

    expect(recognition.transcript.value).toBe('')
    expect(recognition.status.value).toBe('listening')

    second.emitResult([{ transcript: 'bonjour', isFinal: false }])
    expect(recognition.partialTranscript.value).toBe('bonjour')
  })

  it('reports a clear unsupported error when the browser API is unavailable', async () => {
    const recognition = useBrowserSpeechRecognition()

    await expect(recognition.start({ language: 'en' })).rejects.toThrow(
      'Browser speech recognition is not supported in this browser.',
    )
    expect(recognition.status.value).toBe('error')
    expect(recognition.error.value?.message).toBe('Browser speech recognition is not supported in this browser.')
  })
})
