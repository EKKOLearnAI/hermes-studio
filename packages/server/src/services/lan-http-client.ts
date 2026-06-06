import http from 'http'
import https from 'https'

export type LanJsonTransport = 'fetch' | 'node-http'

export type LanNetworkErrorDetail = {
  name: string
  message: string
  code?: string
  syscall?: string
  address?: string
  port?: number
}

export type LanJsonPostResponse = {
  ok: boolean
  status: number
  data: Record<string, unknown>
  transport: LanJsonTransport
  primaryError?: LanNetworkErrorDetail
}

export class LanJsonPostError extends Error {
  primaryError: LanNetworkErrorDetail
  fallbackError: LanNetworkErrorDetail

  constructor(primaryError: LanNetworkErrorDetail, fallbackError: LanNetworkErrorDetail) {
    super(`fetch failed: ${primaryError.message}; node-http fallback failed: ${fallbackError.message}`)
    this.name = 'LanJsonPostError'
    this.primaryError = primaryError
    this.fallbackError = fallbackError
  }
}

function networkErrorDetail(err: any): LanNetworkErrorDetail {
  return {
    name: String(err?.name || 'Error'),
    message: String(err?.message || err || 'request failed'),
    code: typeof err?.code === 'string' ? err.code : undefined,
    syscall: typeof err?.syscall === 'string' ? err.syscall : undefined,
    address: typeof err?.address === 'string' ? err.address : undefined,
    port: typeof err?.port === 'number' ? err.port : undefined,
  }
}

async function postJsonWithFetch(url: string, body: unknown, timeoutMs: number): Promise<LanJsonPostResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    return {
      ok: response.ok,
      status: response.status,
      data,
      transport: 'fetch',
    }
  } finally {
    clearTimeout(timeout)
  }
}

function parseJsonObject(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function postJsonWithNodeHttp(url: string, body: unknown, timeoutMs: number, primaryError: LanNetworkErrorDetail): Promise<LanJsonPostResponse> {
  const target = new URL(url)
  const payload = JSON.stringify(body)
  const client = target.protocol === 'https:' ? https : http

  return new Promise((resolve, reject) => {
    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => {
        const status = res.statusCode || 0
        resolve({
          ok: status >= 200 && status < 300,
          status,
          data: parseJsonObject(Buffer.concat(chunks).toString('utf-8')),
          transport: 'node-http',
          primaryError,
        })
      })
    })

    req.on('timeout', () => {
      const err = new Error(`request timed out after ${timeoutMs}ms`) as Error & { code?: string }
      err.code = 'ETIMEDOUT'
      req.destroy(err)
    })
    req.on('error', reject)
    req.end(payload)
  })
}

export async function postLanJson(url: string, body: unknown, timeoutMs = 5000): Promise<LanJsonPostResponse> {
  try {
    return await postJsonWithFetch(url, body, timeoutMs)
  } catch (err: any) {
    const primaryError = networkErrorDetail(err)
    try {
      return await postJsonWithNodeHttp(url, body, timeoutMs, primaryError)
    } catch (fallbackErr: any) {
      throw new LanJsonPostError(primaryError, networkErrorDetail(fallbackErr))
    }
  }
}

export function describeLanJsonPostError(err: any): Record<string, unknown> | null {
  if (err instanceof LanJsonPostError) {
    return {
      message: err.message,
      primary: err.primaryError,
      fallback: err.fallbackError,
    }
  }
  if (!err) return null
  return { message: String(err?.message || err) }
}
