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
}

export async function edgeTts(opts: TtsOptions): Promise<Buffer> {
  const id = randomUUID()
  const tmpFile = join(tmpdir(), `tts-${id}.mp3`)

  try {
    const tts = new EdgeTTS({
      voice: FIXED_VOICE,
      rate: FIXED_RATE,
      pitch: FIXED_PITCH,
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
  const audio = await edgeTts(opts)
  logger.debug({ engine: 'edge', voice: FIXED_VOICE, rate: FIXED_RATE, pitch: FIXED_PITCH }, 'TTS generated via Edge')
  return { audio, engine: 'edge' }
}
