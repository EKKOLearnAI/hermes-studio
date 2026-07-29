import { Readable } from 'stream'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalHermesHome = process.env.HERMES_HOME
let db: any = null
let hermesHome = ''

beforeEach(async () => {
  vi.resetModules()
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-studio-voice-proxy-'))
  process.env.HERMES_HOME = hermesHome
  await writeFile(join(hermesHome, 'config.yaml'), '{}\n', 'utf-8')

  const { DatabaseSync } = await import('node:sqlite')
  db = new DatabaseSync(':memory:')
  vi.doMock('../../packages/server/src/db/index', () => ({
    getDb: () => db,
    getStoragePath: () => ':memory:',
  }))
  const schemas = await import('../../packages/server/src/db/hermes/schemas')
  schemas.initAllHermesTables()
})

afterEach(async () => {
  db?.close()
  db = null
  vi.doUnmock('../../packages/server/src/db/index')
  vi.doUnmock('../../packages/server/src/services/hermes/tts-providers')
  vi.doUnmock('../../packages/server/src/services/hermes/stt-providers')
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await rm(hermesHome, { recursive: true, force: true })
})

function ttsCtx(profile: string, text: string) {
  const headers: Record<string, string> = {}
  return {
    request: { body: text },
    params: { profile },
    req: { on: vi.fn() },
    res: { writableEnded: false, on: vi.fn() },
    status: 200,
    body: null,
    set: vi.fn((name: string, value: string) => { headers[name] = value }),
    headers,
  } as any
}

function multipartBody(boundary: string): Buffer {
  return Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    '',
    'hermes-studio',
    `--${boundary}`,
    'Content-Disposition: form-data; name="response_format"',
    '',
    'text',
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="voice.wav"',
    'Content-Type: audio/wav',
    '',
    'audio-bytes',
    `--${boundary}--`,
    '',
  ].join('\r\n'))
}

describe('Hermes Studio voice proxy controllers', () => {
  it('routes Hermes TTS through the active Web UI provider for the URL profile', async () => {
    const synthesize = vi.fn(async () => ({
      audio: Buffer.from('mp3-data'),
      contentType: 'audio/mpeg',
      engine: 'edge',
      provider: 'edge',
    }))
    vi.doMock('../../packages/server/src/services/hermes/tts-providers', () => ({
      getTtsProvider: (provider: string) => provider === 'edge' ? { id: 'edge', synthesize } : undefined,
    }))

    const store = await import('../../packages/server/src/db/hermes/tts-settings-store')
    store.saveTtsProviderSetting('default', 'edge', {
      settings: { voice: 'zh-CN-YunjianNeural', rate: 1 },
    })
    store.saveActiveTtsProvider('default', 'edge')

    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const ctx = ttsCtx('default', '你好，Hermes Studio')
    await ctrl.synthesizeVoiceProxy(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toEqual(Buffer.from('mp3-data'))
    expect(ctx.headers['Content-Type']).toBe('audio/mpeg')
    expect(ctx.headers['X-TTS-Engine']).toBe('hermes-studio')
    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ text: '你好，Hermes Studio' }),
      expect.objectContaining({
        voice: 'zh-CN-YunjianNeural',
        rate: '1',
        format: 'mp3',
      }),
    )
  })

  it('routes Hermes STT through the active Web UI provider and returns command text output', async () => {
    const transcribeWithProvider = vi.fn(async () => ({
      text: '代理转写结果',
      provider: 'custom',
      model: 'whisper-large-v3',
      durationMs: 12,
    }))
    class SttProviderConfigError extends Error {}
    vi.doMock('../../packages/server/src/services/hermes/stt-providers', () => ({
      SttProviderConfigError,
      transcribeWithProvider,
    }))

    const store = await import('../../packages/server/src/db/hermes/stt-settings-store')
    store.saveSttProviderSetting('default', 'custom', {
      settings: {
        baseUrl: 'https://stt.example/v1/audio/transcriptions',
        model: 'whisper-large-v3',
      },
      secrets: { apiKey: 'upstream-secret' },
    })
    store.saveActiveSttProvider('default', 'custom')

    const boundary = 'voice-proxy-boundary'
    const ctrl = await import('../../packages/server/src/controllers/hermes/stt')
    const ctx = {
      request: {},
      params: { profile: 'default' },
      req: Readable.from([multipartBody(boundary)]),
      res: { writableEnded: false, on: vi.fn() },
      status: 200,
      body: null,
      set: vi.fn(),
      get: vi.fn((name: string) => name.toLowerCase() === 'content-type'
        ? `multipart/form-data; boundary=${boundary}`
        : ''),
    } as any

    await ctrl.transcribeVoiceProxy(ctx)

    expect(ctx.status).toBe(200)
    expect(ctx.body).toBe('代理转写结果')
    expect(ctx.set).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8')
    expect(transcribeWithProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'custom',
      audio: Buffer.from('audio-bytes'),
      fileName: 'voice.wav',
      mimeType: 'audio/wav',
      settings: expect.objectContaining({ model: 'whisper-large-v3' }),
      secrets: { apiKey: 'upstream-secret' },
    }))
  })

  it('rejects a profile that is not present in Hermes', async () => {
    const ctrl = await import('../../packages/server/src/controllers/hermes/tts')
    const ctx = ttsCtx('missing-profile', 'hello')

    await ctrl.synthesizeVoiceProxy(ctx)

    expect(ctx.status).toBe(404)
    expect(ctx.body).toEqual({ error: 'unknown Hermes profile' })
  })
})
