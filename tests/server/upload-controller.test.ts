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

function multipartBody(boundary: string, name: string, content: string): Buffer {
  return Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${name}"`,
    'Content-Type: text/plain',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n'))
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
      req: Readable.from([multipartBody(boundary, 'note.txt', 'hello')]),
      state: { profile: { name: 'research' } },
      body: undefined,
      status: 200,
    }

    await handleUpload(ctx)

    expect(mkdirMock).toHaveBeenCalledWith('/tmp/hermes-web-ui/upload/research', { recursive: true })
    expect(writeFileMock).toHaveBeenCalledOnce()
    const [savedPath, data] = writeFileMock.mock.calls[0]
    expect(savedPath).toMatch(/^\/tmp\/hermes-web-ui\/upload\/research\/[a-f0-9]+\.txt$/)
    expect(data.toString('utf-8')).toBe('hello')
    expect(ctx.body.files[0]).toMatchObject({ name: 'note.txt', path: savedPath })
  })
})
