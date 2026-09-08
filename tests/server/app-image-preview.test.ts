import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppImagePreview } from '../../packages/server/src/modules/studio/services/files/app-image-preview'

afterEach(() => {
  vi.doUnmock('sharp')
  vi.resetModules()
})

describe('createAppImagePreview', () => {
  it('downscales large images and encodes an App WebP preview', async () => {
    const source = solidPng(3000, 1200, [53, 88, 212, 255])
    const result = await createAppImagePreview(source, 'image/png')

    expect(result.optimized).toBe(true)
    expect(result.mime).toBe('image/webp')
    expect(result.width).toBe(2048)
    expect(result.height).toBe(819)
    expect(result.data.subarray(0, 4).toString()).toBe('RIFF')
    expect(result.data.subarray(8, 12).toString()).toBe('WEBP')
    expect(result.originalBytes).toBe(source.length)
  })

  it('supports a small avatar-specific preview preset', async () => {
    const source = solidPng(640, 480, [53, 88, 212, 255])
    const result = await createAppImagePreview(source, 'image/png', {
      maxEdge: 128,
      quality: 65,
      preserveAnimation: false,
    })

    expect(result.optimized).toBe(true)
    expect(result.mime).toBe('image/webp')
    expect(result.width).toBe(128)
    expect(result.height).toBe(96)
    expect(result.data.length).toBeLessThan(source.length)
  })

  it('does not alter non-image downloads', async () => {
    const source = Buffer.from('hello')
    const result = await createAppImagePreview(source, 'text/plain')

    expect(result.optimized).toBe(false)
    expect(result.mime).toBe('text/plain')
    expect(result.data).toBe(source)
  })

  it('does not load Sharp for non-image downloads', async () => {
    vi.resetModules()
    vi.doMock('sharp', () => {
      throw new Error('Sharp should not load')
    })
    const { createAppImagePreview: createWithoutSharp } = await import(
      '../../packages/server/src/modules/studio/services/files/app-image-preview'
    )
    const source = Buffer.from('hello')

    const result = await createWithoutSharp(source, 'text/plain')

    expect(result.optimized).toBe(false)
    expect(result.data).toBe(source)
  })

  it('returns the original image when Sharp cannot load', async () => {
    vi.resetModules()
    vi.doMock('sharp', () => {
      throw new Error('Native Sharp runtime unavailable')
    })
    const { createAppImagePreview: createWithoutSharp } = await import(
      '../../packages/server/src/modules/studio/services/files/app-image-preview'
    )
    const source = solidPng(4, 4, [53, 88, 212, 255])

    const result = await createWithoutSharp(source, 'image/png')

    expect(result).toEqual({
      data: source,
      mime: 'image/png',
      optimized: false,
      originalBytes: source.length,
    })
  })
})

function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 4)
  row[0] = 0
  for (let offset = 1; offset < row.length; offset += 4) {
    row[offset] = rgba[0]
    row[offset + 1] = rgba[1]
    row[offset + 2] = rgba[2]
    row[offset + 3] = rgba[3]
  }
  const pixels = Buffer.alloc(row.length * height)
  for (let index = 0; index < height; index += 1) row.copy(pixels, index * row.length)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const payload = Buffer.concat([name, data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(payload))
  return Buffer.concat([length, payload, checksum])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
