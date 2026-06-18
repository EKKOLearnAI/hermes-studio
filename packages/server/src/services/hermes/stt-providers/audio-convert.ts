import { spawn } from 'node:child_process'

const TRANSCODE_TIMEOUT_MS = 30_000

/**
 * Check whether ffmpeg is available on the system PATH.
 */
let ffmpegAvailable: boolean | null = null

function runFfmpeg(args: string[], input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []

    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('ffmpeg transcoding timed out'))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk))

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf-8').trim()
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`))
        return
      }
      resolve(Buffer.concat(chunks))
    })

    child.stdin.end(input)
  })
}

export async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable
  try {
    await runFfmpeg(['-version'], Buffer.alloc(0), 5_000)
    ffmpegAvailable = true
  } catch {
    ffmpegAvailable = false
  }
  return ffmpegAvailable
}

/**
 * Transcode an audio buffer to WAV (PCM 16-bit, 16 kHz, mono) using ffmpeg.
 *
 * Most OpenAI-compatible STT services expect mp3/wav.  Browser MediaRecorder
 * typically produces webm/opus which some upstreams cannot decode.  This
 * helper bridges that gap.
 *
 * Returns the original buffer unchanged when ffmpeg is not available.
 */
export async function transcodeToWav(
  input: Buffer,
  mimeType: string,
): Promise<{ audio: Buffer; mimeType: string; fileName: string }> {
  if (!(await isFfmpegAvailable())) {
    return { audio: input, mimeType, fileName: '' }
  }

  // Already a WAV – no conversion needed.
  if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') {
    return { audio: input, mimeType, fileName: '' }
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', 'pipe:0',          // read from stdin
    '-acodec', 'pcm_s16le',  // 16-bit PCM
    '-ar', '16000',          // 16 kHz sample rate
    '-ac', '1',              // mono
    '-f', 'wav',             // WAV container
    'pipe:1',                // write to stdout
  ]

  const wavBuffer = await runFfmpeg(args, input, TRANSCODE_TIMEOUT_MS)
  if (wavBuffer.length === 0) {
    throw new Error('ffmpeg produced empty output')
  }

  return {
    audio: wavBuffer,
    mimeType: 'audio/wav',
    fileName: 'audio.wav',
  }
}
