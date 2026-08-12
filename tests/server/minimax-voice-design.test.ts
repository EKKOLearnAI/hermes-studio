import { afterEach, describe, expect, it, vi } from 'vitest'

import { minimaxTtsProvider } from '../../packages/server/src/services/hermes/tts-providers/hermes-cloud'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MiniMax voice design', () => {
  it('designs a voice on the regional endpoint before synthesis', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        voice_id: 'designed-voice-id',
        base_resp: { status_code: 0, status_msg: 'success' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { audio: Buffer.from('designed-voice').toString('hex') },
        base_resp: { status_code: 0, status_msg: 'success' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await minimaxTtsProvider.synthesize({ text: 'Preview this voice' }, {
      apiKey: 'minimax-key',
      baseUrl: 'https://api.minimaxi.com/v1/t2a_v2',
      voiceMode: 'voiceDesign',
      voiceDesignDesc: 'Warm and confident narrator',
      voice: 'requested-voice-id',
    })
    const [designUrl, designInit] = fetchMock.mock.calls[0] as [URL, RequestInit]
    const [ttsUrl, ttsInit] = fetchMock.mock.calls[1] as [URL, RequestInit]

    expect(String(designUrl)).toBe('https://api.minimaxi.com/v1/voice_design')
    expect(designInit.headers).toMatchObject({ Authorization: 'Bearer minimax-key' })
    expect(JSON.parse(String(designInit.body))).toEqual({
      prompt: 'Warm and confident narrator',
      voice_id: 'requested-voice-id',
    })
    expect(String(ttsUrl)).toBe('https://api.minimaxi.com/v1/t2a_v2')
    expect(JSON.parse(String(ttsInit.body))).toMatchObject({
      text: 'Preview this voice',
      voice_setting: { voice_id: 'designed-voice-id' },
    })
    expect(output.audio.toString()).toBe('designed-voice')
    expect(output.contentType).toBe('audio/mpeg')
  })
})
