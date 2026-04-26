import Router from '@koa/router'
import { randomBytes } from 'crypto'
import { writeFile, readFile, unlink, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { config } from '../../config'

const execFileAsync = promisify(execFile)

const thinkingRoutes = new Router()

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const ANIMATION_DIR = path.join(config.uploadDir, 'thinking-animations')

// Allowed output filenames — prevents path traversal
const ALLOWED_OUTPUT_NAMES = ['thinking-custom.mp4', 'thinking-custom.gif', 'thinking-custom.webm']

// Formats that browsers can play natively (no conversion needed)
const NATIVE_FORMATS = ['.mp4', '.gif', '.webm']
// Formats that need conversion to MP4
const CONVERT_FORMATS = ['.mov', '.avi', '.mkv']

// Ensure animation directory exists
async function ensureDir() {
  if (!existsSync(ANIMATION_DIR)) {
    await mkdir(ANIMATION_DIR, { recursive: true })
  }
}

/** Validate that a resolved path stays within the allowed directory */
function safePath(dir: string, filename: string): string | null {
  const resolved = path.resolve(dir, filename)
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) return null
  return resolved
}

/** Parse multipart/form-data body without external dependencies.
 *  Reads the full request body, splits on boundary, extracts the file part. */
async function parseMultipartBody(
  req: NodeJS.ReadableStream,
  contentType: string
): Promise<{ fileData: Buffer; filename: string } | null> {
  const boundaryMatch = contentType.match(/boundary=(.+)/i)
  if (!boundaryMatch) return null
  const boundary = '--' + boundaryMatch[1].trim()

  const chunks: Buffer[] = []
  let totalSize = 0
  for await (const chunk of req) {
    totalSize += chunk.length
    if (totalSize > MAX_FILE_SIZE) return null
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  const raw = Buffer.concat(chunks)
  const boundaryBuf = Buffer.from(boundary)

  // Find all parts by scanning for boundary markers
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundaryBuf, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx)) // skip CRLF after boundary
    }
    start = idx + boundaryBuf.length
  }

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const header = part.subarray(0, headerEnd).toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2) // strip trailing CRLF

    // Try filename*= (RFC 5987) first, then filename=""
    const filenameStarMatch = header.match(/filename\*=UTF-8''(.+)/i)
    let filename = ''
    if (filenameStarMatch) {
      filename = decodeURIComponent(filenameStarMatch[1])
    } else {
      const filenameMatch = header.match(/filename="([^"]+)"/)
      if (filenameMatch) filename = filenameMatch[1]
    }
    if (!filename) continue

    return { fileData: data, filename }
  }
  return null
}

