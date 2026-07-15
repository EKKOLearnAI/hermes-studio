import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ANDROID_COMPANION_MESSAGE_TYPES,
  ANDROID_FABRIC_CAPABILITIES,
} from '../../packages/server/src/services/hermes/android-companion'

describe('Android companion authority boundary', () => {
  it('exposes only semantic encrypted message and capability contracts', () => {
    const messages = JSON.stringify(ANDROID_COMPANION_MESSAGE_TYPES)
    expect(messages).not.toMatch(/terminal|file|shell|tap|coordinate|selector|script|url|intent\.raw/i)
    expect(ANDROID_FABRIC_CAPABILITIES.map(item => item.id)).toEqual([
      'android.app.launch', 'android.screen.capture',
    ])
    for (const capability of ANDROID_FABRIC_CAPABILITIES) {
      const properties = Object.keys((capability.inputSchema.properties ?? {}) as Record<string, unknown>)
      expect(properties).not.toEqual(expect.arrayContaining([
        'command', 'commandLine', 'coordinate', 'selector', 'accessibilityNode', 'script', 'url', 'intent',
      ]))
      expect(capability.inputSchema.additionalProperties).toBe(false)
    }
  })

  it('keeps generic LAN peers and Android execution on separate sockets and service graphs', () => {
    const companion = readFileSync('packages/server/src/services/hermes/android-companion/gateway.ts', 'utf8')
    const peer = readFileSync('packages/server/src/services/lan-peer-socket.ts', 'utf8')
    expect(companion).toContain("'/api/hermes/android-companion/session'")
    expect(peer).toContain("'/api/devices/peer-socket'")
    expect(companion).not.toMatch(/from ['"].*lan-peer/)
    expect(peer).not.toMatch(/from ['"].*android-companion/)
    expect(companion).not.toMatch(/terminal\.|file\.|execRemote|upload|download/)
  })

  it('preserves the existing Devices route as a separate compatibility surface', () => {
    const router = readFileSync('packages/client/src/router/index.ts', 'utf8')
    expect(router).toContain("path: '/hermes/devices'")
    expect(router).toContain("import('@/views/hermes/DevicesView.vue')")
    expect(router).toContain("path: '/hermes/personal-os/android-companion'")
  })
})
