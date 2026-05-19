import { describe, expect, it } from 'vitest'
import {
  gatewayStatusLooksRuntimeLocked,
  gatewayStatusLooksRunning,
} from '../../packages/server/src/services/hermes/gateway-autostart'

describe('gateway autostart status parsing', () => {
  it('treats runtime lock conflicts as an already-running gateway', () => {
    expect(gatewayStatusLooksRuntimeLocked(
      'Gateway runtime lock is already held by another instance. Exiting.',
    )).toBe(true)
  })

  it('does not treat not-running status as running', () => {
    expect(gatewayStatusLooksRunning('Gateway is not running')).toBe(false)
  })
})
