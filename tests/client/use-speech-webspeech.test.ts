// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

import { useSpeech } from '@/composables/useSpeech'

class MockSpeechSynthesisUtterance {
  text: string
  rate = 1
  pitch = 1
  volume = 1
  voice: SpeechSynthesisVoice | null = null
  lang = ''
  onboundary: ((event: SpeechSynthesisEvent) => void) | null = null
  onend: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(text: string) {
    this.text = text
  }
}

describe('useSpeech WebSpeech playback', () => {
  beforeEach(() => {
    const voice = {
      name: 'Google US English',
      lang: 'en-US',
      default: false,
      localService: false,
      voiceURI: 'Google US English',
    } satisfies SpeechSynthesisVoice

    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getVoices: vi.fn(() => [voice]),
      speak: vi.fn(function (this: SpeechSynthesis) {
        this.speaking = true
        this.paused = false
      }),
      cancel: vi.fn(function (this: SpeechSynthesis) {
        this.speaking = false
        this.pending = false
        this.paused = false
      }),
      pause: vi.fn(function (this: SpeechSynthesis) {
        this.speaking = false
        this.paused = true
      }),
      resume: vi.fn(function (this: SpeechSynthesis) {
        this.speaking = true
        this.paused = false
      }),
    } as unknown as SpeechSynthesis

    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: synth,
    })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: MockSpeechSynthesisUtterance,
    })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: MockSpeechSynthesisUtterance,
    })
  })

  it('pauses and resumes the current browser voice instead of restarting it', () => {
    const wrapper = mount(defineComponent({
      setup() {
        return {
          speech: useSpeech(),
        }
      },
      template: '<div />',
    }))
    const speech = wrapper.vm.speech
    const synth = vi.mocked(window.speechSynthesis)

    speech.toggleBrowser('message-1', 'Hello world', {
      voiceName: 'Google US English',
    })

    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(speech.isPlaying.value).toBe(true)
    expect(speech.isPaused.value).toBe(false)

    speech.toggleBrowser('message-1', 'Hello world', {
      voiceName: 'Google US English',
    })

    expect(synth.pause).toHaveBeenCalledTimes(1)
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(speech.isPlaying.value).toBe(true)
    expect(speech.isPaused.value).toBe(true)

    speech.toggleBrowser('message-1', 'Hello world', {
      voiceName: 'Google US English',
    })

    expect(synth.resume).toHaveBeenCalledTimes(1)
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(speech.isPaused.value).toBe(false)

    wrapper.unmount()
  })

  it('preserves semantic symbols while filtering speech noise', () => {
    const speech = useSpeech()

    expect(speech.extractReadableText(
      '跌幅 -3%，反弹 +8.3%，09:30 开盘，日期 2026-09-03，比例 3:1，区间 5~6，A/B = 0.5。🙂 # *',
    )).toBe(
      '跌幅 -3%，反弹 +8.3%，09:30 开盘，日期 2026-09-03，比例 3:1，区间 5~6，A/B = 0.5。',
    )
  })

  it('keeps collapsed thinking blocks out of speech text', () => {
    const speech = useSpeech()

    expect(speech.extractReadableText(
      '<think>hidden plan</think>Visible answer. '
      + '<thinking>legacy hidden plan</thinking>More detail. '
      + '<reasoning>hidden rationale</reasoning>Done.',
    )).toBe('Visible answer. More detail. Done.')
  })

  it('does not crash when Web Speech is unavailable', () => {
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: undefined,
    })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: undefined,
    })

    const wrapper = mount(defineComponent({
      setup() {
        return {
          speech: useSpeech(),
        }
      },
      template: '<div />',
    }))
    const speech = wrapper.vm.speech

    expect(speech.isSupported.value).toBe(false)
    expect(() => speech.toggleBrowser('message-unsupported', 'Hello world')).not.toThrow()
    expect(speech.isPlaying.value).toBe(false)

    expect(() => wrapper.unmount()).not.toThrow()
  })

  it('does not crash when speechSynthesis listener methods are missing', () => {
    const synth = {
      speaking: false,
      pending: false,
      paused: false,
      getVoices: vi.fn(() => []),
      speak: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    } as unknown as SpeechSynthesis

    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: synth,
    })

    const wrapper = mount(defineComponent({
      setup() {
        return {
          speech: useSpeech(),
        }
      },
      template: '<div />',
    }))
    const speech = wrapper.vm.speech

    expect(speech.isSupported.value).toBe(true)
    expect(speech.availableVoices.value).toEqual([])

    expect(() => wrapper.unmount()).not.toThrow()
  })
})
