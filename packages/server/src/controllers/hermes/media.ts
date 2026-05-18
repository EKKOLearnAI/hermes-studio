import type { Context } from 'koa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, isAbsolute, join, resolve } from 'path'
import { getActiveAuthPath } from '../../services/hermes/hermes-profile'
import { config } from '../../config'

const XAI_VIDEO_GENERATIONS_URL = 'https://api.x.ai/v1/videos/generations'
const XAI_VIDEO_STATUS_URL = 'https://api.x.ai/v1/videos'
const XAI_VIDEO_MODEL = 'grok-imagine-video'
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

type AuthJson = {
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
}

function readJsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function resolveXaiToken(): { token: string; source: string } | null {
  const envToken = String(process.env.XAI_API_KEY || '').trim()
  if (envToken) return { token: envToken, source: 'XAI_API_KEY' }

  const auth = readJsonFile(getActiveAuthPath()) as AuthJson | null
  const providerToken = String(auth?.providers?.['xai-oauth']?.tokens?.access_token || auth?.providers?.['xai-oauth']?.access_token || '').trim()
  if (providerToken) return { token: providerToken, source: 'xai-oauth' }

  const pool = auth?.credential_pool?.['xai-oauth']
  if (Array.isArray(pool)) {
    const poolToken = String(pool.find(entry => entry?.access_token)?.access_token || '').trim()
    if (poolToken) return { token: poolToken, source: 'xai-oauth' }
  }

  return null
}

function mimeFromPath(path: string): string | null {
  const ext = extname(path).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return null
}

function mimeFromMagic(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

function imagePathToDataUri(imagePath: string): string {
  const resolvedPath = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath)
  const image = readFileSync(resolvedPath)
  if (image.length > MAX_IMAGE_BYTES) {
    const err: any = new Error(`image is too large (max ${MAX_IMAGE_BYTES} bytes)`)
    err.status = 413
    throw err
  }
  const mime = mimeFromMagic(image) || mimeFromPath(resolvedPath)
  if (!mime) {
    const err: any = new Error('unsupported image type; use png, jpeg, or webp')
    err.status = 400
    throw err
  }
  return `data:${mime};base64,${image.toString('base64')}`
}

function normalizeImageInput(body: any): string {
  const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim() : ''
  if (imageUrl) return imageUrl

  const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64.trim() : ''
  if (imageBase64) {
    if (imageBase64.startsWith('data:image/')) return imageBase64
    const mime = typeof body.mime_type === 'string' ? body.mime_type.trim() : ''
    if (!mime.startsWith('image/')) {
      const err: any = new Error('mime_type is required when image_base64 is not a data URI')
      err.status = 400
      throw err
    }
    return `data:${mime};base64,${imageBase64}`
  }

  const imagePath = typeof body.image_path === 'string' ? body.image_path.trim() : ''
  if (!imagePath) {
    const err: any = new Error('image_path, image_url, or image_base64 is required')
    err.status = 400
    throw err
  }
  if (!existsSync(isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath))) {
    const err: any = new Error('image_path does not exist')
    err.status = 404
    throw err
  }
  return imagePathToDataUri(imagePath)
}

function normalizeDuration(value: unknown): number {
  const duration = Number(value || 8)
  if (!Number.isFinite(duration) || duration < 1 || duration > 15) {
    const err: any = new Error('duration must be between 1 and 15 seconds')
    err.status = 400
    throw err
  }
  return duration
}

export function defaultMediaOutputPath(requestId: string, now = new Date()): string {
  const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/g, '_') || `video_${now.getTime()}`
  return join(config.appHome, 'media', `${safeRequestId}.mp4`)
}

async function requestXaiJson(url: string, token: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch {}
  if (!res.ok) {
    const detail = data?.error?.message || data?.error || text || res.statusText
    const err: any = new Error(`xAI request failed: ${res.status} ${detail}`)
    err.status = res.status === 401 || res.status === 403 ? 502 : 502
    throw err
  }
  return data
}

async function downloadVideo(url: string, outputPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`failed to download generated video: ${res.status} ${res.statusText}`)
  const arrayBuffer = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, buffer)
}

export async function grokImageToVideo(ctx: Context) {
  const tokenInfo = resolveXaiToken()
  if (!tokenInfo) {
    ctx.status = 401
    ctx.body = {
      error: 'Missing xAI token. Set XAI_API_KEY or complete xAI OAuth login first.',
      code: 'missing_xai_token',
    }
    return
  }

  const body = ctx.request.body as any
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    ctx.status = 400
    ctx.body = { error: 'prompt is required', code: 'missing_prompt' }
    return
  }

  try {
    const image = normalizeImageInput(body)
    const duration = normalizeDuration(body.duration)
    const rawTimeoutMs = Number(body.timeout_ms || DEFAULT_TIMEOUT_MS)
    const timeoutMs = Number.isFinite(rawTimeoutMs)
      ? Math.max(10000, Math.min(rawTimeoutMs, 30 * 60 * 1000))
      : DEFAULT_TIMEOUT_MS
    const requestedOutputPath = typeof body.output_path === 'string' ? body.output_path.trim() : ''

    const started = await requestXaiJson(XAI_VIDEO_GENERATIONS_URL, tokenInfo.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: XAI_VIDEO_MODEL,
        prompt,
        image: { url: image },
        duration,
      }),
    })
    const requestId = String(started?.request_id || '').trim()
    if (!requestId) throw new Error('xAI response missing request_id')

    const deadline = Date.now() + timeoutMs
    let latest: any = null
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS))
      latest = await requestXaiJson(`${XAI_VIDEO_STATUS_URL}/${encodeURIComponent(requestId)}`, tokenInfo.token)
      if (latest?.status === 'done') {
        const videoUrl = String(latest?.video?.url || '').trim()
        const outputPath = requestedOutputPath || defaultMediaOutputPath(requestId)
        if (videoUrl) await downloadVideo(videoUrl, outputPath)
        ctx.body = {
          request_id: requestId,
          status: latest.status,
          video_url: videoUrl,
          output_path: outputPath,
          token_source: tokenInfo.source,
        }
        return
      }
      if (latest?.status === 'expired' || latest?.status === 'failed' || latest?.status === 'error') {
        ctx.status = 502
        ctx.body = { request_id: requestId, status: latest.status, error: latest?.error || 'xAI video generation failed' }
        return
      }
    }

    ctx.status = 504
    ctx.body = { request_id: requestId, status: latest?.status || 'pending', error: 'Timed out waiting for xAI video generation' }
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = { error: err.message || String(err) }
  }
}
