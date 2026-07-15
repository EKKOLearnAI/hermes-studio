import { describe, expect, it } from 'vitest'

import { transcodeToPcmS16le } from '../../packages/server/src/services/hermes/stt-providers/audio-convert'

function wavS16le(samples: number[], sampleRate: number, channels = 1): Buffer {
  const dataSize = samples.length * 2
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  const data = Buffer.alloc(dataSize)
  samples.forEach((sample, index) => {
    data.writeInt16LE(sample, index * 2)
  })
  return Buffer.concat([header, data])
}

describe('audio-convert', () => {
  it('decodes WAV to MCU PCM without ffmpeg', async () => {
    const wav = wavS16le([0, 16384, -16384, 0], 8000)

    const result = await transcodeToPcmS16le(wav, 'audio/wav', { sampleRate: 16000 })

    expect(result.mimeType).toBe('audio/x-pcm')
    expect(result.fileName).toBe('audio.pcm')
    expect(result.audio.length).toBe(16)
  })

  it('rejects unsupported MCU PCM decode formats', async () => {
    await expect(
      transcodeToPcmS16le(Buffer.from('not audio'), 'audio/ogg', { sampleRate: 16000 }),
    ).rejects.toThrow('unsupported audio format for MCU PCM decode')
  })
})
