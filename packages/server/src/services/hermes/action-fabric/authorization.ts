import { createHash } from 'crypto'
import type { FabricEnvironment, FabricJsonObject } from './types'

export interface FabricAuthorizationRequest {
  capabilityId: string
  requestedByUserId: string
  targetAtoms: readonly string[]
  executorId: string
  environment: FabricEnvironment
  input: Readonly<FabricJsonObject>
  requirements: readonly string[]
}

export interface FabricAuthorizationGrant {
  authorizationVersion: number
  expiresAt: string
  grantedRequirements: string[]
}

export interface FabricAuthorizationProvider {
  id: string
  version: number
  authorize(request: Readonly<FabricAuthorizationRequest>): FabricAuthorizationGrant | null
}

export interface FabricAuthorizationEvidence {
  providerId: string
  providerVersion: number
  authorizationVersion: number
  expiresAt: string
  digest: string
}

let provider: FabricAuthorizationProvider | null = null

export function registerFabricAuthorizationProvider(next: FabricAuthorizationProvider): void {
  if (!next || typeof next !== 'object' || typeof next.id !== 'string'
    || !/^[a-z][a-z0-9.-]{1,127}$/.test(next.id) || !Number.isSafeInteger(next.version) || next.version < 1
    || typeof next.authorize !== 'function') throw new Error('FABRIC_AUTHORIZATION_PROVIDER_INVALID')
  if (provider !== null) throw new Error('FABRIC_AUTHORIZATION_PROVIDER_EXISTS')
  provider = Object.freeze({ id: next.id, version: next.version, authorize: next.authorize })
}

export function clearFabricAuthorizationProvider(): void {
  provider = null
}

export function resolveFabricAuthorization(
  request: FabricAuthorizationRequest,
  now: string,
): FabricAuthorizationEvidence | null {
  const current = provider
  if (!current) return null
  try {
    const immutableRequest = deepFreeze(clone(request)) as Readonly<FabricAuthorizationRequest>
    const raw = current.authorize(immutableRequest)
    if (isPromiseLike(raw) || !validGrant(raw, request.requirements, now)) return null
    const material = {
      providerId: current.id, providerVersion: current.version,
      authorizationVersion: raw.authorizationVersion, expiresAt: raw.expiresAt,
      capabilityId: request.capabilityId, requestedByUserId: request.requestedByUserId,
      targetAtoms: [...request.targetAtoms], executorId: request.executorId, environment: request.environment,
      inputDigest: digest(request.input), requirements: [...request.requirements],
    }
    return Object.freeze({
      providerId: current.id, providerVersion: current.version,
      authorizationVersion: raw.authorizationVersion, expiresAt: raw.expiresAt, digest: digest(material),
    })
  } catch {
    return null
  }
}

function validGrant(value: unknown, requirements: readonly string[], now: string): value is FabricAuthorizationGrant {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const grant = value as Partial<FabricAuthorizationGrant>
  const expiry = typeof grant.expiresAt === 'string' ? Date.parse(grant.expiresAt) : Number.NaN
  if (!Number.isSafeInteger(grant.authorizationVersion) || Number(grant.authorizationVersion) < 1
    || typeof grant.expiresAt !== 'string' || grant.expiresAt.length > 64
    || !Number.isFinite(expiry) || new Date(expiry).toISOString() !== grant.expiresAt
    || expiry <= Date.parse(now)
    || !Array.isArray(grant.grantedRequirements) || grant.grantedRequirements.length > 16
    || grant.grantedRequirements.some(item => typeof item !== 'string' || item.length > 160)) return false
  return sameSet(grant.grantedRequirements, requirements)
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && right.every(item => left.includes(item))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  return JSON.stringify(value)
}

function isPromiseLike(value: unknown): boolean {
  return !!value && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function'
}
