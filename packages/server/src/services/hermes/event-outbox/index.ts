/**
 * Publishing side of the outbound event outbox.
 *
 * `publishEvent` is what feature code calls. It never throws into the caller
 * and never blocks: a broken outbox must not be able to fail a chat run.
 */

import { logger } from '../../logger'
import {
  appendEvent,
  countPendingDeliveries,
  listEndpoints,
  type AppendEventResult,
} from '../../../db/hermes/event-outbox-store'
import {
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  type EventSubject,
  type EventSummary,
  type EventType,
} from './envelope'

export * from './envelope'

export interface PublishEventInput {
  type: EventType
  /**
   * Stable across retries of the same real-world occurrence. Callers build it
   * from identifiers they already have, never from a timestamp.
   */
  dedupeKey: string
  profile?: string
  source?: string
  subject?: EventSubject
  summary?: EventSummary
  occurredAt?: number
}

export function publishEvent(input: PublishEventInput): AppendEventResult | null {
  try {
    return appendEvent({
      type: input.type,
      dedupeKey: input.dedupeKey,
      profile: input.profile || 'default',
      source: input.source || '',
      subject: input.subject || {},
      summary: input.summary || {},
      occurredAt: input.occurredAt,
      schemaVersion: EVENT_SCHEMA_VERSION,
    })
  } catch (error) {
    logger.warn(error, '[event-outbox] failed to record %s', input.type)
    return null
  }
}

export interface EventOutboxCapability {
  enabled: boolean
  schema_version: number
  event_types: readonly string[]
  endpoint_count: number
  pending_deliveries: number
}

/**
 * What a client needs to know before offering webhook features in its UI.
 * `enabled` reports whether any endpoint is configured — the outbox sends
 * nothing until the user adds one.
 */
export function getEventOutboxCapability(): EventOutboxCapability {
  let endpoints = 0
  let pending = 0
  try {
    endpoints = listEndpoints().length
    pending = countPendingDeliveries()
  } catch {
    endpoints = 0
    pending = 0
  }
  return {
    enabled: endpoints > 0,
    schema_version: EVENT_SCHEMA_VERSION,
    event_types: EVENT_TYPES,
    endpoint_count: endpoints,
    pending_deliveries: pending,
  }
}
