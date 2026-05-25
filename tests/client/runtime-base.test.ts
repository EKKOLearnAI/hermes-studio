import { describe, expect, it } from 'vitest'
import { resolveRouterBase } from '../../packages/client/src/router/runtime-base'

describe('resolveRouterBase', () => {
  it('defaults to the root base for normal app routes', () => {
    expect(resolveRouterBase('/hermes/chat')).toBe('/')
    expect(resolveRouterBase('/session/123')).toBe('/')
  })

  it('derives the preview base from nested preview URLs', () => {
    expect(resolveRouterBase('/preview/abc123/')).toBe('/preview/abc123/')
    expect(resolveRouterBase('/preview/abc123/hermes/chat')).toBe('/preview/abc123/')
  })
})
