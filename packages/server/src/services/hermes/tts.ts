import { EdgeTTS } from 'node-edge-tts'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile, unlink } from 'fs/promises'
import { randomUUID } from 'crypto'
import { logger } from '../logger'

const FIXED_VOICE = 'zh-CN-XiaoxiaoNeural'
const FIXED_RATE = '+4%'
const FIXED_PITCH = '+12Hz'

export interface TtsOptions {
  text: string
  lang?: string
  voice?: string
  rate?: string
  pitch?: string
}

export async function edgeTts(opts: TtsOptions): Promise<Buffer> {
  const id = randomUUID()
  const tmpFile = join(tmpdir(), `tts-${id}.mp3`)

  try {
    const tts = new EdgeTTS({
      voice: opts.voice || FIXED_VOICE,
      rate: opts.rate || FIXED_RATE,
      pitch: opts.pitch || FIXED_PITCH,
      timeout: 15000,
    })

    await tts.ttsPromise(opts.text, tmpFile)
    const buf = await readFile(tmpFile)
    return buf
  } finally {
    unlink(tmpFile).catch(() => {})
  }
}

export async function textToSpeech(opts: TtsOptions): Promise<{ audio: Buffer; engine: string }> {
  const voice = opts.voice || FIXED_VOICE
  const rate = opts.rate || FIXED_RATE
  const pitch = opts.pitch || FIXED_PITCH
  const audio = await edgeTts(opts)
  logger.debug({ engine: 'edge', voice, rate, pitch }, 'TTS generated via Edge')
  return { audio, engine: 'edge' }
}

/**
 * Convert speed multiplier (0.5-2.0) to Edge TTS rate string.
 * Edge TTS rate format: "+/-NN%"
 */
export function speedToEdgeRate(speed: number): string {
  const percent = Math.round((speed - 1) * 100)
  return percent >= 0 ? `+${percent}%` : `${percent}%`
}

/**
 * Convert OpenAI TTS request to internal TtsOptions.
 * OpenAI format: { model, input, voice, speed }
 */
export interface OpenaiTtsRequest {
  model?: string
  input: string
  voice?: string
  speed?: number
}

export async function openaiCompatibleTts(
  body: OpenaiTtsRequest,
): Promise<{ audio: Buffer; engine: string }> {
  return textToSpeech({
    text: body.input,
    voice: body.voice || FIXED_VOICE,
    rate: body.speed ? speedToEdgeRate(body.speed) : FIXED_RATE,
    pitch: FIXED_PITCH,
  })
}
