import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'

import { transcodeToMp3 } from '../../packages/server/src/modules/studio/services/voice/stt/audio-convert'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

function wavTone(seconds = 0.2, sampleRate = 8000): Buffer {
  const samples = Math.floor(seconds * sampleRate)
  const data = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 8000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function looksLikeMp3(buffer: Buffer): boolean {
  return (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33)
    || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
}

describe('transcodeToMp3', () => {
  it('leaves mp3 audio untouched', async () => {
    const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02])
    const result = await transcodeToMp3(mp3, 'audio/mpeg')

    expect(result.audio).toBe(mp3)
    expect(result.mimeType).toBe('audio/mpeg')
  })

  it('recognizes mp3 by its bytes even when the content type lies', async () => {
    const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00])
    const result = await transcodeToMp3(mp3, 'application/octet-stream')

    expect(result.audio).toBe(mp3)
    expect(result.mimeType).toBe('audio/mpeg')
  })

  it.runIf(hasFfmpeg)('converts wav to real mp3, which is what Hermes writes to its .mp3 path', async () => {
    const result = await transcodeToMp3(wavTone(), 'audio/wav')

    expect(result.mimeType).toBe('audio/mpeg')
    expect(result.audio.length).toBeGreaterThan(0)
    expect(looksLikeMp3(result.audio)).toBe(true)
  })

  it.runIf(hasFfmpeg)('trusts wav bytes over an incorrect mp3 content type', async () => {
    const wav = wavTone()
    const result = await transcodeToMp3(wav, 'audio/mpeg')

    expect(result.audio).not.toBe(wav)
    expect(result.mimeType).toBe('audio/mpeg')
    expect(looksLikeMp3(result.audio)).toBe(true)
  })
})
