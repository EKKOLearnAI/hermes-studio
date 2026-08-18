import { randomBytes } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { getProfileUploadDir } from '../services/hermes/upload-paths'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../lib/multipart'

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB
// How long to keep reading a rejected upload before giving up on a clean reply.
const OVERSIZE_DRAIN_TIMEOUT_MS = 10_000

/**
 * Read and discard whatever is left of a request body.
 *
 * Answering while the client is still writing gets the connection reset before
 * it can read the response, so the browser reports a generic network failure
 * instead of the reason it was given. Draining first lets the reply arrive.
 */
function drainRequest(req: any): Promise<void> {
  if (!req || typeof req.resume !== 'function' || req.readableEnded || req.destroyed) return Promise.resolve()
  return new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer)
      req.off?.('end', finish)
      req.off?.('close', finish)
      req.off?.('error', finish)
      resolve()
    }
    // A client that keeps sending forever must not hold the handler open.
    const timer = setTimeout(() => {
      req.destroy?.()
      finish()
    }, OVERSIZE_DRAIN_TIMEOUT_MS)
    timer.unref?.()
    req.on('end', finish)
    req.on('close', finish)
    req.on('error', finish)
    req.resume()
  })
}

function requestedProfile(ctx: any): string {
  return ctx.state?.profile?.name || getActiveProfileName() || 'default'
}

export async function handleUpload(ctx: any) {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    ctx.status = 400; ctx.body = { error: 'Expected multipart/form-data' }; return
  }
  const boundaryBuf = parseMultipartBoundary(contentType)
  if (!boundaryBuf) {
    ctx.status = 400; ctx.body = { error: 'Missing boundary' }; return
  }
  let chunks: Buffer[] = []
  let totalSize = 0
  let oversize = false
  // Leave the stream alive when the loop ends early; the iterator would
  // otherwise destroy it and take the unsent response down with it.
  const body = typeof ctx.req.iterator === 'function'
    ? ctx.req.iterator({ destroyOnReturn: false })
    : ctx.req
  for await (const chunk of body) {
    totalSize += chunk.length
    if (totalSize > MAX_UPLOAD_SIZE) {
      oversize = true
      break
    }
    chunks.push(chunk)
  }
  if (oversize) {
    chunks = []
    await drainRequest(ctx.req)
    ctx.status = 413
    ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }
    return
  }
  const raw = Buffer.concat(chunks)
  const parts = splitMultipart(raw, boundaryBuf)
  const results: { name: string; path: string }[] = []
  const uploadDir = getProfileUploadDir(requestedProfile(ctx))
  await mkdir(uploadDir, { recursive: true })
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const headerBuf = part.subarray(0, headerEnd)
    const header = headerBuf.toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)
    let filename: string | null
    try {
      filename = parseMultipartFilename(header)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        ctx.status = 400; ctx.body = { error: error.message }; return
      }
      throw error
    }
    if (!filename) continue
    const ext = filename.includes('.') ? '.' + filename.split('.').pop() : ''
    const savedName = randomBytes(8).toString('hex') + ext
    const savedPath = join(uploadDir, savedName)
    await writeFile(savedPath, data)
    results.push({ name: filename, path: savedPath })
  }
  ctx.body = { files: results }
}
