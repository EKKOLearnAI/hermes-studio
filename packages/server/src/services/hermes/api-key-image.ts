import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { dirname, extname, isAbsolute, resolve } from 'path'
import { config } from '../../config'
import {
  isNearestExistingRealPathWithin,
  isPathWithin,
  isRealPathWithin,
} from './hermes-path'
import { workspaceBaseOverride } from './workspace-path'

export const MAX_REFERENCE_COUNT = 8
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
export const MAX_REFERENCE_TOTAL_BYTES = 12 * 1024 * 1024
export const MAX_IMAGE_REQUEST_BYTES = 18 * 1024 * 1024

const LEGACY_MAX_IMAGE_BYTES = 25 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_IMAGE_MODEL = 'codex-gpt-image-2'
const DEFAULT_RESPONSE_MODEL = 'gpt-5.4-mini'
const DEFAULT_QUALITY = 'high'
const DEFAULT_RESOLUTION = '4k'
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const MAX_GENERATED_IMAGE_BYTES = 50 * 1024 * 1024
const MAX_GENERATED_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_GENERATED_BASE64_CHARS = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 4

export type ApiKeyImageMode = 'text' | 'image' | 'edit'

export type ApiKeyImageProvider = {
  name: string
  apiKey: string
  baseUrl: string
  model: string
}

type ImageSourceInput = {
  image_path?: unknown
  image_url?: unknown
  image_base64?: unknown
  mime_type?: unknown
}

type ReferenceInput = ImageSourceInput & {
  role?: unknown
  priority?: unknown
  weight?: unknown
}

type NormalizedReference = {
  dataUri: string
  file: {
    buffer: Buffer
    mime: string
    name: string
  }
  role: string
  priority?: number
  weight?: number
}

export type GeneratedImage = {
  base64: string
  buffer: Buffer
  format: 'png' | 'jpeg' | 'webp'
  dimensions: { width: number; height: number } | null
}

export type ApiKeyImageRequestResult = {
  images: GeneratedImage[]
  model: string
  provider: string
  quality: string
  resolution: string
  aspect: string
}

type MediaContractError = Error & {
  status?: number
  code?: string
  expose?: boolean
}

function contractError(status: number, code: string, message: string): MediaContractError {
  return Object.assign(new Error(message), { status, code, expose: true })
}

function buildApiUrl(baseUrl: string, pathWithV1: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const apiPath = pathWithV1.startsWith('/') ? pathWithV1 : `/${pathWithV1}`
  if (base.endsWith('/v1') && apiPath.startsWith('/v1/')) return `${base}${apiPath.slice(3)}`
  return `${base}${apiPath}`
}

function safeFileRoots(): string[] {
  const roots = [
    config.appHome,
    config.uploadDir,
    workspaceBaseOverride() || homedir(),
    process.cwd(),
    tmpdir(),
  ]
  return [...new Set(roots.map(root => resolve(root)))]
}

async function resolveSafeInputPath(value: string): Promise<string> {
  const resolvedPath = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
  if (!existsSync(resolvedPath)) {
    throw contractError(404, 'reference_not_found', 'Reference image was not found')
  }
  const allowed = await Promise.all(safeFileRoots().map(async root =>
    isPathWithin(resolvedPath, root) && await isRealPathWithin(resolvedPath, root),
  ))
  if (!allowed.some(Boolean)) {
    throw contractError(403, 'unsafe_reference_path', 'Reference image path is outside the allowed media roots')
  }
  return realpathSync(resolvedPath)
}

