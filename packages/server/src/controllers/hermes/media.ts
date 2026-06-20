import type { Context } from 'koa'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, extname, isAbsolute, join, resolve } from 'path'
import { getActiveProfileName, getProfileDir, listProfileNamesFromDisk } from '../../services/hermes/hermes-profile'
import { config } from '../../config'
import { readConfigYamlForProfile } from '../../services/config-helpers'
import { getCompatibleCustomProviders } from '../../services/hermes/custom-providers-compat'

const XAI_VIDEO_GENERATIONS_URL = 'https://api.x.ai/v1/videos/generations'
const XAI_VIDEO_STATUS_URL = 'https://api.x.ai/v1/videos'
const XAI_VIDEO_MODEL = 'grok-imagine-video'
const APIKEY_IMAGE_PROVIDER = 'fun-codex'
const APIKEY_IMAGE_MODEL = 'gpt-image-2'
const APIKEY_IMAGE_TO_IMAGE_MODEL = 'gpt-5.4-mini'
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

type AuthJson = {
  providers?: Record<string, any>
  credential_pool?: Record<string, any[]>
}

type ApiKeyImageMode = 'text' | 'image' | 'edit'

type ApiKeyImageProvider = {
  name: string
  apiKey: string
  baseUrl: string
  model: string
}

function requestedProfileName(ctx: Context): string {
  const headerProfile = ctx.get('x-hermes-profile')
  const queryProfile = typeof ctx.query.profile === 'string' ? ctx.query.profile : ''
  const body = ctx.request.body as { profile?: unknown } | undefined
  const bodyProfile = typeof body?.profile === 'string' ? body.profile : ''
  return (ctx.state.profile?.name || headerProfile || queryProfile || bodyProfile || '').trim()
}

function resolveMediaProfile(ctx: Context): string {
  let requested = requestedProfileName(ctx)
  if (!requested && ctx.state.user?.role !== 'super_admin' && !ctx.state.serverTokenAuth) {
    const profiles = ctx.state.user?.profiles || []
    if (profiles.length === 1) {
      requested = profiles[0]
    } else {
      const err: any = new Error('Profile is required')
      err.status = 400
      err.code = 'profile_required'
      throw err
    }
  }

  const profile = requested || getActiveProfileName() || 'default'
  if (!listProfileNamesFromDisk().includes(profile)) {
    const err: any = new Error(`Profile "${profile}" does not exist`)
    err.status = 404
    err.code = 'profile_not_found'
    throw err
  }
  return profile
}

function authPathForProfile(profile: string): string {
  return join(getProfileDir(profile), 'auth.json')
}

function readJsonFile(path: string): any {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function buildApiUrl(baseUrl: string, pathWithV1: string): string {
  const base = (baseUrl || 'https://api.apikey.fun/v1').replace(/\/+$/, '')
  const apiPath = pathWithV1.startsWith('/') ? pathWithV1 : `/${pathWithV1}`
  if (base.endsWith('/v1') && apiPath.startsWith('/v1/')) return `${base}${apiPath.slice(3)}`
  return `${base}${apiPath}`
}

function normalizeCustomProviderName(value: unknown): string {
  const name = String(value || '').trim()
  if (!name) return ''
  return name.startsWith('custom:') ? name.slice('custom:'.length).trim() : name
}

function requestedApiKeyImageProviderName(body: any): string {
  return normalizeCustomProviderName(body?.provider || body?.provider_name || body?.custom_provider) || APIKEY_IMAGE_PROVIDER
}

function apiKeyFromCustomProvider(provider: any): string {
  const direct = String(provider?.api_key || '').trim()
  if (direct) return direct
  const envName = String(provider?.api_key_env || provider?.key_env || '').trim()
  return envName ? String(process.env[envName] || '').trim() : ''
}

async function resolveApiKeyImageProvider(profile: string, providerName = APIKEY_IMAGE_PROVIDER): Promise<ApiKeyImageProvider | null> {
  const requestedName = normalizeCustomProviderName(providerName) || APIKEY_IMAGE_PROVIDER
  const hermesConfig = await readConfigYamlForProfile(profile)
  const customProviders = getCompatibleCustomProviders(hermesConfig)
  const provider = customProviders.find(entry => normalizeCustomProviderName(entry?.name) === requestedName)
  const apiKey = apiKeyFromCustomProvider(provider)
  const baseUrl = String(provider?.base_url || '').trim()
  if (!provider || !apiKey || !baseUrl) return null
  return {
    name: requestedName,
    apiKey,
    baseUrl,
    model: String(provider?.model || '').trim(),
  }
}

function resolveXaiToken(profile: string): { token: string; source: string } | null {
  const envToken = String(process.env.XAI_API_KEY || '').trim()
  if (envToken) return { token: envToken, source: 'XAI_API_KEY' }

  const auth = readJsonFile(authPathForProfile(profile)) as AuthJson | null
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

function imageDataUriToBytes(dataUri: string): { buffer: Buffer; mime: string; name: string } {
  const match = dataUri.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) {
    const err: any = new Error('image_base64 must be a valid image data URI for edit mode')
    err.status = 400
    throw err
  }
  const mime = match[1]
  if (!mime.startsWith('image/')) {
    const err: any = new Error('image data URI must use an image mime type')
    err.status = 400
    throw err
  }
  return {
    buffer: Buffer.from(match[2], 'base64'),
    mime,
    name: `source.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'}`,
  }
}

async function fetchImageBytes(url: string): Promise<{ buffer: Buffer; mime: string; name: string }> {
  const res = await fetch(url)
  if (!res.ok) {
    const err: any = new Error(`image_url fetch failed: ${res.status} ${res.statusText}`)
    err.status = 400
    throw err
  }
  const mime = String(res.headers.get('content-type') || '').split(';')[0] || 'image/png'
  if (!mime.startsWith('image/')) {
    const err: any = new Error('image_url did not return an image')
    err.status = 400
    throw err
  }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_IMAGE_BYTES) {
    const err: any = new Error(`image is too large (max ${MAX_IMAGE_BYTES} bytes)`)
    err.status = 413
    throw err
  }
  const name = new URL(url).pathname.split('/').pop() || 'source.png'
  return { buffer, mime, name }
}

