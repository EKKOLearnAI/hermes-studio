import { describe, expect, it } from 'vitest'
import {
  getStaticCacheControl,
  IMMUTABLE_ASSET_CACHE_CONTROL,
  SPA_ENTRY_CACHE_CONTROL,
} from '../../packages/server/src/middleware/static-cache'

describe('static cache headers', () => {
  it('caches fingerprinted build assets as immutable', () => {
    expect(getStaticCacheControl('assets/js/index-abc123.js')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL)
    expect(getStaticCacheControl('assets\\css\\index-abc123.css')).toBe(IMMUTABLE_ASSET_CACHE_CONTROL)
  })

  it('revalidates the SPA entry and leaves public assets unchanged', () => {
    expect(getStaticCacheControl('index.html')).toBe(SPA_ENTRY_CACHE_CONTROL)
    expect(getStaticCacheControl('logo.png')).toBeNull()
  })
})