async function resolveSafeOutputPath(value: string): Promise<string> {
  const resolvedPath = isAbsolute(value) ? resolve(value) : resolve(process.cwd(), value)
  if (existsSync(resolvedPath) && lstatSync(resolvedPath).isSymbolicLink()) {
    throw contractError(403, 'unsafe_output_path', 'Output path must not be a symbolic link')
  }
  const allowed = await Promise.all(safeFileRoots().map(async root =>
    isPathWithin(resolvedPath, root) && (
      existsSync(resolvedPath)
        ? await isRealPathWithin(resolvedPath, root)
        : await isNearestExistingRealPathWithin(dirname(resolvedPath), root)
    ),
  ))
  if (!allowed.some(Boolean)) {
    throw contractError(403, 'unsafe_output_path', 'Output path is outside the allowed media roots')
  }
  return resolvedPath
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

function assertImageBuffer(
  buffer: Buffer,
  declaredMime: string | null,
  maxBytes: number,
): string {
  if (buffer.length > maxBytes) {
    throw contractError(413, 'reference_too_large', 'A reference image exceeds the per-image size limit')
  }
  const detectedMime = mimeFromMagic(buffer)
  if (!detectedMime || !ALLOWED_IMAGE_MIMES.has(detectedMime)) {
    throw contractError(415, 'unsupported_reference_mime', 'Reference images must be PNG, JPEG, or WebP')
  }
  if (declaredMime && declaredMime !== detectedMime) {
    throw contractError(415, 'reference_mime_mismatch', 'Reference image MIME does not match its content')
  }
  return detectedMime
}

function decodeBase64(value: string): Buffer {
  const compact = value.replace(/\s+/g, '')
  if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw contractError(400, 'invalid_reference_base64', 'Reference image base64 is invalid')
  }
  return Buffer.from(compact, 'base64')
}

function base64Source(input: ImageSourceInput, maxBytes: number): { buffer: Buffer; mime: string; name: string } {
  const raw = typeof input.image_base64 === 'string' ? input.image_base64.trim() : ''
  const dataUri = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/)
  const declaredMime = dataUri
    ? dataUri[1].trim().toLowerCase()
    : typeof input.mime_type === 'string'
      ? input.mime_type.trim().toLowerCase()
      : ''
  if (!ALLOWED_IMAGE_MIMES.has(declaredMime)) {
    throw contractError(415, 'unsupported_reference_mime', 'Reference images must be PNG, JPEG, or WebP')
  }
  const buffer = decodeBase64(dataUri ? dataUri[2] : raw)
  const mime = assertImageBuffer(buffer, declaredMime, maxBytes)
  return { buffer, mime, name: `reference.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}` }
}

function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  const ipv4 = mapped || (isIP(normalized) === 4 ? normalized : '')
  if (!ipv4) return false
  const parts = ipv4.split('.').map(Number)
  return parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] >= 224
}

async function assertSafeImageUrl(url: URL): Promise<void> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw contractError(400, 'unsafe_reference_url', 'Reference image URL is not allowed')
  }
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw contractError(400, 'unsafe_reference_url', 'Reference image URL is not allowed')
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw contractError(400, 'unsafe_reference_url', 'Reference image URL is not allowed')
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw contractError(400, 'reference_url_unreachable', 'Reference image URL could not be resolved')
  }
  if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
    throw contractError(400, 'unsafe_reference_url', 'Reference image URL is not allowed')
  }
}

async function fetchImageBytes(value: string, maxBytes: number): Promise<{ buffer: Buffer; mime: string; name: string }> {
  let current: URL
  try {
    current = new URL(value)
  } catch {
    throw contractError(400, 'invalid_reference_url', 'Reference image URL is invalid')
  }

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertSafeImageUrl(current)
    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: { Accept: 'image/png,image/jpeg,image/webp' },
      })
    } catch {
      throw contractError(400, 'reference_url_unreachable', 'Reference image URL could not be fetched')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      if (!location || redirects === 3) {
        throw contractError(400, 'unsafe_reference_redirect', 'Reference image URL redirect was rejected')
      }
      current = new URL(location, current)
      continue
    }
    if (!response.ok) {
      throw contractError(400, 'reference_url_fetch_failed', 'Reference image URL could not be fetched')
    }
    const contentLength = Number(response.headers.get('content-length') || 0)
    if (contentLength > maxBytes) {
      throw contractError(413, 'reference_too_large', 'A reference image exceeds the per-image size limit')
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const declaredMime = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    const mime = assertImageBuffer(buffer, declaredMime || null, maxBytes)
    const name = current.pathname.split('/').pop() || `reference.${mime.slice(6)}`
    return { buffer, mime, name }
  }
  throw contractError(400, 'unsafe_reference_redirect', 'Reference image URL redirect was rejected')
}

