import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateClientUuid } from '../../packages/client/src/utils/client-random'

describe('client random UUID generation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses crypto.randomUUID when it is available', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555')
    vi.stubGlobal('crypto', { randomUUID })

    expect(generateClientUuid()).toBe('11111111-2222-4333-8444-555555555555')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('generates a version 4 UUID when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set(Array.from({ length: 16 }, (_, index) => index))
        return bytes
      },
    })

    expect(generateClientUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  it('generates a version 4 UUID when randomUUID exists but is not callable', () => {
    vi.stubGlobal('crypto', {
      randomUUID: undefined,
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xff)
        return bytes
      },
    })

    expect(generateClientUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })
})
