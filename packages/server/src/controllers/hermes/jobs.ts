import type { Context } from 'koa'
import { getGatewayManagerInstance } from '../../services/gateway-bootstrap'
import { config } from '../../config'

function getUpstream(profile: string): string {
  const mgr = getGatewayManagerInstance()
  return mgr ? mgr.getUpstream(profile) : config.upstream.replace(/\/$/, '')
}

function getApiKey(profile: string): string | null {
  const mgr = getGatewayManagerInstance()
  return mgr?.getApiKey(profile) ?? null
}

function resolveProfile(ctx: Context): string {
  return ctx.get('x-hermes-profile') || (ctx.query.profile as string) || 'default'
}

function buildHeaders(profile: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = getApiKey(profile)
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

const TIMEOUT_MS = 30_000

async function proxyRequest(ctx: Context, upstreamPath: string, method?: string): Promise<void> {
  const profile = resolveProfile(ctx)
  const upstream = getUpstream(profile)
  const params = new URLSearchParams(ctx.search || '')
  params.delete('token')
  const search = params.toString()
  const url = `${upstream}${upstreamPath}${search ? `?${search}` : ''}`

  const headers = buildHeaders(profile)
  const body = ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD'
    ? JSON.stringify(ctx.request.body || {})
    : undefined

  const res = await fetch(url, {
    method: method || ctx.req.method,
    headers,
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!res.ok) {
    ctx.status = 502
    ctx.set('Content-Type', 'application/json')
    ctx.body = { error: { message: `Upstream error: ${res.status} ${res.statusText}` } }
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
