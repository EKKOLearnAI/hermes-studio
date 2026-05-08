import type { Context } from 'koa'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'

function getUpstream(profile: string): string {
  const mgr = getGatewayManagerInstance()
  if (!mgr) {
    throw new Error('GatewayManager not initialized')
  }
  return mgr.getUpstream(profile)
}

function getApiKey(profile: string): string | null {
  const mgr = getGatewayManagerInstance()
  return mgr?.getApiKey(profile) ?? null
}

function resolveProfile(ctx: Context): string {
  // Use header/query from request first, then fall back to authoritative source
  const requestedProfile = ctx.get('x-hermes-profile') || (ctx.query.profile as string)

  if (requestedProfile) {
    return requestedProfile
  }

  // Fallback: read from authoritative source (active_profile file)
  try {
    const { getActiveProfileName } = require('../../services/hermes/hermes-profile')
    return getActiveProfileName()
  } catch {
    return 'default'
  }
}

function buildHeaders(profile: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = getApiKey(profile)
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

const TIMEOUT_MS = 30_000

async function readUpstreamError(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return await res.json()
    } catch {
      // Fall through to a stable error shape below.
    }
  }

  const text = await res.text().catch(() => '')
  return { error: { message: text || `Upstream error: ${res.status} ${res.statusText}` } }
}

async function proxyRequest(ctx: Context, upstreamPath: string, method?: string): Promise<void> {
  const profile = resolveProfile(ctx)
  let upstream: string
  try {
    upstream = getUpstream(profile)
  } catch (e: any) {
    ctx.status = 503
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: { message: e?.message || 'GatewayManager not initialized' } }
    return
  }
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildHeaders(profile)
  const body = ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD'
    ? JSON.stringify(ctx.request.body || {})
    : undefined

  let res: Response
  try {
    res = await fetch(url, {
      method: method || ctx.req.method,
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e: any) {
    ctx.status = 502
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: { message: `Proxy error: ${e.message}` } }
    return
  }

  if (!res.ok) {
    ctx.status = res.status
    ctx.set('Content-Type', 'application/json')
    ctx.body = await readUpstreamError(res)
    return
  }

  ctx.status = res.status
  ctx.set('Content-Type', res.headers.get('content-type') || 'application/json')
  ctx.body = await res.json()
}

export async function list(ctx: Context) {
  await proxyRequest(ctx, '/api/jobs')
}

export async function get(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function create(ctx: Context) {
  await proxyRequest(ctx, '/api/jobs')
}

export async function update(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function remove(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}`)
}

export async function pause(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/pause`)
}

export async function resume(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/resume`)
}

export async function run(ctx: Context) {
  await proxyRequest(ctx, `/api/jobs/${ctx.params.id}/run`)
}
