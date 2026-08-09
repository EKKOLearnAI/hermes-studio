/**
 * Delivers outbox events to configured webhook endpoints.
 *
 * Nothing here blocks a run: publishing an event only writes rows, and this
 * dispatcher drains them on its own interval. Everything it needs to resume
 * after a restart is in the deliveries table, so an interrupted attempt is
 * picked up again rather than lost.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { logger } from '../../logger'
import {
  claimDueDeliveries,
  getEndpoint,
  getEvent,
  markDead,
  markDelivered,
  markRetry,
  type DeliveryRecord,
  type WebhookEndpointRecord,
} from '../../../db/hermes/event-outbox-store'
import { buildEnvelope, type EventEnvelope } from './envelope'

const DEFAULT_INTERVAL_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
/** Receivers answer with an ack, not a document; anything larger is ignored. */
const MAX_RESPONSE_BYTES = 64 * 1024
const BASE_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 60 * 60_000

export const EVENT_HEADER = 'X-Hermes-Event'
export const DELIVERY_HEADER = 'X-Hermes-Delivery'
export const TIMESTAMP_HEADER = 'X-Hermes-Timestamp'
export const SIGNATURE_HEADER = 'X-Hermes-Signature-256'

/**
 * The signature covers `timestamp + "." + rawBody`, so a receiver can reject a
 * replayed body by checking the timestamp is recent before comparing digests.
 */
export function signPayload(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`
}

export function verifySignature(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, timestamp, rawBody))
  const received = Buffer.from(String(signature || ''))
  if (expected.length !== received.length) return false
  return timingSafeEqual(expected, received)
}

/** A secret named by `secret_env` wins, so deployments can keep it out of the DB. */
export function resolveEndpointSecret(endpoint: WebhookEndpointRecord, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = endpoint.secret_env ? String(env[endpoint.secret_env] || '').trim() : ''
  return fromEnv || endpoint.secret || ''
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

/**
 * Exponential backoff with full jitter, so a receiver coming back up does not
 * take the whole backlog in one synchronized burst.
 */
export function nextBackoffMs(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts))
  return Math.max(BASE_BACKOFF_MS, Math.floor(ceiling * (0.5 + random() * 0.5)))
}

export interface DeliveryOutcome {
  ok: boolean
  status: number
  error: string
}

export async function postEnvelope(
  endpoint: WebhookEndpointRecord,
  delivery: DeliveryRecord,
  envelope: EventEnvelope,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryOutcome> {
  const rawBody = JSON.stringify(envelope)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const secret = resolveEndpointSecret(endpoint)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'HermesStudio-EventOutbox/1',
    [EVENT_HEADER]: envelope.type,
    [DELIVERY_HEADER]: delivery.id,
    [TIMESTAMP_HEADER]: timestamp,
  }
  if (secret) headers[SIGNATURE_HEADER] = signPayload(secret, timestamp, rawBody)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(endpoint.url, {
      method: 'POST',
      headers,
      body: rawBody,
      // A redirect could send a signed payload somewhere the user never named.
      redirect: 'manual',
      signal: controller.signal,
    })
    const status = Number(response.status) || 0
    let detail = ''
    try {
      const text = await response.text()
      detail = text.slice(0, MAX_RESPONSE_BYTES)
    } catch {
      detail = ''
    }
    if (status >= 200 && status < 300) return { ok: true, status, error: '' }
    return { ok: false, status, error: detail.slice(0, 300) }
  } catch (error: any) {
    return { ok: false, status: 0, error: String(error?.message || error).slice(0, 300) }
  } finally {
    clearTimeout(timer)
  }
}

export class EventOutboxDispatcher {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private closing = false

  constructor(
    private readonly options: {
      intervalMs?: number
      batchSize?: number
      fetchImpl?: typeof fetch
    } = {},
  ) {}

  start(): void {
    if (this.timer) return
    this.closing = false
    const interval = this.options.intervalMs ?? DEFAULT_INTERVAL_MS
    // Pending rows left by a previous process are picked up by the first tick.
    this.timer = setInterval(() => { void this.tick() }, interval)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    this.closing = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Drain one batch. Exposed so tests can drive delivery without timers. */
  async tick(): Promise<number> {
    if (this.running || this.closing) return 0
    this.running = true
    let delivered = 0
    try {
      const batch = claimDueDeliveries(this.options.batchSize ?? 20)
      for (const delivery of batch) {
        if (this.closing) break
        const handled = await this.deliverOne(delivery)
        if (handled) delivered++
      }
    } catch (error) {
      logger.warn(error, '[event-outbox] dispatcher tick failed')
    } finally {
      this.running = false
    }
    return delivered
  }

  private async deliverOne(delivery: DeliveryRecord): Promise<boolean> {
    const endpoint = getEndpoint(delivery.endpoint_id)
    const event = getEvent(delivery.event_id)
    if (!endpoint || !event) {
      markDead(delivery.id, 0, 'endpoint or event no longer exists')
      return false
    }
    if (!endpoint.enabled) {
      // Nothing to do while it is off; leave it pending for when it returns.
      markRetry(delivery.id, Date.now() + nextBackoffMs(delivery.attempts), 0, 'endpoint disabled')
      return false
    }

    const envelope = buildEnvelope({
      id: event.id,
      type: event.type,
      occurredAt: event.occurred_at,
      profile: event.profile,
      source: event.source,
      subject: event.subject,
      summary: event.summary,
    })

    const outcome = await postEnvelope(endpoint, delivery, envelope, this.options.fetchImpl ?? fetch)
    if (outcome.ok) {
      markDelivered(delivery.id, outcome.status)
      return true
    }

    const attempts = delivery.attempts + 1
    const retryable = outcome.status === 0 || isRetryableStatus(outcome.status)
    if (!retryable || attempts >= endpoint.max_attempts) {
      markDead(delivery.id, outcome.status, outcome.error || 'delivery failed')
      logger.warn(
        '[event-outbox] delivery %s to %s dead after %d attempt(s): status=%d %s',
        delivery.id, endpoint.name, attempts, outcome.status, outcome.error,
      )
      return false
    }
    markRetry(delivery.id, Date.now() + nextBackoffMs(delivery.attempts), outcome.status, outcome.error)
    return false
  }
}

let dispatcher: EventOutboxDispatcher | null = null

export function getEventOutboxDispatcher(): EventOutboxDispatcher {
  if (!dispatcher) dispatcher = new EventOutboxDispatcher()
  return dispatcher
}

export function startEventOutboxDispatcher(): void {
  getEventOutboxDispatcher().start()
}

export function stopEventOutboxDispatcher(): void {
  dispatcher?.stop()
}