async function normalizeImageFile(body: any): Promise<{ buffer: Buffer; mime: string; name: string }> {
  const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim() : ''
  if (imageUrl) return fetchImageBytes(imageUrl)

  const imageBase64 = typeof body.image_base64 === 'string' ? body.image_base64.trim() : ''
  if (imageBase64) {
    const dataUri = imageBase64.startsWith('data:image/')
      ? imageBase64
      : `data:${String(body.mime_type || '').trim()};base64,${imageBase64}`
    return imageDataUriToBytes(dataUri)
  }

  const imagePath = typeof body.image_path === 'string' ? body.image_path.trim() : ''
  if (!imagePath) {
    const err: any = new Error('image_path, image_url, or image_base64 is required')
    err.status = 400
    throw err
  }
  const resolvedPath = isAbsolute(imagePath) ? imagePath : resolve(process.cwd(), imagePath)
  if (!existsSync(resolvedPath)) {
    const err: any = new Error('image_path does not exist')
    err.status = 404
    throw err
  }
  const buffer = readFileSync(resolvedPath)
  if (buffer.length > MAX_IMAGE_BYTES) {
    const err: any = new Error(`image is too large (max ${MAX_IMAGE_BYTES} bytes)`)
    err.status = 413
    throw err
  }
  const mime = mimeFromMagic(buffer) || mimeFromPath(resolvedPath)
  if (!mime) {
    const err: any = new Error('unsupported image type; use png, jpeg, or webp')
    err.status = 400
    throw err
  }
  return { buffer, mime, name: resolvedPath.split(/[\\/]/).pop() || 'source.png' }
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

export function defaultImageOutputPath(requestId: string, index = 0): string {
  const safeRequestId = requestId.replace(/[^A-Za-z0-9_-]/g, '_') || `image_${Date.now()}`
  const suffix = index > 0 ? `-${index + 1}` : ''
  return join(config.appHome, 'media', `${safeRequestId}${suffix}.png`)
}

function normalizeImageMode(value: unknown): ApiKeyImageMode {
  const mode = String(value || 'text').trim().toLowerCase()
  if (mode === 'text' || mode === 'image' || mode === 'edit') return mode
  const err: any = new Error('mode must be one of text, image, or edit')
  err.status = 400
  throw err
}

function normalizePositiveInt(value: unknown, fallback: number, key: string): number {
  const parsed = Number(value || fallback)
  if (!Number.isFinite(parsed) || parsed < 1) {
    const err: any = new Error(`${key} must be a positive number`)
    err.status = 400
    throw err
  }
  return Math.floor(parsed)
}

function collectImageBase64(event: any, images: string[] = []): string[] {
  if (!event || typeof event !== 'object') return images
  for (const key of ['b64_json', 'base64', 'image_base64', 'partial_image_b64']) {
    if (typeof event[key] === 'string' && event[key]) images.push(event[key])
  }
  for (const item of event.data || []) collectImageBase64(item, images)
  for (const item of event.response?.output || []) {
    if (typeof item?.result === 'string' && item.result) images.push(item.result)
    collectImageBase64(item, images)
  }
  if (typeof event.item?.result === 'string' && event.item.result) images.push(event.item.result)
  return images
}

function isPartialImageEvent(event: any): boolean {
  return event?.type === 'image_generation.partial_image' ||
    event?.type === 'response.image_generation_call.partial_image'
}

function throwIfImageStreamError(event: any): void {
  if (event?.type !== 'error' && event?.type !== 'response.failed') return
  const err: any = new Error(event?.response?.error?.message || event?.error?.message || 'image generation failed')
  err.status = 502
  throw err
}

async function readSseImageResults(res: Response, limit: number): Promise<string[]> {
  if (!res.body) throw new Error('image generation response is not readable')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const images: string[] = []
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
        .trim()
      if (!data || data === '[DONE]') continue
      const event = JSON.parse(data)
      throwIfImageStreamError(event)
      if (isPartialImageEvent(event)) continue
      collectImageBase64(event, images)
      if (images.length >= limit) return images.slice(0, limit)
    }
  }
  return images.slice(0, limit)
}

