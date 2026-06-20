import { randomBytes } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getActiveProfileName } from '../services/hermes/hermes-profile'
import { getProfileUploadDir } from '../services/hermes/upload-paths'
import { MultipartParseError, parseMultipartBoundary, parseMultipartFilename, splitMultipart } from '../lib/multipart'

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

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
  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of ctx.req) {
    totalSize += chunk.length
    if (totalSize > MAX_UPLOAD_SIZE) {
      ctx.status = 413; ctx.body = { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` }; return
    }
    chunks.push(chunk)
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
