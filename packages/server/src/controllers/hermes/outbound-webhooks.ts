/**
 * Management API for outbound webhook endpoints.
 *
 * Secrets are write-only: every response reports `has_secret` and never the
 * value, and errors coming back from a receiver are truncated before they are
 * stored or returned.
 */

import type { Context } from 'koa'
import { randomUUID } from 'crypto'
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  listRecentDeliveries,
  updateEndpoint,
  type WebhookEndpointRecord,
} from '../../db/hermes/event-outbox-store'
import {
  buildEnvelope,
  getEventOutboxCapability,
  isEventType,
  EVENT_SCHEMA_VERSION,
} from '../../services/hermes/event-outbox'
import { postEnvelope } from '../../services/hermes/event-outbox/dispatcher'

interface PublicEndpoint {
  id: string
  name: string
  url: string
  has_secret: boolean
  secret_env: string
  event_types: string[]
  profiles: string[]
  enabled: boolean
  max_attempts: number
  created_at: number
  updated_at: number
}

function toPublic(endpoint: WebhookEndpointRecord): PublicEndpoint {
  return {
    id: endpoint.id,
    name: endpoint.name,
    url: endpoint.url,
    has_secret: Boolean(endpoint.secret || endpoint.secret_env),
    secret_env: endpoint.secret_env,
    event_types: endpoint.event_types,
    profiles: endpoint.profiles,
    enabled: endpoint.enabled,
    max_attempts: endpoint.max_attempts,
    created_at: endpoint.created_at,
    updated_at: endpoint.updated_at,
  }
}

function isAllowedUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function readEventTypes(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const types = value.map(item => String(item))
  return types.every(isEventType) ? types : null
}

export async function listWebhookEndpoints(ctx: Context) {
  ctx.body = { endpoints: listEndpoints().map(toPublic) }
}

export async function createWebhookEndpoint(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const name = String(body.name || '').trim()
  const url = String(body.url || '').trim()
  if (!name || !url) {
    ctx.status = 400
    ctx.body = { error: 'name and url are required' }
    return
  }
  if (!isAllowedUrl(url)) {
    ctx.status = 400
    ctx.body = { error: 'url must be an http(s) URL' }
    return
  }
  const eventTypes = readEventTypes(body.event_types)
  if (!eventTypes) {
    ctx.status = 400
    ctx.body = { error: 'event_types must contain known event type names' }
    return
  }

  const endpoint = createEndpoint({
    name,
    url,
    secret: typeof body.secret === 'string' ? body.secret : '',
    secret_env: typeof body.secret_env === 'string' ? body.secret_env : '',
    event_types: eventTypes,
    profiles: Array.isArray(body.profiles) ? body.profiles.map(item => String(item)) : [],
    enabled: body.enabled !== false,
    max_attempts: Number(body.max_attempts) || undefined,
  })
  if (!endpoint) {
    ctx.status = 503
    ctx.body = { error: 'storage unavailable' }
    return
  }
  ctx.body = { endpoint: toPublic(endpoint) }
}

export async function updateWebhookEndpoint(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  if (body.url !== undefined && !isAllowedUrl(String(body.url))) {
    ctx.status = 400
    ctx.body = { error: 'url must be an http(s) URL' }
    return
  }
  const eventTypes = body.event_types === undefined ? undefined : readEventTypes(body.event_types)
  if (eventTypes === null) {
    ctx.status = 400
    ctx.body = { error: 'event_types must contain known event type names' }
    return
  }

  const endpoint = updateEndpoint(String(ctx.params.id), {
    name: body.name === undefined ? undefined : String(body.name),
    url: body.url === undefined ? undefined : String(body.url),
    secret: body.secret === undefined ? undefined : String(body.secret),
    secret_env: body.secret_env === undefined ? undefined : String(body.secret_env),
    event_types: eventTypes,
    profiles: body.profiles === undefined ? undefined : (Array.isArray(body.profiles) ? body.profiles.map(item => String(item)) : []),
    enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
    max_attempts: body.max_attempts === undefined ? undefined : Number(body.max_attempts),
  })
  if (!endpoint) {
    ctx.status = 404
    ctx.body = { error: 'endpoint not found' }
    return
  }
  ctx.body = { endpoint: toPublic(endpoint) }
}

export async function removeWebhookEndpoint(ctx: Context) {
  if (!deleteEndpoint(String(ctx.params.id))) {
    ctx.status = 404
    ctx.body = { error: 'endpoint not found' }
    return
  }
  ctx.body = { success: true }
}

export async function setWebhookEndpointEnabled(ctx: Context) {
  const body = (ctx.request.body || {}) as Record<string, unknown>
  const endpoint = updateEndpoint(String(ctx.params.id), { enabled: Boolean(body.enabled) })
  if (!endpoint) {
    ctx.status = 404
    ctx.body = { error: 'endpoint not found' }
    return
  }
  ctx.body = { endpoint: toPublic(endpoint) }
}

/**
 * Sends one synthetic envelope so the user can confirm the URL, the signature
 * and their receiver before real events depend on it. The test event is not
 * written to the outbox.
 */
export async function testWebhookEndpoint(ctx: Context) {
  const endpoint = getEndpoint(String(ctx.params.id))
  if (!endpoint) {
    ctx.status = 404
    ctx.body = { error: 'endpoint not found' }
    return
  }
  const envelope = buildEnvelope({
    id: `test_${randomUUID()}`,
    type: 'chat.run.completed',
    occurredAt: Date.now(),
    profile: ctx.state?.profile?.name || 'default',
    source: 'studio.test',
    subject: {},
    summary: { status: 'test' },
  })
  const outcome = await postEnvelope(
    endpoint,
    { id: `test_${randomUUID()}` } as any,
    envelope,
  )
  ctx.body = {
    ok: outcome.ok,
    status: outcome.status,
    error: outcome.error,
    signed: Boolean(endpoint.secret || endpoint.secret_env),
    schema_version: EVENT_SCHEMA_VERSION,
  }
}

export async function listWebhookEndpointDeliveries(ctx: Context) {
  const endpoint = getEndpoint(String(ctx.params.id))
  if (!endpoint) {
    ctx.status = 404
    ctx.body = { error: 'endpoint not found' }
    return
  }
  const limit = Number(ctx.query.limit) || 20
  ctx.body = { deliveries: listRecentDeliveries(endpoint.id, limit) }
}

export async function getCapabilities(ctx: Context) {
  ctx.body = { capabilities: { event_outbox: getEventOutboxCapability() } }
}
