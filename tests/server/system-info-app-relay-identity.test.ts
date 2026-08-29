import { describe, expect, it } from 'vitest'
import { shouldUseDedicatedAppRelayIdentity } from '../../packages/server/src/bootstrap/system-info'

describe('App Relay device identity scope', () => {
  it('keeps legacy production identities and isolates development Web hosts', () => {
    expect(shouldUseDedicatedAppRelayIdentity({ NODE_ENV: 'production' })).toBe(false)
    expect(shouldUseDedicatedAppRelayIdentity({ NODE_ENV: 'development' })).toBe(true)
    expect(shouldUseDedicatedAppRelayIdentity({ NODE_ENV: 'test' })).toBe(true)
  })
})
