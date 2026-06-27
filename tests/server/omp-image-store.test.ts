import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'

// Mock the upload dir resolver to a throwaway tmp tree so the copy never touches
// the real Web UI home.
const h = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs')
  const { tmpdir } = require('os') as typeof import('os')
  const { join } = require('path') as typeof import('path')
  return { uploadBase: mkdtempSync(join(tmpdir(), 'omp-upload-')) }
})

vi.mock('../../packages/server/src/services/hermes/upload-paths', () => ({
  getProfileUploadDir: (profile: string) => join(h.uploadBase, profile),
}))

import { persistOmpToolImages } from '../../packages/server/src/services/hermes/run-chat/omp-image-store'

let srcDir: string

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), 'omp-src-'))
})

afterAll(() => {
  rmSync(h.uploadBase, { recursive: true, force: true })
})

describe('persistOmpToolImages', () => {
  it('copies an existing temp image into the durable upload dir', () => {
    const src = join(srcDir, 'omp-image-xyz.png')
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    writeFileSync(src, bytes)

    const out = persistOmpToolImages({ details: { imagePaths: [src] } }, 'default')

    expect(out).toHaveLength(1)
    expect(out[0]).not.toBe(src)
    expect(dirname(out[0])).toBe(join(h.uploadBase, 'default', 'omp-images'))
    expect(out[0].endsWith('.png')).toBe(true)
    expect(existsSync(out[0])).toBe(true)
    expect(readFileSync(out[0]).equals(bytes)).toBe(true)
    // original temp file is untouched (copy, not move)
    expect(existsSync(src)).toBe(true)
  })

  it('falls back to base64 bytes when the temp file is already gone', () => {
    const missing = join(srcDir, 'reaped.png')
    const data = Buffer.from('hello durable image').toString('base64')

    const out = persistOmpToolImages(
      { details: { imagePaths: [missing], images: [{ data, mimeType: 'image/webp' }] } },
      'alice',
    )

    expect(out).toHaveLength(1)
    expect(out[0]).not.toBe(missing)
    // extension comes from the mime type when the path has none to copy from
    expect(out[0].endsWith('.png')).toBe(true) // path already had .png
    expect(dirname(out[0])).toBe(join(h.uploadBase, 'alice', 'omp-images'))
    expect(readFileSync(out[0]).toString()).toBe('hello durable image')
  })

  it('derives extension from mime type when the source path has none', () => {
    const missing = join(srcDir, 'noext')
    const data = Buffer.from('webp bytes').toString('base64')

    const out = persistOmpToolImages(
      { details: { imagePaths: [missing], images: [{ data, mimeType: 'image/webp' }] } },
      'default',
    )

    expect(out[0].endsWith('.webp')).toBe(true)
  })

  it('returns the original path when neither file nor base64 is available', () => {
    const out = persistOmpToolImages({ details: { imagePaths: ['/tmp/omp-image-gone.png'] } }, 'nothing-to-persist')
    expect(out).toEqual(['/tmp/omp-image-gone.png'])
    // no upload dir is created when there is nothing to persist (deferred mkdir)
    expect(existsSync(join(h.uploadBase, 'nothing-to-persist', 'omp-images'))).toBe(false)
  })

  it('persists each image in order, falling back per entry', () => {
    const present = join(srcDir, 'present.png')
    writeFileSync(present, Buffer.from('one'))
    const missing = join(srcDir, 'missing.png')

    const out = persistOmpToolImages({ details: { imagePaths: [present, missing] } }, 'default')

    expect(out).toHaveLength(2)
    expect(out[0]).not.toBe(present)
    expect(existsSync(out[0])).toBe(true)
    expect(out[1]).toBe(missing) // no bytes available -> original path
  })

  it('returns empty for results without image paths', () => {
    expect(persistOmpToolImages({ details: {} }, 'default')).toEqual([])
    expect(persistOmpToolImages('nope', 'default')).toEqual([])
  })
})
