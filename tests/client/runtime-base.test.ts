import { describe, expect, it } from 'vitest'
import { resolveRouterBase } from '../../packages/client/src/router/runtime-base'

describe('resolveRouterBase', () => {
  it('defaults to the root base for normal app routes', () => {
    expect(resolveRouterBase('/hermes/chat')).toBe('/')
    expect(resolveRouterBase('/session/123')).toBe('/')
  })

  it('uses the singleton preview base for any preview URL', () => {
    expect(resolveRouterBase('/preview/')).toBe('/preview/')
    expect(resolveRouterBase('/preview/hermes/chat')).toBe('/preview/')
    expect(resolveRouterBase('/preview/preview-123/hermes/chat')).toBe('/preview/')
  })
})
