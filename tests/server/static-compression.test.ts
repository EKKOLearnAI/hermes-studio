import http from 'http'
import { brotliDecompressSync, gunzipSync } from 'zlib'
import { Readable } from 'stream'
import Koa from 'koa'
import { describe, expect, it } from 'vitest'
import {
  createStaticCompressionMiddleware,
  isCompressibleContentType,
  selectStaticCompressionEncoding,
  type StaticCompressionOptions,
} from '../../packages/server/src/middleware/static-compression'

interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

async function requestApp(app: Koa, headers: Record<string, string> = {}): Promise<RawResponse> {
  const server = http.createServer(app.callback())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected tcp server')

  try {
    return await new Promise<RawResponse>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: address.port,
        path: '/asset.js',
        headers,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(Buffer.from(chunk)))
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }))
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve())
    })
  }
}

function createAssetApp(
  contentType: string,
  body: string | Buffer | Readable,
  contentLength?: number,
  compressionOptions: StaticCompressionOptions = {},
): Koa {
  const app = new Koa()
  app.use(createStaticCompressionMiddleware({ minBytes: 0, ...compressionOptions }))
  app.use((ctx) => {
    ctx.type = contentType
    if (contentLength !== undefined) ctx.set('Content-Length', String(contentLength))
    ctx.body = body
  })
  return app
}

describe('static compression middleware', () => {
  it('prefers Brotli for compressible static responses', async () => {
    const source = 'const payload = "hermes web ui";\n'.repeat(200)
    const response = await requestApp(
      createAssetApp('application/javascript', source),
      { 'Accept-Encoding': 'gzip, br' },
    )

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('br')
    expect(response.headers.vary).toContain('Accept-Encoding')
    expect(brotliDecompressSync(response.body).toString('utf8')).toBe(source)
    expect(response.body.byteLength).toBeLessThan(Buffer.byteLength(source))
  })

  it('uses gzip when Brotli is unavailable', async () => {
    const source = '.button { color: #123456; }\n'.repeat(200)
    const response = await requestApp(
      createAssetApp('text/css', source),
      { 'Accept-Encoding': 'gzip' },
    )

    expect(response.headers['content-encoding']).toBe('gzip')
    expect(gunzipSync(response.body).toString('utf8')).toBe(source)
    expect(response.body.byteLength).toBeLessThan(Buffer.byteLength(source))
  })

  it('falls back to gzip for large javascript assets instead of dynamic Brotli', async () => {
    const source = 'export const route = "/chat";\n'.repeat(2048)
    const response = await requestApp(
      createAssetApp('application/javascript', source, undefined, { maxBrotliBytes: 1024 }),
      { 'Accept-Encoding': 'gzip, br' },
    )

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.headers.vary).toContain('Accept-Encoding')
    expect(gunzipSync(response.body).toString('utf8')).toBe(source)
  })

  it('marks large identity fallbacks as varying on Accept-Encoding', async () => {
    const source = 'export const route = "/chat";\n'.repeat(2048)
    const response = await requestApp(
      createAssetApp('application/javascript', source, undefined, { maxBrotliBytes: 1024 }),
      { 'Accept-Encoding': 'br' },
    )

    expect(response.status).toBe(200)
    expect(response.headers['content-encoding']).toBeUndefined()
    expect(response.headers.vary).toContain('Accept-Encoding')
    expect(response.body.toString('utf8')).toBe(source)
  })

  it('compresses static file streams without preserving the original content length', async () => {
    const source = 'export const route = "/chat";\n'.repeat(200)
    const response = await requestApp(
      createAssetApp('application/javascript', Readable.from([source]), Buffer.byteLength(source)),
      { 'Accept-Encoding': 'gzip' },
    )

    expect(response.headers['content-encoding']).toBe('gzip')
    expect(response.headers['content-length']).toBeUndefined()
    expect(gunzipSync(response.body).toString('utf8')).toBe(source)
  })

  it('does not compress already-compressed image assets or byte-range responses', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])
    const imageResponse = await requestApp(
      createAssetApp('image/png', pngBytes),
      { 'Accept-Encoding': 'gzip, br' },
    )
    expect(imageResponse.headers['content-encoding']).toBeUndefined()
    expect(imageResponse.body).toEqual(pngBytes)

    const rangeResponse = await requestApp(
      createAssetApp('text/javascript', 'const x = 1;\n'.repeat(100)),
      { 'Accept-Encoding': 'gzip', Range: 'bytes=0-20' },
    )
    expect(rangeResponse.headers['content-encoding']).toBeUndefined()
  })

  it('parses accepted encodings and compressible content types', () => {
    expect(selectStaticCompressionEncoding('gzip;q=1, br;q=0.5')).toBe('gzip')
    expect(selectStaticCompressionEncoding('gzip;q=0, br;q=1')).toBe('br')
    expect(selectStaticCompressionEncoding('*;q=0.8')).toBe('br')
    expect(selectStaticCompressionEncoding('gzip;q=0, br;q=0')).toBeNull()
    expect(selectStaticCompressionEncoding('gzip, br', { bodyLength: 4096, maxBrotliBytes: 1024 })).toBe('gzip')
    expect(selectStaticCompressionEncoding('br', { bodyLength: 4096, maxBrotliBytes: 1024 })).toBeNull()

    expect(isCompressibleContentType('text/html; charset=utf-8')).toBe(true)
    expect(isCompressibleContentType('application/manifest+json')).toBe(true)
    expect(isCompressibleContentType('image/svg+xml')).toBe(true)
    expect(isCompressibleContentType('image/png')).toBe(false)
    expect(isCompressibleContentType('font/woff2')).toBe(false)
  })
})
