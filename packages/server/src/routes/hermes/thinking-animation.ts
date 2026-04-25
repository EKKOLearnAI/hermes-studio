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

const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
const ANIMATION_DIR = path.join(config.uploadDir, 'thinking-animations')

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

    // Parse multipart manually
    const boundary = '--' + contentType.split('boundary=')[1]
    if (!boundary || boundary === '--undefined') {
      ctx.status = 400
      ctx.body = { error: 'Missing boundary' }
      return
    }

    const chunks: Buffer[] = []
    let totalSize = 0
    for await (const chunk of ctx.req) {
      totalSize += chunk.length
      if (totalSize > MAX_FILE_SIZE) {
        ctx.status = 413
        ctx.body = { error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` }
        return
      }
      chunks.push(chunk)
    }

    const raw = Buffer.concat(chunks)
    const boundaryBuf = Buffer.from(boundary)
    const parts = splitMultipart(raw, boundaryBuf)

    let fileData: Buffer | null = null
    let filename = ''

    for (const part of parts) {
      const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
      if (headerEnd === -1) continue
      const headerBuf = part.subarray(0, headerEnd)
      const header = headerBuf.toString('utf-8')
      const data = part.subarray(headerEnd + 4, part.length - 2)

      const filenameStarMatch = header.match(/filename\*=UTF-8''(.+)/i)
      if (filenameStarMatch) {
        filename = decodeURIComponent(filenameStarMatch[1])
      } else {
        const filenameMatch = header.match(/filename="([^"]+)"/)
        if (!filenameMatch) continue
        filename = filenameMatch[1]
      }
      fileData = data
    }

    if (!fileData || !filename) {
      ctx.status = 400
      ctx.body = { error: 'No file uploaded' }
      return
    }

    const ext = path.extname(filename).toLowerCase()
    const isNative = NATIVE_FORMATS.includes(ext)
    const needsConversion = CONVERT_FORMATS.includes(ext)

    if (!isNative && !needsConversion) {
      ctx.status = 400
      ctx.body = { error: 'Unsupported format. Use GIF, MP4, WebM, MOV, AVI, or MKV.' }
      return
    }

    const tempId = randomBytes(8).toString('hex')
    const tempPath = path.join(ANIMATION_DIR, `temp_${tempId}${ext}`)

    await writeFile(tempPath, fileData)

    try {
      if (isNative) {
        // MP4, GIF, WebM: save directly, no conversion needed
        const extMap: Record<string, string> = {
          '.mp4': 'mp4',
          '.gif': 'gif',
          '.webm': 'webm'
        }
        const outputExt = extMap[ext] || 'mp4'
        const outputPath = path.join(ANIMATION_DIR, `thinking-custom.${outputExt}`)
        await writeFile(outputPath, fileData)

        ctx.body = {
          success: true,
          type: outputExt,
          path: '/api/hermes/thinking-animation/file',
          message: `${ext.toUpperCase()} uploaded successfully (no conversion needed)`
        }
      } else {
        // MOV, AVI, MKV: convert to MP4 (browsers can't play these natively)
        const outputPath = path.join(ANIMATION_DIR, 'thinking-custom.mp4')
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
    const mp4Path = path.join(ANIMATION_DIR, 'thinking-custom.mp4')
    const gifPath = path.join(ANIMATION_DIR, 'thinking-custom.gif')
    const webmPath = path.join(ANIMATION_DIR, 'thinking-custom.webm')

    if (existsSync(mp4Path)) {
      const data = await readFile(mp4Path)
      ctx.set('Content-Type', 'video/mp4')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = data
    } else if (existsSync(gifPath)) {
      const data = await readFile(gifPath)
      ctx.set('Content-Type', 'image/gif')
      ctx.set('Cache-Control', 'no-cache')
      ctx.body = data
    } else if (existsSync(webmPath)) {
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
    
    const mp4Path = path.join(ANIMATION_DIR, 'thinking-custom.mp4')
    const gifPath = path.join(ANIMATION_DIR, 'thinking-custom.gif')
    const webmPath = path.join(ANIMATION_DIR, 'thinking-custom.webm')

    if (existsSync(mp4Path)) await unlink(mp4Path)
    if (existsSync(gifPath)) await unlink(gifPath)
    if (existsSync(webmPath)) await unlink(webmPath)

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
    
    const mp4Path = path.join(ANIMATION_DIR, 'thinking-custom.mp4')
    const gifPath = path.join(ANIMATION_DIR, 'thinking-custom.gif')
    const webmPath = path.join(ANIMATION_DIR, 'thinking-custom.webm')

    const hasCustom = existsSync(mp4Path) || existsSync(gifPath) || existsSync(webmPath)
    let type = null
    if (existsSync(mp4Path)) type = 'mp4'
    else if (existsSync(gifPath)) type = 'gif'
    else if (existsSync(webmPath)) type = 'webm'

    ctx.body = { hasCustom, type }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) { parts.push(raw.subarray(start + 2, idx)) }
    start = idx + boundary.length
  }
  return parts
}

export { thinkingRoutes }
