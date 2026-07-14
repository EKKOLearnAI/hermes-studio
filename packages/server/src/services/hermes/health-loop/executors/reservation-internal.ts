import type { HealthProcessingManifest } from '../consent'

export interface HealthReservationBinding {
  reservationId: string
  artifactId: string
  artifactManifestDigest: string
  processorId: string
  manifest: HealthProcessingManifest
}
export interface HealthReservationAuthorization { readonly kind: 'health-reservation-authorization' }
export const AUTHORIZED_AUXILIARY_ANALYZE: unique symbol = Symbol('authorized-health-analysis')
type ReservationConsumer = (reservationId: string, binding: {
  artifactId: string; artifactManifestDigest: string; processorId: string
}) => Promise<{ reservationId: string; consumedAt: string; authorization: HealthReservationAuthorization }>
const reservationConsumers = new WeakMap<object, ReservationConsumer>()

export function registerHealthReservationConsumer(owner: object, consumer: ReservationConsumer): void {
  reservationConsumers.set(owner, consumer)
}
export function consumeHealthReservation(owner: object, reservationId: string,
  binding: Parameters<ReservationConsumer>[1]): ReturnType<ReservationConsumer> {
  const consumer = reservationConsumers.get(owner)
  if (!consumer) return Promise.reject(new Error('HEALTH_CONSENT_RESERVATION_CONSUMER_UNAVAILABLE'))
  return consumer(reservationId, binding)
}

const authorizations = new WeakMap<object, HealthReservationBinding>()

/** Internal minting hook: intentionally not exported from any barrel. */
export function mintHealthReservationAuthorization(binding: HealthReservationBinding): HealthReservationAuthorization {
  const authorization = Object.freeze({ kind: 'health-reservation-authorization' as const })
  authorizations.set(authorization, structuredClone(binding))
  return authorization
}

/** Internal verification hook used by the authorized analyzer path. */
export function readHealthReservationAuthorization(value: unknown): HealthReservationBinding | null {
  if (!value || typeof value !== 'object') return null
  const binding = authorizations.get(value)
  return binding ? structuredClone(binding) : null
}
