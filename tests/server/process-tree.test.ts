import { describe, expect, it, vi } from 'vitest'
import { killOwnedProcessTree } from '../../packages/server/src/modules/studio/public/process-tree'

describe('owned process tree cleanup', () => {
  it('uses synchronous Windows tree termination instead of killing only the root', () => {
    const taskkill = vi.fn()
    const fallback = vi.fn()

    killOwnedProcessTree(4321, fallback, { platform: 'win32', taskkill })

    expect(taskkill).toHaveBeenCalledWith(4321)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('falls back to the native child kill when Windows tree termination fails', () => {
    const taskkill = vi.fn(() => { throw new Error('taskkill failed') })
    const fallback = vi.fn()

    killOwnedProcessTree(4321, fallback, { platform: 'win32', taskkill })

    expect(fallback).toHaveBeenCalledOnce()
  })

  it('preserves the existing signal behavior outside Windows', () => {
    const taskkill = vi.fn()
    const fallback = vi.fn()

    killOwnedProcessTree(4321, fallback, { platform: 'linux', taskkill })

    expect(taskkill).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledOnce()
  })
})
