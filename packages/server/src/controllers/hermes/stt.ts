import type { Context } from 'koa'
import {
  assertActiveSttProvider,
  assertStoredSttProvider,
  clearStoredSttSecret,
  getActiveSttProvider,
  getSttProviderSetting,
  listSttProviderSettings,
  removeSttBaseUrlPreset,
  saveActiveSttProvider,
  saveSttProviderSetting,
  SttSettingsValidationError,
  type StoredSttProvider,
} from '../../db/hermes/stt-settings-store'
import { SttProviderConfigError, transcribeWithProvider } from '../../services/hermes/stt-providers'

const MAX_STT_UPLOAD_SIZE = 50 * 1024 * 1024

interface ParsedPart {
  fieldName: string
  filename: string | null
  contentType: string | null
  data: Buffer
}

interface ParsedMultipartBody {
  fields: Record<string, string>
  files: ParsedPart[]
}

class MultipartParseError extends Error {}

function authUserId(ctx: Context): number | null {
  const rawUserId = ctx.state.user?.id
  const userId = typeof rawUserId === 'number' ? rawUserId : Number.NaN
  if (!Number.isInteger(userId) || userId <= 0) {
    ctx.status = 401
    ctx.body = { error: 'Unauthorized' }
    return null
  }
  return userId
}

function handleSettingsError(ctx: Context, error: unknown): boolean {
  if (error instanceof SttSettingsValidationError) {
    ctx.status = 400
    ctx.body = { error: error.message }
    return true
  }
  return false
}

function splitMultipart(raw: Buffer, boundary: Buffer): Buffer[] {
  const parts: Buffer[] = []
  let start = 0
  while (true) {
    const idx = raw.indexOf(boundary, start)
    if (idx === -1) break
    if (start > 0) {
      parts.push(raw.subarray(start + 2, idx))
    }
    start = idx + boundary.length
  }
  return parts
}

function parseMultipartPart(part: Buffer): ParsedPart | null {
  const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
  if (headerEnd === -1) return null

  const header = part.subarray(0, headerEnd).toString('utf-8')
  const data = part.subarray(headerEnd + 4, part.length - 2)
  const disposition = header.match(/Content-Disposition:\s*form-data;([^\r\n]*)/i)?.[1]
  if (!disposition) return null

  const fieldName = disposition.match(/\bname="([^"]+)"/)?.[1]
  if (!fieldName) return null

  let filename: string | null = null
  const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encodedFilename) {
    try {
      filename = decodeURIComponent(encodedFilename.trim().replace(/^"|"$/g, ''))
    } catch {
      throw new MultipartParseError('Malformed multipart filename')
    }
  } else {
    filename = disposition.match(/\bfilename="([^"]*)"/)?.[1] ?? null
  }

  const contentType = header.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null

  return {
    fieldName,
    filename,
    contentType,
    data,
  }
}

async function readMultipartBody(ctx: Context): Promise<ParsedMultipartBody | { error: string; status: number }> {
  const contentType = ctx.get('content-type') || ''
  if (!contentType.startsWith('multipart/form-data')) {
    return { error: 'Expected multipart/form-data', status: 400 }
  }

  const boundaryStr = contentType.split('boundary=')[1]
  if (!boundaryStr) {
    return { error: 'Missing boundary', status: 400 }
  }

  const boundary = Buffer.from(`--${boundaryStr.split(';')[0].trim()}`)
  const chunks: Buffer[] = []
  let totalSize = 0

  for await (const chunk of ctx.req) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalSize += bufferChunk.length
    if (totalSize > MAX_STT_UPLOAD_SIZE) {
      return { error: `Upload too large (max ${MAX_STT_UPLOAD_SIZE / 1024 / 1024}MB)`, status: 413 }
    }
    chunks.push(bufferChunk)
  }

  const fields: Record<string, string> = {}
  const files: ParsedPart[] = []
  const raw = Buffer.concat(chunks)

  for (const part of splitMultipart(raw, boundary)) {
    let parsed: ParsedPart | null
    try {
      parsed = parseMultipartPart(part)
    } catch (error) {
      if (error instanceof MultipartParseError) {
        return { error: error.message, status: 400 }
      }
      throw error
    }
    if (!parsed) continue

    if (parsed.filename !== null) {
      files.push(parsed)
      continue
    }

    fields[parsed.fieldName] = parsed.data.toString('utf-8').trim()
  }

  return { fields, files }
}

