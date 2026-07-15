import { computed, ref, shallowRef } from 'vue'

export type PcmStreamRecorderStatus = 'idle' | 'requesting' | 'recording' | 'error'

export interface PcmStreamRecorderOptions {
  minSegmentDurationMs?: number
  maxSegmentDurationMs?: number
  speechEndSilenceMs?: number
  preRollMs?: number
  targetSampleRate?: number
  voiceActivityThreshold?: number
  constraints?: MediaStreamConstraints
  onChunk?: (audio: Blob) => void
  messages?: {
    unsupported?: string
    recordingFailed?: string
  }
}

const DEFAULT_MIN_SEGMENT_DURATION_MS = 700
const DEFAULT_MAX_SEGMENT_DURATION_MS = 8_000
const DEFAULT_SPEECH_END_SILENCE_MS = 700
const DEFAULT_PRE_ROLL_MS = 250
const DEFAULT_TARGET_SAMPLE_RATE = 16_000
const DEFAULT_VOICE_ACTIVITY_THRESHOLD = 0.035
const MIN_FINAL_CHUNK_MS = 350
const MIN_VOICE_ACTIVITY_MS = 350
const STREAM_WARMUP_MS = 500
const SUPPORT_ERROR_MESSAGE = 'Streaming microphone capture is not supported in this browser.'

