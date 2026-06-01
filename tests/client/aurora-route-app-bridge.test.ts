import { describe, expect, it } from 'vitest'
import {
  AURORA_LEGACY_ROUTE_APP_MAP,
  AURORA_RETIRED_LEGACY_ROUTES,
  getAuroraAppKindForLegacyRoute,
  isAuroraAppKind,
} from '@/services/hermes/aurora/route-app-bridge'

describe('Aurora legacy route bridge', () => {
  it('maps direct legacy workbench routes into Aurora App Mode kinds', () => {
    expect(getAuroraAppKindForLegacyRoute('/hermes/models')).toBe('models')
    expect(getAuroraAppKindForLegacyRoute('/hermes/jobs')).toBe('jobs')
    expect(getAuroraAppKindForLegacyRoute('/hermes/quant-lab')).toBe('quant-lab')
    expect(getAuroraAppKindForLegacyRoute('/hermes/life-os')).toBe('life-os')
    expect(getAuroraAppKindForLegacyRoute('/hermes/chat')).toBeNull()

    for (const appKind of Object.values(AURORA_LEGACY_ROUTE_APP_MAP)) {
      expect(isAuroraAppKind(appKind)).toBe(true)
    }
  })

  it('keeps terminal as a retired legacy surface instead of an App Mode target', () => {
    expect(AURORA_RETIRED_LEGACY_ROUTES.has('/hermes/terminal')).toBe(true)
    expect(getAuroraAppKindForLegacyRoute('/hermes/terminal')).toBeNull()
  })

  it('accepts native Aurora app query kinds beyond legacy route mappings', () => {
    expect(isAuroraAppKind('mirofish')).toBe(true)
    expect(isAuroraAppKind('browser')).toBe(true)
    expect(isAuroraAppKind('terminal')).toBe(false)
  })
})
