// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function flushPromises() {
  return Promise.resolve()
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = []
  static supportedTypes = new Set<string>(['audio/webm'])
  static stopDelayMs = 0
  static isTypeSupported = vi.fn((type: string) => MockMediaRecorder.supportedTypes.has(type))

  readonly stream: MediaStream
  readonly mimeType: string
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: { error?: unknown }) => void) | null = null
  start = vi.fn(() => {
    this.state = 'recording'
  })
  stop = vi.fn(() => {
    this.state = 'inactive'
    setTimeout(() => {
      this.onstop?.()
    }, MockMediaRecorder.stopDelayMs)
  })

  constructor(stream: MediaStream, options?: { mimeType?: string }) {
    this.stream = stream
    this.mimeType = options?.mimeType || 'audio/webm'
    MockMediaRecorder.instances.push(this)
  }

  emitData(blob: Blob) {
    this.ondataavailable?.({ data: blob })
  }
}

function createMockStream() {
  const track = { stop: vi.fn() }
  const stream = {
    getTracks: () => [track],
  } as unknown as MediaStream

  return { stream, track }
}

describe('useMicRecorder', () => {
  const getUserMedia = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useRealTimers()
    MockMediaRecorder.instances.length = 0
    MockMediaRecorder.supportedTypes = new Set(['audio/webm'])
    MockMediaRecorder.stopDelayMs = 0
    MockMediaRecorder.isTypeSupported.mockImplementation((type: string) => MockMediaRecorder.supportedTypes.has(type))
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
      },
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('records a blob and stops tracks', async () => {
    const { stream, track } = createMockStream()
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    await recorder.start()
    const mediaRecorder = MockMediaRecorder.instances[0]
    mediaRecorder.emitData(new Blob(['voice'], { type: 'audio/webm' }))
    mediaRecorder.emitData(new Blob([], { type: 'audio/webm' }))

    const blob = await recorder.stop()

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('audio/webm')
    expect(blob.size).toBeGreaterThan(0)
    expect(recorder.state.value.status).toBe('idle')
    expect(track.stop).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent stop calls while recorder stop is in flight', async () => {
    vi.useFakeTimers()
    MockMediaRecorder.stopDelayMs = 50
    const { stream, track } = createMockStream()
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    await recorder.start()
    const mediaRecorder = MockMediaRecorder.instances[0]
    mediaRecorder.emitData(new Blob(['voice'], { type: 'audio/webm' }))

    const first = recorder.stop()
    const second = recorder.stop()

    expect(mediaRecorder.stop).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('stopping')

    await vi.advanceTimersByTimeAsync(50)
    await flushPromises()

    const [firstBlob, secondBlob] = await Promise.all([first, second])

    expect(firstBlob).toBe(secondBlob)
    expect(firstBlob).toBeInstanceOf(Blob)
    expect(firstBlob.type).toBe('audio/webm')
    expect(firstBlob.size).toBeGreaterThan(0)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('idle')
    expect(recorder.isRecording.value).toBe(false)
  })

  it('reports permission errors', async () => {
    getUserMedia.mockRejectedValue(new Error('denied'))

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    await expect(recorder.start()).rejects.toThrow('denied')
    expect(recorder.state.value.status).toBe('error')
    expect(recorder.state.value.error?.message).toBe('denied')
  })

  it('throws a support error when microphone capture is unavailable', async () => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
    })

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    await expect(recorder.start()).rejects.toThrow(/not supported/i)
    expect(recorder.state.value.status).toBe('error')
  })

  it('cancel stops tracks and returns to idle', async () => {
    const { stream, track } = createMockStream()
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    await recorder.start()
    recorder.cancel()
    await flushPromises()

    expect(track.stop).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('idle')
    expect(recorder.isRecording.value).toBe(false)
  })

  it('stop during requesting cancels a stale pending start', async () => {
    const { stream, track } = createMockStream()
    let resolveStream!: (value: MediaStream) => void
    getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve
    }))

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    const startPromise = recorder.start()
    const onStartSettled = vi.fn()
    startPromise.then(onStartSettled)
    expect(recorder.state.value.status).toBe('requesting')

    await expect(recorder.stop()).resolves.toMatchObject({
      size: 0,
      type: 'audio/webm',
    })
    await flushPromises()

    expect(onStartSettled).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('idle')
    expect(recorder.isRecording.value).toBe(false)

    resolveStream(stream)
    await flushPromises()
    await startPromise

    expect(recorder.state.value.status).toBe('idle')
    expect(recorder.isRecording.value).toBe(false)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(MockMediaRecorder.instances).toHaveLength(0)
  })

  it('cancel during requesting cancels a stale pending start', async () => {
    const { stream, track } = createMockStream()
    let resolveStream!: (value: MediaStream) => void
    getUserMedia.mockImplementation(() => new Promise<MediaStream>((resolve) => {
      resolveStream = resolve
    }))

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    const startPromise = recorder.start()
    const onStartSettled = vi.fn()
    startPromise.then(onStartSettled)
    expect(recorder.state.value.status).toBe('requesting')

    recorder.cancel()
    await flushPromises()

    expect(onStartSettled).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('idle')
    expect(recorder.isRecording.value).toBe(false)

    resolveStream(stream)
    await flushPromises()
    await startPromise

    expect(recorder.state.value.status).toBe('idle')
    expect(recorder.isRecording.value).toBe(false)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(MockMediaRecorder.instances).toHaveLength(0)
  })

  it('returns an empty blob using the selected mime type when the active recorder is already inactive', async () => {
    const { stream, track } = createMockStream()
    MockMediaRecorder.supportedTypes = new Set(['audio/mp4'])
    MockMediaRecorder.isTypeSupported.mockImplementation((type: string) => MockMediaRecorder.supportedTypes.has(type))
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder({ mimeTypes: ['audio/mp4'] })

    await recorder.start()
    const mediaRecorder = MockMediaRecorder.instances[0]
    mediaRecorder.state = 'inactive'
    mediaRecorder.stop.mockImplementation(() => {
      throw new Error('inactive recorder.stop() should not be called')
    })

    await expect(recorder.stop()).resolves.toMatchObject({
      size: 0,
      type: 'audio/mp4',
    })
    expect(mediaRecorder.stop).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('idle')
  })

  it('preserves the selected mime type when stop is called after a recorder error clears the active recorder', async () => {
    const { stream, track } = createMockStream()
    MockMediaRecorder.supportedTypes = new Set(['audio/mp4'])
    MockMediaRecorder.isTypeSupported.mockImplementation((type: string) => MockMediaRecorder.supportedTypes.has(type))
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder({ mimeTypes: ['audio/mp4'] })

    await recorder.start()
    const mediaRecorder = MockMediaRecorder.instances[0]

    mediaRecorder.onerror?.({ error: new Error('boom') })

    expect(recorder.state.value.status).toBe('error')
    expect(recorder.state.value.mimeType).toBe('audio/mp4')
    expect(track.stop).toHaveBeenCalledOnce()

    await expect(recorder.stop()).resolves.toMatchObject({
      size: 0,
      type: 'audio/mp4',
    })
    expect(recorder.state.value.status).toBe('idle')
  })

  it('auto-stops at maxDurationMs', async () => {
    vi.useFakeTimers()
    const { stream, track } = createMockStream()
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder({ maxDurationMs: 1_000 })

    await recorder.start()
    const mediaRecorder = MockMediaRecorder.instances[0]
    mediaRecorder.emitData(new Blob(['voice'], { type: 'audio/webm' }))

    await vi.advanceTimersByTimeAsync(1_000)
    await vi.runOnlyPendingTimersAsync()
    await flushPromises()

    expect(mediaRecorder.stop).toHaveBeenCalledOnce()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(recorder.state.value.status).toBe('idle')
  })

  it('start while already recording is a no-op', async () => {
    const { stream } = createMockStream()
    getUserMedia.mockResolvedValue(stream)

    const { useMicRecorder } = await import('../../packages/client/src/composables/useMicRecorder')
    const recorder = useMicRecorder()

    await recorder.start()
    await recorder.start()

    expect(getUserMedia).toHaveBeenCalledOnce()
    expect(MockMediaRecorder.instances).toHaveLength(1)
    expect(MockMediaRecorder.instances[0]?.start).toHaveBeenCalledOnce()
  })
})
