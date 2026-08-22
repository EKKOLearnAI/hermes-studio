import { Readable } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mkdirMock = vi.hoisted(() => vi.fn())
const writeFileMock = vi.hoisted(() => vi.fn())

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  return {
    ...actual,
    mkdir: mkdirMock,
    writeFile: writeFileMock,
  }
})

vi.mock('../../packages/server/src/services/hermes/hermes-profile', () => ({
  getActiveProfileName: vi.fn(() => 'default'),
}))

vi.mock('../../packages/server/src/services/hermes/upload-paths', () => ({
  getProfileUploadDir: vi.fn((profile: string) => `/tmp/hermes-web-ui/upload/${profile}`),
}))

function multipartBody(
  boundary: string,
  part: { filename?: string; filenameStar?: string; content: string },
): Buffer {
  const filename = part.filename ? `; filename="${part.filename}"` : ''
  const filenameStar = part.filenameStar ? `; filename*=UTF-8''${part.filenameStar}` : ''
  return Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"${filename}${filenameStar}`,
    'Content-Type: text/plain',
    '',
    part.content,
    `--${boundary}--`,
    '',
  ].join('\r\n'))
}

function normalizePath(value: unknown): string {
  return String(value).replace(/\\/g, '/')
}

describe('upload controller', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mkdirMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
  })

  it('stores chat uploads under the request-scoped profile upload directory', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filename: 'note.txt', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/hermes-web-ui/upload/research', { recursive: true })
    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath, data] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.txt$/)
    expect(data.toString('utf-8')).toBe('hello')
    expect(ctx.body.files[0]).toMatchObject({ name: 'note.txt', path: savedPath })
  })

  it('parses boundary parameters and RFC 5987 filenames for chat uploads', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type'
        ? `multipart/form-data; boundary=${boundary}; charset=utf-8`
        : ''),
      req: Readable.from([multipartBody(boundary, { filenameStar: 'daily%20report.txt', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath, data] = writeFileMock.mock.calls[0]
    expect(normalizePath(savedPath)).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.txt$/)
    expect(data.toString('utf-8')).toBe('hello')
    expect(ctx.body.files[0]).toMatchObject({ name: 'daily report.txt', path: savedPath })
  })

  it('answers 413 and finishes reading the body when an upload is too large', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    // Three chunks: the limit is crossed on the second, and the third is what a
    // still-writing client would send after the server has made up its mind.
    const chunk = Buffer.alloc(30 * 1024 * 1024, 0x61)
    const sent: number[] = []
    const req = new Readable({
      read() {
        if (sent.length >= 3) {
          this.push(null)
          return
        }
        sent.push(chunk.length)
        this.push(chunk)
      },
    })
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req,
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(ctx.status).toBe(413)
    expect(ctx.body).toEqual({ error: 'File too large (max 50MB)' })
    expect(writeFileMock).not.toHaveBeenCalled()
    // The whole body was read, so the client is not cut off mid-write and can
    // still read the reason it was refused.
    expect(sent.length).toBe(3)
    expect(req.readableEnded).toBe(true)
  })

  it('allows two minutes for a rejected upload body to drain', async () => {
    vi.useFakeTimers()
    try {
      const boundary = 'test-boundary'
      const { handleUpload } = await import('../../packages/server/src/controllers/upload')
      const chunk = Buffer.alloc(30 * 1024 * 1024, 0x61)
      let reads = 0
      const req = new Readable({
        read() {
          reads += 1
          if (reads <= 2) this.push(chunk)
          // Leave the request open after crossing the limit to exercise the
          // drain timeout without waiting in real time.
        },
      })
      const ctx: any = {
        get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
        req,
        state: { profile: { name: 'research' } },
        body: undefined,
        status: 200,
      }

      const upload = handleUpload(ctx)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(req.destroyed).toBe(false)
      expect(ctx.status).toBe(200)

      await vi.advanceTimersByTimeAsync(110_000)
      await upload

      expect(req.destroyed).toBe(true)
      expect(ctx.status).toBe(413)
      expect(ctx.body).toEqual({ error: 'File too large (max 50MB)' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 400 for malformed RFC 5987 filenames', async () => {
    const boundary = 'test-boundary'
    const { handleUpload } = await import('../../packages/server/src/controllers/upload')
    const ctx: any = {
      get: vi.fn((header: string) => header === 'content-type' ? `multipart/form-data; boundary=${boundary}` : ''),
      req: Readable.from([multipartBody(boundary, { filenameStar: 'bad%ZZname.txt', content: 'hello' })]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(ctx.status).toBe(400)
    expect(ctx.body).toEqual({ error: 'Malformed multipart filename' })
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
