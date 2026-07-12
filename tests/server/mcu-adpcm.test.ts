import { describe, expect, it } from 'vitest'
import {
  decodeMcuImaAdpcm,
  encodeMcuImaAdpcm,
} from '../../packages/server/src/services/hermes/mcu-adpcm'

function pcmBuffer(samples: number[]): Buffer {
  const pcm = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => pcm.writeInt16LE(sample, index * 2))
  return pcm
}

describe('MCU IMA-ADPCM', () => {
  it('round-trips mono PCM with the expected HADP framing', () => {
    const pcm = pcmBuffer([0, 1200, 2400, 1000, -500, -2200, -800, 300, 1500])
    const encoded = encodeMcuImaAdpcm(pcm, 16000)
    const decoded = decodeMcuImaAdpcm(encoded)

    expect(encoded.toString('ascii', 0, 4)).toBe('HADP')
    expect(encoded.length).toBe(20 + Math.ceil((pcm.length / 2 - 1) / 2))
    expect(decoded.sampleRate).toBe(16000)
    expect(decoded.channels).toBe(1)
    expect(decoded.pcm.length).toBe(pcm.length)
    expect(decoded.pcm.readInt16LE(0)).toBe(pcm.readInt16LE(0))
  })

  it('rejects truncated HADP chunks before allocating decoded PCM', () => {
    const encoded = encodeMcuImaAdpcm(pcmBuffer([0, 1000, 2000, 3000]), 16000)

    expect(() => decodeMcuImaAdpcm(encoded.subarray(0, -1))).toThrow('size does not match')
  })
})