async function normalizeImageSource(
  input: ImageSourceInput,
  maxBytes: number,
): Promise<{ buffer: Buffer; mime: string; name: string }> {
  const sources = [
    typeof input.image_path === 'string' && input.image_path.trim() ? 'path' : '',
    typeof input.image_url === 'string' && input.image_url.trim() ? 'url' : '',
    typeof input.image_base64 === 'string' && input.image_base64.trim() ? 'base64' : '',
  ].filter(Boolean)
  if (sources.length !== 1) {
    throw contractError(400, 'invalid_reference_source', 'Each reference must provide exactly one image_path, image_url, or image_base64')
  }
  if (sources[0] === 'base64') return base64Source(input, maxBytes)
  if (sources[0] === 'url') return fetchImageBytes(String(input.image_url).trim(), maxBytes)

  const safePath = await resolveSafeInputPath(String(input.image_path).trim())
  const buffer = readFileSync(safePath)
  const declaredMime = mimeFromPath(safePath)
  const mime = assertImageBuffer(buffer, declaredMime, maxBytes)
  return { buffer, mime, name: safePath.split(/[\\/]/).pop() || `reference.${mime.slice(6)}` }
}

function numberMetadata(value: unknown, key: 'priority' | 'weight'): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  const valid = Number.isFinite(parsed) &&
    (key === 'priority' ? Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 : parsed >= 0 && parsed <= 1)
  if (!valid) {
    throw contractError(400, `invalid_reference_${key}`, key === 'priority'
      ? 'Reference priority must be an integer from 0 to 100'
      : 'Reference weight must be a number from 0 to 1')
  }
  return parsed
}

async function normalizeReferences(body: any, mode: ApiKeyImageMode): Promise<NormalizedReference[]> {
  const structured = body.references
  if (structured !== undefined && !Array.isArray(structured)) {
    throw contractError(400, 'invalid_references', 'references must be an array')
  }
  if (Array.isArray(structured) && structured.length > MAX_REFERENCE_COUNT) {
    throw contractError(413, 'too_many_references', `At most ${MAX_REFERENCE_COUNT} reference images are allowed`)
  }

  const legacy: ImageSourceInput = {
    image_path: body.image_path,
    image_url: body.image_url,
    image_base64: body.image_base64,
    mime_type: body.mime_type,
  }
  const hasLegacy = [legacy.image_path, legacy.image_url, legacy.image_base64]
    .some(value => typeof value === 'string' && value.trim())
  if (structured?.length && hasLegacy) {
    throw contractError(400, 'ambiguous_references', 'Use references or the legacy single-image fields, not both')
  }
  if (mode === 'text') {
    if (structured?.length || hasLegacy) {
      throw contractError(400, 'references_not_allowed', 'Reference images require image or edit mode')
    }
    return []
  }

  const inputs: ReferenceInput[] = structured?.length
    ? structured
    : hasLegacy
      ? [{ ...legacy, role: 'reference', priority: 0 }]
      : []
  if (!inputs.length) {
    throw contractError(400, 'reference_required', 'image_path, image_url, image_base64, or references is required')
  }

  const normalized: NormalizedReference[] = []
  let totalBytes = 0
  for (const input of inputs) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw contractError(400, 'invalid_reference', 'Each reference must be an object')
    }
    const role = typeof input.role === 'string' ? input.role.trim() : ''
    const priority = numberMetadata(input.priority, 'priority')
    const weight = numberMetadata(input.weight, 'weight')
    if (!role || role.length > 64) {
      throw contractError(400, 'invalid_reference_role', 'Reference role is required and must be at most 64 characters')
    }
    if (structured?.length && priority === undefined && weight === undefined) {
      throw contractError(400, 'reference_metadata_required', 'Each structured reference requires priority or weight')
    }
    const file = await normalizeImageSource(input, structured?.length ? MAX_REFERENCE_BYTES : LEGACY_MAX_IMAGE_BYTES)
    totalBytes += file.buffer.length
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES && structured?.length) {
      throw contractError(413, 'references_total_too_large', 'Reference images exceed the total decoded size limit')
    }
    normalized.push({
      dataUri: `data:${file.mime};base64,${file.buffer.toString('base64')}`,
      file,
      role,
      priority,
      weight,
    })
  }
  return normalized
}