async function requestApiKeyImage(provider: ApiKeyImageProvider, mode: ApiKeyImageMode, body: any): Promise<string[]> {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) {
    const err: any = new Error('prompt is required')
    err.status = 400
    throw err
  }

  const n = normalizePositiveInt(body.n, 1, 'n')
  const timeoutMs = normalizePositiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS, 'timeout_ms')
  const headers = {
    Accept: 'text/event-stream',
    Authorization: `Bearer ${provider.apiKey}`,
  }

  let res: Response
  if (mode === 'text') {
    res = await fetch(buildApiUrl(provider.baseUrl, '/v1/images/generations'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: body.model || APIKEY_IMAGE_MODEL,
        prompt,
        n,
        size: body.size || '1024x1024',
        quality: body.quality || 'auto',
        stream: true,
        response_format: 'b64_json',
      }),
    })
  } else if (mode === 'image') {
    res = await fetch(buildApiUrl(provider.baseUrl, '/v1/responses'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: body.model || provider.model || APIKEY_IMAGE_TO_IMAGE_MODEL,
        stream: true,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: normalizeImageInput(body) },
          ],
        }],
        tools: [{
          type: 'image_generation',
          model: body.image_model || APIKEY_IMAGE_MODEL,
          size: body.size || '1024x1024',
          quality: body.quality || 'auto',
          output_format: body.output_format || 'png',
        }],
        tool_choice: { type: 'image_generation' },
      }),
    })
  } else {
    const image = await normalizeImageFile(body)
    const imageBytes = new Uint8Array(image.buffer.byteLength)
    imageBytes.set(image.buffer)
    const form = new FormData()
    form.append('image', new Blob([imageBytes.buffer], { type: image.mime }), image.name)
    form.append('prompt', prompt)
    form.append('model', body.model || APIKEY_IMAGE_MODEL)
    form.append('n', String(n))
    form.append('quality', body.quality || 'auto')
    form.append('size', body.size || '1024x1024')
    form.append('stream', 'true')
    form.append('response_format', 'b64_json')
    res = await fetch(buildApiUrl(provider.baseUrl, '/v1/images/edits'), {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: form,
    })
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const err: any = new Error(`image generation request failed: ${res.status} ${detail || res.statusText}`)
    err.status = res.status === 401 || res.status === 403 ? 502 : 502
    throw err
  }
  const images = await readSseImageResults(res, n)
  if (images.length === 0) {
    const err: any = new Error('image generation stream ended without image data')
    err.status = 502
    throw err
  }
  return images
}

function saveGeneratedImages(images: string[], requestedOutputPath?: string): string[] {
  return images.map((image, index) => {
    const outputPath = requestedOutputPath && images.length === 1
      ? requestedOutputPath
      : requestedOutputPath
        ? requestedOutputPath.replace(/(\.[^.\\/]+)?$/, `${index > 0 ? `-${index + 1}` : ''}$1`)
        : defaultImageOutputPath(`image_${Date.now()}`, index)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, Buffer.from(image, 'base64'))
    return outputPath
  })
}

export async function apiKeyImageGenerate(ctx: Context) {
  let profile: string
  try {
    profile = resolveMediaProfile(ctx)
  } catch (err: any) {
    ctx.status = err.status || 400
    ctx.body = { error: err.message || String(err), code: err.code || 'invalid_profile' }
    return
  }

  const body = ctx.request.body as any
  const providerName = requestedApiKeyImageProviderName(body)
  const provider = await resolveApiKeyImageProvider(profile, providerName)
  if (!provider) {
    ctx.status = 401
    const isDefaultProvider = providerName === APIKEY_IMAGE_PROVIDER
    ctx.body = {
      error: `Missing ${providerName} provider in profile "${profile}" config.yaml.`,
      code: isDefaultProvider ? 'missing_fun_codex_provider' : 'missing_apikey_image_provider',
    }
    return
  }

  try {
    const mode = normalizeImageMode(body.mode)
    const images = await requestApiKeyImage(provider, mode, body)
    const requestedOutputPath = typeof body.output_path === 'string' ? body.output_path.trim() : ''
    const outputPaths = saveGeneratedImages(images, requestedOutputPath || undefined)
    ctx.body = {
      ok: true,
      mode,
      output_paths: outputPaths,
      provider: provider.name,
      base_url: provider.baseUrl,
      profile,
    }
  } catch (err: any) {
    ctx.status = err.status || 500
    ctx.body = {
      error: err.message || String(err),
      code: err.code || 'image_generation_failed',
    }
  }
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
  let profile: string
  try {
    profile = resolveMediaProfile(ctx)
  } catch (err: any) {
    ctx.status = err.status || 400
    ctx.body = { error: err.message || String(err), code: err.code || 'invalid_profile' }
    return
  }

  const tokenInfo = resolveXaiToken(profile)
  if (!tokenInfo) {
    ctx.status = 401
    ctx.body = {
      error: `Missing xAI token for profile "${profile}". Set XAI_API_KEY or complete xAI OAuth login first.`,
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
          profile,
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
