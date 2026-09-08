import { describe, expect, it, vi } from 'vitest'
import {
  LEGACY_APP_API_PREFIXES,
  canonicalLegacyAppPath,
  canonicalLegacyAppUrl,
  legacyAppApiCompatibility,
} from '../../packages/server/src/modules/studio/middleware/legacy-app-api'

describe('legacy App API compatibility', () => {
  it('maps every released App prefix to its canonical Studio owner', () => {
    for (const [legacy, canonical] of LEGACY_APP_API_PREFIXES) {
      expect(canonicalLegacyAppPath(legacy)).toBe(canonical)
      expect(canonicalLegacyAppPath(`${legacy}/child`)).toBe(`${canonical}/child`)
    }
  })

  it('preserves query strings and handles the renamed download endpoint', () => {
    expect(canonicalLegacyAppUrl('/api/hermes/download?path=%2Ftmp%2Fa.png&profile=default'))
      .toBe('/api/studio/files/download?path=%2Ftmp%2Fa.png&profile=default')
  })

  it('keeps released MCU firmware on voice, audio, and OTA endpoints', () => {
    expect(canonicalLegacyAppPath('/api/hermes/mcu/voice-turn'))
      .toBe('/api/studio/mcu/voice-turn')
    expect(canonicalLegacyAppPath('/api/hermes/mcu/audio/token-invalid-24k.s16le.pcm'))
      .toBe('/api/studio/mcu/audio/token-invalid-24k.s16le.pcm')
    expect(canonicalLegacyAppPath('/api/hermes/mcu/firmware/v1/manifest'))
      .toBe('/api/studio/mcu/firmware/v1/manifest')
    expect(canonicalLegacyAppPath('/api/hermes/mcu/firmware.bin'))
      .toBe('/api/studio/mcu/firmware.bin')
  })

  it('does not rewrite capabilities still owned by Hermes', () => {
    for (const path of [
      '/api/hermes/jobs',
      '/api/hermes/skills',
      '/api/hermes/profiles/default',
      '/api/hermes/config/providers',
      '/api/hermes/memory',
      '/api/hermes/mcp/servers',
    ]) {
      expect(canonicalLegacyAppPath(path)).toBeNull()
    }
  })

  it('rewrites only while downstream canonical routes execute', async () => {
    const headers = new Map<string, string>()
    const ctx = {
      url: '/api/hermes/sessions?limit=20',
      get path() {
        return this.url.split('?')[0]
      },
      set(name: string, value: string) {
        headers.set(name, value)
      },
    }
    const next = vi.fn(async () => {
      expect(ctx.url).toBe('/api/studio/sessions?limit=20')
    })

    await legacyAppApiCompatibility(ctx as never, next)

    expect(next).toHaveBeenCalledOnce()
    expect(ctx.url).toBe('/api/hermes/sessions?limit=20')
    expect(headers.get('Deprecation')).toBe('true')
    expect(headers.get('X-Hermes-Studio-Canonical-Path')).toBe('/api/studio/sessions')
  })
})