function normalizeImageMode(value: unknown): ApiKeyImageMode {
  const mode = String(value || 'text').trim().toLowerCase()
  if (mode === 'text' || mode === 'image' || mode === 'edit') return mode
  throw contractError(400, 'invalid_mode', 'mode must be one of text, image, or edit')
}

function normalizePositiveInt(value: unknown, fallback: number, key: string): number {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    throw contractError(400, `invalid_${key}`, `${key} must be a positive integer`)
  }
  return parsed
}

function normalizeText(value: unknown, fallback: string, key: string, maxLength = 128): string {
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : fallback
  if (normalized.length > maxLength) {
    throw contractError(400, `invalid_${key}`, `${key} is too long`)
  }
  return normalized
}

function collectImageBase64(event: any, images: string[] = []): string[] {
  if (!event || typeof event !== 'object') return images
  for (const key of ['b64_json', 'base64', 'image_base64', 'partial_image_b64']) {
    if (typeof event[key] === 'string' && event[key]) {
      if (event[key].length > MAX_GENERATED_BASE64_CHARS) {
        throw contractError(502, 'upstream_image_too_large', 'Image provider returned an image that exceeds the output size limit')
      }
      images.push(event[key])
    }
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

async function readSseImageResults(response: Response, limit: number): Promise<string[]> {
  if (!response.body) throw contractError(502, 'upstream_invalid_response', 'Image provider returned an unreadable response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const images: string[] = []
  let buffer = ''
  const readFrame = (frame: string): void => {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    let event: any
    try {
      event = JSON.parse(data)
    } catch {
      throw contractError(502, 'upstream_invalid_response', 'Image provider returned an invalid stream')
    }
    if (event?.type === 'error' || event?.type === 'response.failed') {
      throw contractError(502, 'upstream_stream_error', 'Image provider reported a generation failure')
    }
    if (isPartialImageEvent(event)) return
    collectImageBase64(event, images)
  }
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    if (buffer.length > MAX_GENERATED_BASE64_CHARS * Math.max(1, limit)) {
      throw contractError(502, 'upstream_response_too_large', 'Image provider response exceeds the output size limit')
    }
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) {
      readFrame(frame)
      if (images.length >= limit) return images.slice(0, limit)
    }
  }
  if (buffer.trim()) readFrame(buffer)
  return images.slice(0, limit)
}

function upstreamError(status: number): MediaContractError {
  if (status === 401 || status === 403) return contractError(502, 'upstream_auth_failed', 'Image provider authentication failed')
  if (status === 429) return contractError(503, 'upstream_rate_limited', 'Image provider rate limit was reached')
  if (status === 400 || status === 409 || status === 422) return contractError(502, 'upstream_rejected_request', 'Image provider rejected the generation request')
  return contractError(502, 'upstream_unavailable', 'Image provider is unavailable')
}

function dimensionsFromPng(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function dimensionsFromJpeg(buffer: Buffer): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = buffer[offset + 1]
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2
      continue
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2) break
    offset += 2 + length
  }
  return null
}

