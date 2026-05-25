import { describe, expect, it } from 'vitest'
import { normalizeLegacyRoutePath } from '@/router/legacy-routing'

describe('normalizeLegacyRoutePath', () => {
  it('maps legacy chat routes to the canonical session creation route', () => {
    expect(normalizeLegacyRoutePath('/hermes/chat')).toBe('/session/new')
    expect(normalizeLegacyRoutePath('#/hermes/chat')).toBe('/session/new')
  })

  it('maps legacy session routes to canonical session URLs while preserving query params', () => {
    expect(normalizeLegacyRoutePath('/hermes/session/session-123')).toBe('/session/session-123')
    expect(normalizeLegacyRoutePath('#/hermes/session/session-123?profile=alpha')).toBe('/session/session-123?profile=alpha')
  })

  it('drops the legacy hermes prefix for other routes', () => {
    expect(normalizeLegacyRoutePath('/hermes/history')).toBe('/history')
    expect(normalizeLegacyRoutePath('/hermes/updates?tab=latest')).toBe('/updates?tab=latest')
  })

  it('returns null for non-legacy paths', () => {
    expect(normalizeLegacyRoutePath('/session/new')).toBeNull()
    expect(normalizeLegacyRoutePath('')).toBeNull()
  })
})
