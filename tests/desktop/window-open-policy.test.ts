import { describe, expect, it } from 'vitest'
import { isTrustedDesktopAppUrl } from '../../packages/desktop/src/main/window-open-policy'

describe('desktop window-open policy', () => {
  it('allows only the exact running Web UI origin as an internal window', () => {
    const webUiUrl = 'http://127.0.0.1:8748'

    expect(isTrustedDesktopAppUrl('http://127.0.0.1:8748/#/hermes/chat', webUiUrl)).toBe(true)
    expect(isTrustedDesktopAppUrl('blob:http://127.0.0.1:8748/preview-id', webUiUrl)).toBe(false)
    expect(isTrustedDesktopAppUrl('http://127.0.0.1:3000/', webUiUrl)).toBe(false)
    expect(isTrustedDesktopAppUrl('http://localhost:8748/', webUiUrl)).toBe(false)
    expect(isTrustedDesktopAppUrl('http://127.0.0.1:8748.attacker.example/', webUiUrl)).toBe(false)
    expect(isTrustedDesktopAppUrl('http://localhost.attacker.example/', webUiUrl)).toBe(false)
    expect(isTrustedDesktopAppUrl('not a URL', webUiUrl)).toBe(false)
  })
})