// Upload thinking animation
thinkingRoutes.post('/api/hermes/thinking-animation', async (ctx: any) => {
  try {
    await ensureDir()

    const contentType = ctx.get('content-type') || ''
    if (!contentType.startsWith('multipart/form-data')) {
      ctx.status = 400
      ctx.body = { error: 'Expected multipart/form-data' }
      return
    }

    const parsed = await parseMultipartBody(ctx.req, contentType)
    if (!parsed || !parsed.fileData || !parsed.filename) {
      ctx.status = 400
      ctx.body = { error: 'No file uploaded' }
      return
    }

    const { fileData, filename } = parsed
    const ext = path.extname(filename).toLowerCase()
    const isNative = NATIVE_FORMATS.includes(ext)
    const needsConversion = CONVERT_FORMATS.includes(ext)

    if (!isNative && !needsConversion) {
      ctx.status = 400
      ctx.body = { error: 'Unsupported format. Use GIF, MP4, WebM, MOV, AVI, or MKV.' }
      return
    }

    const tempId = randomBytes(8).toString('hex')
    const tempPath = safePath(ANIMATION_DIR, `temp_${tempId}${ext}`)
    if (!tempPath) {
      ctx.status = 400
      ctx.body = { error: 'Invalid temp path' }
      return
    }

    await writeFile(tempPath, fileData)

    try {
      if (isNative) {
        const extMap: Record<string, string> = {
          '.mp4': 'mp4',
          '.gif': 'gif',
          '.webm': 'webm'
        }
        const outputExt = extMap[ext] || 'mp4'
        const outputName = `thinking-custom.${outputExt}`
        const outputPath = safePath(ANIMATION_DIR, outputName)
        if (!outputPath || !ALLOWED_OUTPUT_NAMES.includes(outputName)) {
          ctx.status = 400
          ctx.body = { error: 'Invalid output filename' }
          return
        }
        await writeFile(outputPath, fileData)

        ctx.body = {
          success: true,
          type: outputExt,
          path: '/api/hermes/thinking-animation/file',
          message: `${ext.toUpperCase()} uploaded successfully (no conversion needed)`
        }
      } else {
        // MOV, AVI, MKV: convert to MP4 (browsers can't play these natively)
        const outputPath = safePath(ANIMATION_DIR, 'thinking-custom.mp4')
        if (!outputPath) {
          ctx.status = 400
          ctx.body = { error: 'Invalid output path' }
          return
        }
        await execFileAsync('ffmpeg', [
          '-i', tempPath,
          '-c:v', 'libx264',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-y', outputPath
        ], { timeout: 60000 })

        ctx.body = {
          success: true,
          type: 'mp4',
          path: '/api/hermes/thinking-animation/file',
          message: `${ext.toUpperCase()} converted to MP4 successfully`
        }
      }
    } catch (ffmpegError: any) {
      ctx.status = 400
      ctx.body = { error: `Video conversion failed: ${ffmpegError.message}` }
    } finally {
      // Clean up temp file
      try { await unlink(tempPath) } catch {}
    }
  } catch (error: any) {
    console.error('Thinking animation upload error:', error)
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

// Serve the custom thinking animation
thinkingRoutes.get('/api/hermes/thinking-animation/file', async (ctx: any) => {
  try {
    await ensureDir()

    // Check for MP4, GIF, WebM in order
    const mp4Path = safePath(ANIMATION_DIR, 'thinking-custom.mp4')
    const gifPath = safePath(ANIMATION_DIR, 'thinking-custom.gif')
    const webmPath = safePath(ANIMATION_DIR, 'thinking-custom.webm')

    if (mp4Path && existsSync(mp4Path)) {
      const data = await readFile(mp4Path)
      ctx.set('Content-Type', 'video/mp4')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = data
    } else if (gifPath && existsSync(gifPath)) {
      const data = await readFile(gifPath)
      ctx.set('Content-Type', 'image/gif')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = data
    } else if (webmPath && existsSync(webmPath)) {
      const data = await readFile(webmPath)
      ctx.set('Content-Type', 'video/webm')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = data
    } else {
      ctx.status = 404
      ctx.body = { error: 'No custom animation found' }
    }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

// Delete custom thinking animation (reset to default)
thinkingRoutes.delete('/api/hermes/thinking-animation', async (ctx: any) => {
  try {
    await ensureDir()

    for (const name of ALLOWED_OUTPUT_NAMES) {
      const fp = safePath(ANIMATION_DIR, name)
      if (fp && existsSync(fp)) await unlink(fp)
    }

    ctx.body = { success: true, message: 'Custom animation removed, using default' }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

// Check if custom animation exists
thinkingRoutes.get('/api/hermes/thinking-animation/status', async (ctx: any) => {
  try {
    await ensureDir()

    let hasCustom = false
    let type = null
    for (const [name, t] of [['thinking-custom.mp4', 'mp4'], ['thinking-custom.gif', 'gif'], ['thinking-custom.webm', 'webm']] as const) {
      const fp = safePath(ANIMATION_DIR, name)
      if (fp && existsSync(fp)) { hasCustom = true; type = t; break }
    }

    ctx.body = { hasCustom, type }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

export { thinkingRoutes }
