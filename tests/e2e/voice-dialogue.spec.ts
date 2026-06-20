import { expect, test, type Page } from '@playwright/test'
import { authenticate, mockChatSocket, mockHermesApi, TEST_ACCESS_KEY } from './fixtures'

declare global {
  interface Window {
    __PW_FAKE_VOICE_CAPTURE__?: {
      getUserMediaCalls: number
      recorderState: string
    }
  }
}

async function waitForRun(page: Page, index = 0) {
  const handle = await page.waitForFunction((runIndex) => {
    const state = (window as any).__PW_CHAT_SOCKET__
    const runs = state?.emitted?.filter((item: any) => item.event === 'run') || []
    const run = runs[runIndex]
    return run ? run.payload : null
  }, index)
  return handle.jsonValue() as Promise<any>
}

async function installMockVoiceCapture(page: Page) {
  await page.addInitScript(() => {
    const state = {
      getUserMediaCalls: 0,
      recorderState: 'inactive',
    }

    Object.defineProperty(window, '__PW_FAKE_VOICE_CAPTURE__', {
      configurable: true,
      writable: true,
      value: state,
    })

    class FakeMediaRecorder {
      static isTypeSupported() {
        return true
      }

      stream: unknown
      mimeType: string
      state = 'inactive'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onerror: ((event: unknown) => void) | null = null
      onstop: (() => void) | null = null

      constructor(stream: unknown, options: { mimeType?: string } = {}) {
        this.stream = stream
        this.mimeType = options.mimeType || 'audio/webm'
      }

      start() {
        this.state = 'recording'
        state.recorderState = 'recording'
      }

      stop() {
        if (this.state === 'inactive') {
          return
        }

        this.state = 'inactive'
        state.recorderState = 'inactive'
        const blob = new Blob(['fake-voice-audio'], { type: this.mimeType })
        setTimeout(() => {
          if (this.ondataavailable) {
            this.ondataavailable({ data: blob })
          }
          if (this.onstop) {
            this.onstop()
          }
        }, 0)
      }
    }

    const fakeTrack = {
      kind: 'audio',
      enabled: true,
      readyState: 'live',
      stop() {},
    }

    const fakeStream = {
      active: true,
      getTracks: () => [fakeTrack],
      getAudioTracks: () => [fakeTrack],
      getVideoTracks: () => [],
    }

    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: FakeMediaRecorder,
    })
    Object.defineProperty(globalThis, 'MediaRecorder', {
      configurable: true,
      writable: true,
      value: FakeMediaRecorder,
    })

    const mediaDevices = navigator.mediaDevices || {}
    Object.defineProperty(mediaDevices, 'getUserMedia', {
      configurable: true,
      writable: true,
      value: async () => {
        state.getUserMediaCalls += 1
        return fakeStream
      },
    })
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: mediaDevices,
    })
  })
}

test('records, transcribes, stages editable text, then sends through the real chat UI', async ({ page }) => {
  await installMockVoiceCapture(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('hermes-stt-settings-v1', JSON.stringify({
      provider: 'openai',
      openaiModel: 'gpt-4o-transcribe',
      openaiLanguage: '',
      openaiPrompt: '',
      customBaseUrl: '',
      customModel: 'gpt-4o-transcribe',
      customLanguage: '',
      customPrompt: '',
    }))
  })
  await authenticate(page, TEST_ACCESS_KEY, 'research')
  const api = await mockHermesApi(page)
  await mockChatSocket(page)

  let transcriptionRequests = 0
  await page.route('**/api/hermes/stt/transcribe', async (route) => {
    transcriptionRequests += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ text: 'hello by voice', provider: 'openai' }),
    })
  })

  await page.goto('/#/hermes/chat')
  await page.evaluate(() => {
    const state = window.__PW_FAKE_VOICE_CAPTURE__
    if (!state) {
      return
    }

    const FakeMediaRecorder = window.MediaRecorder
    globalThis.MediaRecorder = FakeMediaRecorder

    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = async () => {
        state.getUserMediaCalls += 1
        const fakeMediaStream: any = {
          active: true,
          getTracks: () => [{ kind: 'audio', enabled: true, readyState: 'live', stop() {} }],
          getAudioTracks: () => [{ kind: 'audio', enabled: true, readyState: 'live', stop() {} }],
          getVideoTracks: () => [],
        }
        return fakeMediaStream
      }
    }
  })
  expect(await page.evaluate(() => window.__PW_FAKE_VOICE_CAPTURE__)).toEqual({
    getUserMediaCalls: 0,
    recorderState: 'inactive',
  })

  const toggle = page.getByTestId('voice-record-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await page.waitForFunction(() => window.__PW_FAKE_VOICE_CAPTURE__?.recorderState === 'recording')

  await toggle.click()

  await expect(page.locator('textarea')).toHaveValue('hello by voice')
  expect(transcriptionRequests).toBe(1)
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  await page.getByRole('button', { name: /send/i }).click()
  const run = await waitForRun(page)
  expect(run.input).toBe('hello by voice')
  await expect(page.locator('p').filter({ hasText: /^hello by voice$/ })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})