function findAudioPart(files: ParsedPart[]): ParsedPart | null {
  return files.find(part => part.fieldName === 'audio') || null
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function createRequestAbortController(ctx: Context): AbortController {
  const controller = new AbortController()

  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort()
    }
  }

  if (ctx.req?.on) {
    ctx.req.on('aborted', abort)
  }

  if (ctx.res?.on) {
    ctx.res.on('close', () => {
      if (!ctx.res.writableEnded) {
        abort()
      }
    })
  }

  return controller
}

export async function listSettings(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  try {
    ctx.body = {
      settings: listSttProviderSettings(userId),
      activeProvider: getActiveSttProvider(userId),
    }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function saveSettings(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const body = ctx.request.body as {
    settings?: unknown
    secrets?: unknown
    activeProvider?: unknown
  } | undefined

  try {
    const storedProvider = assertStoredSttProvider(provider)
    const setting = saveSttProviderSetting(userId, storedProvider, {
      settings: body?.settings,
      secrets: body?.secrets,
    })
    const activeProvider = body?.activeProvider === undefined
      ? saveActiveSttProvider(userId, storedProvider)
      : saveActiveSttProvider(userId, assertActiveSttProvider(String(body.activeProvider)))

    ctx.body = { setting, activeProvider }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function deleteBaseUrlPreset(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const rawUrl = typeof ctx.query.url === 'string' ? ctx.query.url : ''
  if (!rawUrl.trim()) {
    ctx.status = 400
    ctx.body = { error: 'baseUrl is required' }
    return
  }

  try {
    const setting = removeSttBaseUrlPreset(userId, assertStoredSttProvider(provider), rawUrl)
    ctx.body = { success: true, setting }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function deleteSecret(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const provider = ctx.params.provider || ''
  const secretName = ctx.params.secretName || ''

  try {
    const setting = clearStoredSttSecret(userId, assertStoredSttProvider(provider), secretName)
    ctx.body = { success: true, setting }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

export async function saveActiveProvider(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const body = ctx.request.body as { provider?: unknown } | undefined

  try {
    const activeProvider = saveActiveSttProvider(userId, assertActiveSttProvider(String(body?.provider || '')))
    ctx.body = { activeProvider }
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }
}

function resolveStoredProvider(fields: Record<string, string>): StoredSttProvider {
  return assertStoredSttProvider(fields.provider || '')
}

export async function transcribe(ctx: Context) {
  const userId = authUserId(ctx)
  if (!userId) return

  const parsed = await readMultipartBody(ctx)
  if ('error' in parsed) {
    ctx.status = parsed.status
    ctx.body = { error: parsed.error }
    return
  }

  let provider: StoredSttProvider
  try {
    provider = resolveStoredProvider(parsed.fields)
  } catch (error) {
    if (handleSettingsError(ctx, error)) return
    throw error
  }

  const audio = findAudioPart(parsed.files)
  if (!audio) {
    ctx.status = 400
    ctx.body = { error: 'audio is required' }
    return
  }

  const storedSetting = getSttProviderSetting(userId, provider, { includeSecrets: true })
  if (!storedSetting) {
    ctx.status = 400
    ctx.body = { error: `STT settings are required for provider ${provider}` }
    return
  }

  if (!storedSetting.secrets.apiKey) {
    ctx.status = 400
    ctx.body = { error: `STT settings are incomplete for provider ${provider}` }
    return
  }

  const controller = createRequestAbortController(ctx)

  try {
    const result = await transcribeWithProvider({
      provider,
      audio: audio.data,
      fileName: audio.filename || 'audio',
      mimeType: audio.contentType || 'application/octet-stream',
      settings: storedSetting.settings,
      secrets: storedSetting.secrets,
      signal: controller.signal,
    })

    ctx.body = result
  } catch (error) {
    if (isAbortError(error)) {
      ctx.status = 499
      ctx.body = { error: 'STT request aborted' }
      return
    }

    if (error instanceof SttProviderConfigError) {
      ctx.status = 400
      ctx.body = { error: error.message }
      return
    }

    ctx.status = 502
    const detail = error instanceof Error ? error.message : ''
    ctx.body = { error: detail ? `STT transcription failed: ${detail}` : 'STT transcription failed' }
  }
}
