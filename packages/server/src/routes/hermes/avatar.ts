import Router from '@koa/router'
import { randomBytes } from 'crypto'
import { writeFile, readFile, unlink, mkdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { config } from '../../config'

const avatarRoutes = new Router()

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const AVATAR_DIR = path.join(config.uploadDir, 'avatars')
const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

async function ensureDir(dir: string) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true })
  }
}

/** Validate that a resolved path stays within the allowed directory */
function safePath(dir: string, filename: string): string | null {
  const resolved = path.resolve(dir, filename)
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) return null
  return resolved
}

/** Parse multipart/form-data body without external dependencies. */
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

  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundaryBuf, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx))
    }
    start = idx + boundaryBuf.length
  }

  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd === -1) continue
    const header = part.subarray(0, headerEnd).toString('utf-8')
    const data = part.subarray(headerEnd + 4, part.length - 2)

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

/** Sanitize profile name to prevent path traversal */
function sanitizeProfile(profile: string): string {
  return profile.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
}

// Upload avatar (AI or user)
avatarRoutes.post('/api/hermes/avatar/:type', async (ctx: any) => {
  try {
    const { type } = ctx.params
    if (type !== 'ai' && type !== 'user') {
      ctx.status = 400
      ctx.body = { error: 'Invalid avatar type. Use "ai" or "user".' }
      return
    }

    const profile = sanitizeProfile(ctx.query.profile as string || 'default')
    const profileDir = path.join(AVATAR_DIR, profile)
    await ensureDir(profileDir)

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

    const ext = path.extname(parsed.filename).toLowerCase()
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      ctx.status = 400
      ctx.body = { error: `Unsupported format. Use: ${ALLOWED_EXTENSIONS.join(', ')}` }
      return
    }

    // Save as type-specific filename with original extension
    const outputName = `${type}${ext}`
    const outputPath = safePath(profileDir, outputName)
    if (!outputPath) {
      ctx.status = 400
      ctx.body = { error: 'Invalid output path' }
      return
    }

    // Remove old avatar files for this type (different extension)
    for (const oldExt of ALLOWED_EXTENSIONS) {
      const oldPath = safePath(profileDir, `${type}${oldExt}`)
      if (oldPath && existsSync(oldPath) && oldPath !== outputPath) {
        try { await unlink(oldPath) } catch {}
      }
    }

    await writeFile(outputPath, parsed.fileData)

    ctx.body = {
      success: true,
      url: `/api/hermes/avatar/${type}`,
      profile,
      message: `${type} avatar uploaded successfully`
    }
  } catch (error: any) {
    console.error('Avatar upload error:', error)
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

// Serve avatar
avatarRoutes.get('/api/hermes/avatar/:type', async (ctx: any) => {
  try {
    const { type } = ctx.params
    if (type !== 'ai' && type !== 'user') {
      ctx.status = 400
      ctx.body = { error: 'Invalid avatar type' }
      return
    }

    const profile = sanitizeProfile(ctx.query.profile as string || 'default')
    const profileDir = path.join(AVATAR_DIR, profile)
    await ensureDir(profileDir)

    // Check for any supported extension
    for (const ext of ALLOWED_EXTENSIONS) {
      const fp = safePath(profileDir, `${type}${ext}`)
      if (fp && existsSync(fp)) {
        const data = await readFile(fp)
        const mimeMap: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp'
        }
        ctx.set('Content-Type', mimeMap[ext] || 'application/octet-stream')
        ctx.set('Cache-Control', 'no-cache')
        ctx.body = data
        return
      }
    }

    ctx.status = 404
    ctx.body = { error: 'No avatar found' }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

// Delete avatar
avatarRoutes.delete('/api/hermes/avatar/:type', async (ctx: any) => {
  try {
    const { type } = ctx.params
    if (type !== 'ai' && type !== 'user') {
      ctx.status = 400
      ctx.body = { error: 'Invalid avatar type' }
      return
    }

    const profile = sanitizeProfile(ctx.query.profile as string || 'default')
    const profileDir = path.join(AVATAR_DIR, profile)
    await ensureDir(profileDir)

    for (const ext of ALLOWED_EXTENSIONS) {
      const fp = safePath(profileDir, `${type}${ext}`)
      if (fp && existsSync(fp)) await unlink(fp)
    }

    ctx.body = { success: true, message: `${type} avatar removed` }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

// Check avatar status
avatarRoutes.get('/api/hermes/avatar/status/:type', async (ctx: any) => {
  try {
    const { type } = ctx.params
    if (type !== 'ai' && type !== 'user') {
      ctx.status = 400
      ctx.body = { error: 'Invalid avatar type' }
      return
    }

    const profile = sanitizeProfile(ctx.query.profile as string || 'default')
    const profileDir = path.join(AVATAR_DIR, profile)
    await ensureDir(profileDir)

    let hasCustom = false
    let ext = null
    for (const e of ALLOWED_EXTENSIONS) {
      const fp = safePath(profileDir, `${type}${e}`)
      if (fp && existsSync(fp)) {
        hasCustom = true
        ext = e.slice(1) // remove leading dot
        break
      }
    }

    ctx.body = { hasCustom, ext, profile }
  } catch (error: any) {
    ctx.status = 500
    ctx.body = { error: error.message }
  }
})

export { avatarRoutes }
