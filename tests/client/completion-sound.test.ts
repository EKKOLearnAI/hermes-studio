// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCompletionSoundForTests, playCompletionSound, primeCompletionSound } from '@/utils/completion-sound'

function installMockAudioContext(initialState: AudioContextState = 'running') {
  const oscillator = {
    type: 'sine' as OscillatorType,
    frequency: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }

  const gain = {
    gain: {
      setValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  }

  const context = {
    state: initialState,
    currentTime: 10,
    destination: {},
    resume: vi.fn(async () => {
      context.state = 'running'
    }),
    createOscillator: vi.fn(() => oscillator),
    createGain: vi.fn(() => gain),
  }

  const AudioContextMock = vi.fn(() => context)
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: AudioContextMock,
  })

  return { AudioContextMock, context, oscillator, gain }
}

describe('completion sound', () => {
  beforeEach(() => {
    __resetCompletionSoundForTests()
    vi.restoreAllMocks()
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })

  it('returns false when Web Audio is unavailable', async () => {
    await expect(playCompletionSound()).resolves.toBe(false)
  })

  it('primes a suspended audio context from user interaction', () => {
    const { context } = installMockAudioContext('suspended')

    primeCompletionSound()

    expect(context.resume).toHaveBeenCalledTimes(1)
  })

  it('plays a short tone through Web Audio', async () => {
    const { context, oscillator, gain } = installMockAudioContext('running')

    await expect(playCompletionSound()).resolves.toBe(true)

    expect(context.createOscillator).toHaveBeenCalledTimes(1)
    expect(context.createGain).toHaveBeenCalledTimes(1)
    expect(oscillator.connect).toHaveBeenCalledWith(gain)
    expect(gain.connect).toHaveBeenCalledWith(context.destination)
    expect(oscillator.start).toHaveBeenCalledWith(10)
    expect(oscillator.stop).toHaveBeenCalledWith(10.16)
  })
})
