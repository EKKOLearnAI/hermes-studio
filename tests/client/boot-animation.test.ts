import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import {
  BOOT_ANIMATION_MIN_DURATION_MS,
  getBootAnimationDelay,
} from '../../packages/client/src/utils/boot-animation'

describe('boot animation', () => {
  it('keeps one complete shimmer cycle visible on fast app hosts', () => {
    expect(BOOT_ANIMATION_MIN_DURATION_MS).toBe(1_800)
    expect(getBootAnimationDelay(100, 600)).toBe(1_300)
  })

  it('does not delay a launch after the shimmer cycle has elapsed', () => {
    expect(getBootAnimationDelay(100, 2_000)).toBe(0)
    expect(getBootAnimationDelay(undefined, 500)).toBe(0)
  })

  it('records the HTML fallback start and waits before Vue replaces it', () => {
    const html = readFileSync('packages/client/index.html', 'utf8')
    const main = readFileSync('packages/client/src/main.ts', 'utf8')

    expect(html).toContain('window.__HERMES_BOOT_ANIMATION_STARTED_AT__ = performance.now()')
    expect(main).toContain('await waitForBootAnimation()')
    expect(main.indexOf('await waitForBootAnimation()')).toBeLessThan(main.indexOf("app.mount('#app')"))
  })
})