function dimensionsFromWebp(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 30) return null
  const chunk = buffer.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    }
  }
  if (chunk === 'VP8 ' && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (chunk === 'VP8L' && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21)
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    }
  }
  return null
}

function generatedImage(value: string): GeneratedImage {
  const buffer = decodeBase64(value)
  const mime = mimeFromMagic(buffer)
  if (!mime) throw contractError(502, 'upstream_invalid_image', 'Image provider returned invalid image data')
  const format = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : 'webp'
  const dimensions = format === 'png'
    ? dimensionsFromPng(buffer)
    : format === 'jpeg'
      ? dimensionsFromJpeg(buffer)
      : dimensionsFromWebp(buffer)
  return { base64: value, buffer, format, dimensions }
}

export function imageRequestId(headerValue: string): string {
  const normalized = headerValue.trim()
  return /^[A-Za-z0-9._-]{1,128}$/.test(normalized)
    ? normalized
    : randomUUID()
}

export async function requestApiKeyImages(
  provider: ApiKeyImageProvider,
  body: any,
  requestId: string,
): Promise<{ mode: ApiKeyImageMode; result: ApiKeyImageRequestResult }> {
  let requestBytes: number
  try {
    requestBytes = Buffer.byteLength(JSON.stringify(body || {}))
  } catch {
    throw contractError(400, 'invalid_request_body', 'Request body must be valid JSON')
  }
  if (requestBytes > MAX_IMAGE_REQUEST_BYTES) {
    throw contractError(413, 'request_too_large', 'Image generation request exceeds the request size limit')
  }

  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw contractError(400, 'prompt_required', 'prompt is required')
  if (prompt.length > 32_000) throw contractError(400, 'prompt_too_long', 'prompt is too long')

  const mode = normalizeImageMode(body.mode)
  const n = normalizePositiveInt(body.n, 1, 'n')
  if (n > 4) throw contractError(400, 'invalid_n', 'n must be between 1 and 4')
  const timeoutMs = normalizePositiveInt(body.timeout_ms, DEFAULT_TIMEOUT_MS, 'timeout_ms')
  const references = await normalizeReferences(body, mode)
  const quality = normalizeText(body.quality, DEFAULT_QUALITY, 'quality', 32)
  const resolution = normalizeText(body.resolution, DEFAULT_RESOLUTION, 'resolution', 32)
  const aspect = normalizeText(body.aspect ?? body.aspect_ratio, 'auto', 'aspect', 32)
  const imageModel = normalizeText(
    body.image_model ?? body.model,
    DEFAULT_IMAGE_MODEL,
    'image_model',
  )
  const responseModel = normalizeText(body.response_model, provider.model || DEFAULT_RESPONSE_MODEL, 'response_model')
  const outputFormat = normalizeText(body.output_format, 'png', 'output_format', 16)
  if (!['png', 'jpeg', 'webp'].includes(outputFormat)) {
    throw contractError(400, 'invalid_output_format', 'output_format must be png, jpeg, or webp')
  }

  const headers = {
    Accept: 'text/event-stream',
    Authorization: `Bearer ${provider.apiKey}`,
    'X-Request-Id': requestId,
  }
  const generationOptions = {
    quality,
    resolution,
    aspect_ratio: aspect,
    ...(typeof body.size === 'string' && body.size.trim() ? { size: body.size.trim() } : {}),
  }

  let response: Response
  try {
    if (mode === 'text') {
      response = await fetch(buildApiUrl(provider.baseUrl, '/v1/images/generations'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: imageModel,
          prompt,
          n,
          ...generationOptions,
          stream: true,
          response_format: 'b64_json',
        }),
      })
    } else if (mode === 'image') {
      response = await fetch(buildApiUrl(provider.baseUrl, '/v1/responses'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: responseModel,
          stream: true,
          input: [{
            role: 'user',
            content: [
              { type: 'input_text', text: prompt },
              ...references.map(reference => ({
                type: 'input_image',
                image_url: reference.dataUri,
                reference_role: reference.role,
                ...(reference.priority === undefined ? {} : { priority: reference.priority }),
                ...(reference.weight === undefined ? {} : { weight: reference.weight }),
              })),
            ],
          }],
          tools: [{
            type: 'image_generation',
            model: imageModel,
            ...generationOptions,
            output_format: outputFormat,
          }],
          tool_choice: { type: 'image_generation' },
        }),
      })
    } else {
      const form = new FormData()
      for (const [index, reference] of references.entries()) {
        const bytes = new Uint8Array(reference.file.buffer.byteLength)
        bytes.set(reference.file.buffer)
        form.append(references.length === 1 ? 'image' : 'image[]', new Blob([bytes.buffer], { type: reference.file.mime }), reference.file.name)
        if (references.length > 1) {
          form.append(`reference_role[${index}]`, reference.role)
          if (reference.priority !== undefined) form.append(`reference_priority[${index}]`, String(reference.priority))
          if (reference.weight !== undefined) form.append(`reference_weight[${index}]`, String(reference.weight))
        }
      }
      form.append('prompt', prompt)
      form.append('model', imageModel)
      form.append('n', String(n))
      form.append('quality', quality)
      form.append('resolution', resolution)
      form.append('aspect_ratio', aspect)
      if (typeof body.size === 'string' && body.size.trim()) form.append('size', body.size.trim())
      form.append('stream', 'true')
      form.append('response_format', 'b64_json')
      response = await fetch(buildApiUrl(provider.baseUrl, '/v1/images/edits'), {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
        body: form,
      })
    }
  } catch (err: any) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw contractError(504, 'upstream_timeout', 'Image provider request timed out')
    }
    if (err?.expose) throw err
    throw contractError(502, 'upstream_unavailable', 'Image provider is unavailable')
  }

  if (!response.ok) throw upstreamError(response.status)
  const encodedImages = await readSseImageResults(response, n)
  if (!encodedImages.length) {
    throw contractError(502, 'upstream_empty_result', 'Image provider returned no completed image')
  }
  const images = encodedImages.map(generatedImage)
  if (images.some(image => image.buffer.length > MAX_GENERATED_IMAGE_BYTES)) {
    throw contractError(502, 'upstream_image_too_large', 'Image provider returned an image that exceeds the output size limit')
  }
  if (images.reduce((total, image) => total + image.buffer.length, 0) > MAX_GENERATED_TOTAL_BYTES) {
    throw contractError(502, 'upstream_response_too_large', 'Image provider response exceeds the output size limit')
  }
  return {
    mode,
    result: {
      images,
      model: imageModel,
      provider: provider.name,
      quality,
      resolution,
      aspect,
    },
  }
}

export async function saveGeneratedImages(
  images: GeneratedImage[],
  defaultPath: (index: number, format: GeneratedImage['format']) => string,
  requestedOutputPath?: string,
): Promise<Array<GeneratedImage & { outputPath: string }>> {
  const results: Array<GeneratedImage & { outputPath: string }> = []
  for (const [index, image] of images.entries()) {
    const candidate = requestedOutputPath && images.length === 1
      ? requestedOutputPath
      : requestedOutputPath
        ? requestedOutputPath.replace(/(\.[^.\\/]+)?$/, `${index > 0 ? `-${index + 1}` : ''}$1`)
        : defaultPath(index, image.format)
    const outputPath = await resolveSafeOutputPath(candidate)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, image.buffer)
    results.push({ ...image, outputPath })
  }
  return results
}

export function publicImageError(err: any): { status: number; error: string; code: string } {
  if (err?.expose && typeof err?.code === 'string') {
    return {
      status: Number(err.status) || 400,
      error: String(err.message || 'Image generation request failed'),
      code: err.code,
    }
  }
  return {
    status: 500,
    error: 'Image generation failed',
    code: 'image_generation_failed',
  }
}
