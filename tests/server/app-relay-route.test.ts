import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readAppConfig, writeAppConfig } = vi.hoisted(() => ({
  readAppConfig: vi.fn(),
  writeAppConfig: vi.fn(),
}))

vi.mock('../../packages/server/src/modules/studio/services/config/app-config', () => ({
  readAppConfig,
  writeAppConfig,
}))

describe('App Relay route configuration', () => {
  beforeEach(() => {
    readAppConfig.mockReset()
    writeAppConfig.mockReset()
    readAppConfig.mockResolvedValue({})
    writeAppConfig.mockResolvedValue({})
  })

  it('defaults old configs to the official route', async () => {
    const { getAppRelayRoute, appRelayUrlForRoute } = await import(
      '../../packages/server/src/modules/studio/services/app-relay/route'
    )

    expect(await getAppRelayRoute()).toBe('official')
    expect(appRelayUrlForRoute('official')).toBe('https://api.hermes-studio.ai')
  })

  it('persists and maps the Cloudflare route', async () => {
    const { setAppRelayRoute, appRelayUrlForRoute } = await import(
      '../../packages/server/src/modules/studio/services/app-relay/route'
    )

    await setAppRelayRoute('cloudflare')
    expect(writeAppConfig).toHaveBeenCalledWith({ appRelayRoute: 'cloudflare' })
    expect(appRelayUrlForRoute('cloudflare')).toBe('https://cn.hermes-studio.ai')
  })
})
