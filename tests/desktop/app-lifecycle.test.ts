import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopAppLifecycle } from '../../packages/desktop/src/main/app-lifecycle'

function host() {
  return {
    quit: vi.fn(),
    relaunch: vi.fn(),
    exit: vi.fn(),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('desktop app lifecycle', () => {
  it('registers a relaunch only after graceful shutdown finishes', () => {
    vi.useFakeTimers()
    const app = host()
    const lifecycle = createDesktopAppLifecycle(app)

    expect(lifecycle.scheduleRestart(100)).toBe(true)
    vi.advanceTimersByTime(100)

    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.relaunch).not.toHaveBeenCalled()

    lifecycle.prepareShutdown()
    expect(lifecycle.finalizeExit()).toBe(true)

    expect(app.relaunch).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('lets a tray quit cancel a restart before its delay elapses', () => {
    vi.useFakeTimers()
    const app = host()
    const lifecycle = createDesktopAppLifecycle(app)

    lifecycle.scheduleRestart(100)
    lifecycle.quit()
    vi.advanceTimersByTime(100)
    lifecycle.finalizeExit()

    expect(app.quit).toHaveBeenCalledOnce()
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('lets a tray quit override a restart while shutdown is in progress', () => {
    vi.useFakeTimers()
    const app = host()
    const lifecycle = createDesktopAppLifecycle(app)

    lifecycle.scheduleRestart(100)
    vi.advanceTimersByTime(100)
    expect(lifecycle.isQuitting).toBe(true)

    lifecycle.quit()
    lifecycle.prepareShutdown()
    lifecycle.finalizeExit()

    expect(app.quit).toHaveBeenCalledTimes(2)
    expect(app.relaunch).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledWith(0)
  })

  it('finalizes only once when Electron emits overlapping quit events', () => {
    vi.useFakeTimers()
    const app = host()
    const lifecycle = createDesktopAppLifecycle(app)

    lifecycle.scheduleRestart(0)
    vi.runAllTimers()

    expect(lifecycle.finalizeExit()).toBe(true)
    expect(lifecycle.finalizeExit()).toBe(false)
    expect(app.relaunch).toHaveBeenCalledOnce()
    expect(app.exit).toHaveBeenCalledOnce()
    expect(app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(app.exit.mock.invocationCallOrder[0])
  })
})
