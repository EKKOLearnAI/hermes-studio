import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DESKTOP_NODE_VERSION,
  desktopNodeVersion,
} from '../../packages/desktop/scripts/node-runtime-config.mjs'

describe('desktop runtime Node.js configuration', () => {
  it('uses a pinned runtime version instead of inheriting the build runner version', () => {
    expect(desktopNodeVersion({
      NODE_VERSION: '24.18.0',
    })).toBe(DEFAULT_DESKTOP_NODE_VERSION)
    expect(DEFAULT_DESKTOP_NODE_VERSION).toBe('22.22.0')
  })

  it('accepts an explicit exact version override', () => {
    expect(desktopNodeVersion({
      HERMES_DESKTOP_NODE_VERSION: 'v22.22.1',
    })).toBe('22.22.1')
  })

  it('rejects non-exact version selectors', () => {
    expect(() => desktopNodeVersion({
      HERMES_DESKTOP_NODE_VERSION: '22',
    })).toThrow(/exact Node\.js version/)
  })
})