export function encodePcmWav(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = DEFAULT_TARGET_SAMPLE_RATE,
): Blob {
  const samples = normalizeSpeechLevel(resampleLinear(input, sourceSampleRate, targetSampleRate))
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, targetSampleRate, true)
  view.setUint32(28, targetSampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

export function usePcmStreamRecorder(options: PcmStreamRecorderOptions = {}) {
  const status = ref<PcmStreamRecorderStatus>('idle')
  const error = ref<Error | null>(null)
  const level = ref(0)
  const hasSpeech = ref(false)
  const stream = shallowRef<MediaStream | null>(null)
  const isRecording = computed(() => status.value === 'recording')

  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let activeStream: MediaStream | null = null
  let sampleRate = DEFAULT_TARGET_SAMPLE_RATE
  let bufferedSamples: Float32Array[] = []
  let bufferedSampleCount = 0
  let bufferedSampleOffset = 0
  let bufferedHasVoice = false
  let voicedSampleCount = 0
  let trailingSilenceSamples = 0
  let capturedSampleCount = 0
  let consecutiveVoiceSampleCount = 0
  let sessionToken = 0

  function setError(cause: unknown) {
    const normalized = cause instanceof Error
      ? cause
      : new Error(options.messages?.recordingFailed || String(cause))
    error.value = normalized
    status.value = 'error'
    return normalized
  }

  function stopTracks(mediaStream: MediaStream | null) {
    for (const track of mediaStream?.getTracks() || []) track.stop()
  }

  function clearAudioGraph() {
    if (processor) processor.onaudioprocess = null
    try { processor?.disconnect() } catch { /* already disconnected */ }
    try { source?.disconnect() } catch { /* already disconnected */ }
    processor = null
    source = null
  }

  async function releaseResources() {
    clearAudioGraph()
    const closingContext = context
    context = null
    stopTracks(activeStream)
    activeStream = null
    stream.value = null
    level.value = 0
    if (closingContext && closingContext.state !== 'closed') {
      await closingContext.close().catch(() => undefined)
    }
  }

  function resetBuffer() {
    bufferedSamples = []
    bufferedSampleCount = 0
    bufferedSampleOffset = 0
    bufferedHasVoice = false
    voicedSampleCount = 0
    trailingSilenceSamples = 0
  }

  function resetCaptureState() {
    resetBuffer()
    capturedSampleCount = 0
    consecutiveVoiceSampleCount = 0
    hasSpeech.value = false
  }

  function takeSamples(count: number) {
    const output = new Float32Array(count)
    let outputOffset = 0

    while (outputOffset < count && bufferedSamples.length > 0) {
      const first = bufferedSamples[0]
      const available = first.length - bufferedSampleOffset
      const take = Math.min(available, count - outputOffset)
      output.set(first.subarray(bufferedSampleOffset, bufferedSampleOffset + take), outputOffset)
      outputOffset += take
      bufferedSampleOffset += take
      bufferedSampleCount -= take
      if (bufferedSampleOffset >= first.length) {
        bufferedSamples.shift()
        bufferedSampleOffset = 0
      }
    }

    return output
  }

  function emitReadySegment() {
    const minSamples = sampleRate * Math.max(250, options.minSegmentDurationMs ?? DEFAULT_MIN_SEGMENT_DURATION_MS) / 1_000
    const maxSamples = sampleRate * Math.max(1_000, options.maxSegmentDurationMs ?? DEFAULT_MAX_SEGMENT_DURATION_MS) / 1_000
    const endSilenceSamples = sampleRate * Math.max(200, options.speechEndSilenceMs ?? DEFAULT_SPEECH_END_SILENCE_MS) / 1_000
    const preRollSamples = sampleRate * Math.max(0, options.preRollMs ?? DEFAULT_PRE_ROLL_MS) / 1_000
    const minVoiceSamples = sampleRate * MIN_VOICE_ACTIVITY_MS / 1_000

    if (!bufferedHasVoice) {
      // Single-shot capture (the settings STT test) keeps the whole recording;
      // startup trimming is only useful for continuous realtime segmentation.
      if (!options.onChunk) return
      if (bufferedSampleCount > preRollSamples) takeSamples(bufferedSampleCount - Math.floor(preRollSamples))
      return
    }

    // Without a chunk consumer this acts as a single-shot WAV recorder and
    // keeps the complete utterance buffered until stop() is called.
    if (!options.onChunk) return

    const reachedNaturalPause = bufferedSampleCount >= minSamples
      && voicedSampleCount >= minVoiceSamples
      && trailingSilenceSamples >= endSilenceSamples
    if (!reachedNaturalPause && bufferedSampleCount < maxSamples) return
    if (voicedSampleCount < minVoiceSamples) {
      resetBuffer()
      return
    }

    const segment = takeSamples(bufferedSampleCount)
    options.onChunk(encodePcmWav(segment, sampleRate, options.targetSampleRate))
    bufferedHasVoice = false
    voicedSampleCount = 0
    trailingSilenceSamples = 0
  }

  function appendAudio(event: AudioProcessingEvent) {
    const input = event.inputBuffer
    if (!input.length || !input.numberOfChannels) return

    const mono = new Float32Array(input.length)
    let squareSum = 0
    for (let channelIndex = 0; channelIndex < input.numberOfChannels; channelIndex += 1) {
      const channel = input.getChannelData(channelIndex)
      for (let sampleIndex = 0; sampleIndex < input.length; sampleIndex += 1) {
        mono[sampleIndex] += channel[sampleIndex] / input.numberOfChannels
      }
    }
    for (let index = 0; index < mono.length; index += 1) squareSum += mono[index] * mono[index]
    const rms = Math.sqrt(squareSum / mono.length)
    const nextLevel = Math.min(1, rms * 5)
    level.value += (nextLevel - level.value) * 0.45
    capturedSampleCount += mono.length
    const warmupSamples = options.onChunk ? sampleRate * STREAM_WARMUP_MS / 1_000 : 0
    const aboveVoiceThreshold = capturedSampleCount > warmupSamples
      && nextLevel >= (options.voiceActivityThreshold ?? DEFAULT_VOICE_ACTIVITY_THRESHOLD)

    if (aboveVoiceThreshold) {
      consecutiveVoiceSampleCount += mono.length
      voicedSampleCount += mono.length
      if (consecutiveVoiceSampleCount >= sampleRate * MIN_VOICE_ACTIVITY_MS / 1_000) {
        hasSpeech.value = true
        bufferedHasVoice = true
      }
      if (bufferedHasVoice) trailingSilenceSamples = 0
    } else {
      consecutiveVoiceSampleCount = 0
      if (!bufferedHasVoice) voicedSampleCount = 0
      else trailingSilenceSamples += mono.length
    }

    bufferedSamples.push(mono)
    bufferedSampleCount += mono.length
    emitReadySegment()
  }

  async function start() {
    if (status.value === 'requesting' || status.value === 'recording') return
    const AudioContextConstructor = window.AudioContext
    if (!navigator.mediaDevices?.getUserMedia || !AudioContextConstructor) {
      throw setError(new Error(options.messages?.unsupported || SUPPORT_ERROR_MESSAGE))
    }

    const token = ++sessionToken
    status.value = 'requesting'
    error.value = null
    resetCaptureState()

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia(options.constraints ?? {
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (token !== sessionToken) {
        stopTracks(mediaStream)
        return
      }

      const audioContext = new AudioContextConstructor()
      const inputSource = audioContext.createMediaStreamSource(mediaStream)
      const scriptProcessor = audioContext.createScriptProcessor(4_096, 1, 1)
      scriptProcessor.onaudioprocess = appendAudio
      inputSource.connect(scriptProcessor)
      // ScriptProcessor output buffers are silent unless explicitly written.
      // Connecting directly keeps Chromium from optimizing away a zero-gain
      // branch while still preventing microphone monitoring/echo.
      scriptProcessor.connect(audioContext.destination)

      context = audioContext
      source = inputSource
      processor = scriptProcessor
      activeStream = mediaStream
      stream.value = mediaStream
      sampleRate = audioContext.sampleRate
      await audioContext.resume()

      if (token !== sessionToken) {
        scriptProcessor.onaudioprocess = null
        inputSource.disconnect()
        scriptProcessor.disconnect()
        stopTracks(mediaStream)
        await audioContext.close().catch(() => undefined)
        return
      }

      status.value = 'recording'
    } catch (cause) {
      if (token !== sessionToken) return
      await releaseResources()
      throw setError(cause)
    }
  }

  async function stop() {
    sessionToken += 1
    const remainingDurationMs = bufferedSampleCount / sampleRate * 1_000
    const finalChunk = remainingDurationMs >= MIN_FINAL_CHUNK_MS
      && bufferedHasVoice
      && voicedSampleCount >= sampleRate * MIN_VOICE_ACTIVITY_MS / 1_000
      ? encodePcmWav(takeSamples(bufferedSampleCount), sampleRate, options.targetSampleRate)
      : null
    resetCaptureState()
    await releaseResources()
    status.value = 'idle'
    error.value = null
    return finalChunk
  }

  function cancel() {
    sessionToken += 1
    resetCaptureState()
    void releaseResources()
    status.value = 'idle'
    error.value = null
  }

  return {
    status,
    error,
    level,
    hasSpeech,
    stream,
    isRecording,
    start,
    stop,
    cancel,
  }
}

function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number) {
  if (!input.length || sourceRate === targetRate) return input
  const length = Math.max(1, Math.round(input.length * targetRate / sourceRate))
  const output = new Float32Array(length)
  const ratio = sourceRate / targetRate
  for (let index = 0; index < length; index += 1) {
    const position = index * ratio
    const left = Math.floor(position)
    const right = Math.min(input.length - 1, left + 1)
    const weight = position - left
    output[index] = input[left] * (1 - weight) + input[right] * weight
  }
  return output
}

function normalizeSpeechLevel(input: Float32Array) {
  if (!input.length) return input
  let peak = 0
  let squareSum = 0
  for (const sample of input) {
    const absolute = Math.abs(sample)
    peak = Math.max(peak, absolute)
    squareSum += sample * sample
  }
  const rms = Math.sqrt(squareSum / input.length)
  if (peak <= 0 || rms <= 0) return input

  const gain = Math.min(8, 0.92 / peak, 0.1 / rms)
  if (gain <= 1.05) return input
  const output = new Float32Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, input[index] * gain))
  }
  return output
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}
