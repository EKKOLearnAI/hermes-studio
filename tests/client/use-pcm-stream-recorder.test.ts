// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePcmWav, usePcmStreamRecorder } from '../../packages/client/src/composables/usePcmStreamRecorder'

class FakeScriptProcessor {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null
  connect = vi.fn()
  disconnect = vi.fn()

  emit(samples: Float32Array) {
    this.onaudioprocess?.({
      inputBuffer: {
        length: samples.length,
        numberOfChannels: 1,
        getChannelData: () => samples,
      },
    } as unknown as AudioProcessingEvent)
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = []
  readonly sampleRate = 48_000
  readonly destination = {} as AudioDestinationNode
  readonly processor = new FakeScriptProcessor()
  readonly source = { connect: vi.fn(), disconnect: vi.fn() }
  readonly gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  state: AudioContextState = 'running'
  createMediaStreamSource = vi.fn(() => this.source)
  createScriptProcessor = vi.fn(() => this.processor)
  createGain = vi.fn(() => this.gain)
  resume = vi.fn().mockResolvedValue(undefined)
  close = vi.fn(async () => { this.state = 'closed' })

  constructor() {
    FakeAudioContext.instances.push(this)
  }
}

function mockStream() {
  const track = { stop: vi.fn() }
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    track,
  }
}

describe('usePcmStreamRecorder', () => {
  const getUserMedia = vi.fn()

  beforeEach(() => {
    FakeAudioContext.instances = []
    vi.stubGlobal('AudioContext', FakeAudioContext)
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('encodes mono 16-bit PCM with a valid 16 kHz WAV header', async () => {
    const audio = encodePcmWav(new Float32Array(48_000).fill(0.25), 48_000, 16_000)
    const view = new DataView(await readBlob(audio))

    expect(audio.type).toBe('audio/wav')
    expect(String.fromCharCode(...new Uint8Array(view.buffer, 0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...new Uint8Array(view.buffer, 8, 4))).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(audio.size).toBe(32_044)
  })

  it('emits a WAV segment at a natural pause without using MediaRecorder or Opus', async () => {
    const { stream, track } = mockStream()
    getUserMedia.mockResolvedValue(stream)
    const onChunk = vi.fn()
    const recorder = usePcmStreamRecorder({
      minSegmentDurationMs: 300,
      speechEndSilenceMs: 200,
      voiceActivityThreshold: 0.035,
      onChunk,
    })

    await recorder.start()
    const context = FakeAudioContext.instances[0]
    for (let index = 0; index < 12; index += 1) {
      context.processor.emit(new Float32Array(4_096).fill(0.1))
    }
    for (let index = 0; index < 3; index += 1) {
      context.processor.emit(new Float32Array(4_096))
    }

    expect(onChunk).toHaveBeenCalledOnce()
    expect(onChunk.mock.calls[0][0]).toMatchObject({ type: 'audio/wav' })
    expect(onChunk.mock.calls[0][0].size).toBeGreaterThan(44)
    expect(recorder.level.value).toBeGreaterThan(0)
    expect(recorder.hasSpeech.value).toBe(true)

    await expect(recorder.stop()).resolves.toBeNull()
    expect(track.stop).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    expect(recorder.status.value).toBe('idle')
  })

  it('flushes a final WAV fragment when capture stops between chunks', async () => {
    const { stream } = mockStream()
    getUserMedia.mockResolvedValue(stream)
    const recorder = usePcmStreamRecorder({ maxSegmentDurationMs: 3_000, voiceActivityThreshold: 0.035 })

    await recorder.start()
    const context = FakeAudioContext.instances[0]
    for (let index = 0; index < 5; index += 1) {
      context.processor.emit(new Float32Array(4_096).fill(0.1))
    }

    const finalChunk = await recorder.stop()
    expect(finalChunk).toMatchObject({ type: 'audio/wav' })
    expect(finalChunk?.size).toBeGreaterThan(44)
  })

  it('drops pure silence instead of sending it to STT', async () => {
    const { stream } = mockStream()
    getUserMedia.mockResolvedValue(stream)
    const onChunk = vi.fn()
    const recorder = usePcmStreamRecorder({
      maxSegmentDurationMs: 1_000,
      voiceActivityThreshold: 0.035,
      onChunk,
    })

    await recorder.start()
    const context = FakeAudioContext.instances[0]
    for (let index = 0; index < 16; index += 1) {
      context.processor.emit(new Float32Array(4_096))
    }

    expect(onChunk).not.toHaveBeenCalled()
    await expect(recorder.stop()).resolves.toBeNull()
  })

  it('does not confirm speech from microphone startup noise', async () => {
    const { stream } = mockStream()
    getUserMedia.mockResolvedValue(stream)
    const onChunk = vi.fn()
    const recorder = usePcmStreamRecorder({
      voiceActivityThreshold: 0.035,
      onChunk,
    })

    await recorder.start()
    const context = FakeAudioContext.instances[0]
    for (let index = 0; index < 5; index += 1) {
      context.processor.emit(new Float32Array(4_096).fill(0.1))
    }
    for (let index = 0; index < 12; index += 1) {
      context.processor.emit(new Float32Array(4_096))
    }

    expect(recorder.hasSpeech.value).toBe(false)
    expect(onChunk).not.toHaveBeenCalled()
    await expect(recorder.stop()).resolves.toBeNull()
  })

  it('uses the maximum segment duration only as a continuous-speech safeguard', async () => {
    const { stream } = mockStream()
    getUserMedia.mockResolvedValue(stream)
    const onChunk = vi.fn()
    const recorder = usePcmStreamRecorder({
      maxSegmentDurationMs: 1_000,
      voiceActivityThreshold: 0.035,
      onChunk,
    })

    await recorder.start()
    const context = FakeAudioContext.instances[0]
    for (let index = 0; index < 20; index += 1) {
      context.processor.emit(new Float32Array(4_096).fill(0.1))
    }

    expect(onChunk).toHaveBeenCalledOnce()
    expect(recorder.status.value).toBe('recording')
    recorder.cancel()
  })
})

function readBlob(blob: Blob) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}
