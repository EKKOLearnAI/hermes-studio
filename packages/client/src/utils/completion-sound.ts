type AudioContextConstructor = typeof AudioContext

type WindowWithWebkitAudio = Window & typeof globalThis & {
  webkitAudioContext?: AudioContextConstructor
}

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null

  const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudio).webkitAudioContext
  if (!AudioContextCtor) return null

  if (!audioContext) {
    audioContext = new AudioContextCtor()
  }

  return audioContext
}

export function primeCompletionSound(): void {
  const ctx = getAudioContext()
  if (!ctx || ctx.state !== 'suspended') return

  void ctx.resume().catch(() => {
    // Browser autoplay policy may still reject until a user gesture. Ignore; the
    // next send action will try again.
  })
}

export async function playCompletionSound(): Promise<boolean> {
  const ctx = getAudioContext()
  if (!ctx) return false

  try {
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    const now = ctx.currentTime
    const duration = 0.16
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, now)
    oscillator.frequency.exponentialRampToValueAtTime(660, now + duration)

    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(now)
    oscillator.stop(now + duration)

    return true
  } catch (err) {
    console.warn('Failed to play completion sound:', err)
    return false
  }
}

export function __resetCompletionSoundForTests(): void {
  audioContext = null
}
