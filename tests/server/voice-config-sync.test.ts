import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import YAML from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME
const originalAuthToken = process.env.AUTH_TOKEN
let db: any = null
let hermesHome = ''
let webUiHome = ''

beforeEach(async () => {
  vi.resetModules()
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-voice-sync-'))
  webUiHome = join(hermesHome, 'web-ui')
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = webUiHome
  process.env.AUTH_TOKEN = 'studio-server-token'
  await mkdir(hermesHome, { recursive: true })
  await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: keep/model\n', 'utf-8')
  await writeFile(join(hermesHome, '.env'), 'KEEP_SECRET=keep\n', 'utf-8')

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
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
  if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN
  else process.env.AUTH_TOKEN = originalAuthToken
  await rm(hermesHome, { recursive: true, force: true })
})

async function readConfig(): Promise<Record<string, any>> {
  return YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as Record<string, any>
}

describe('Hermes voice config sync', () => {
  it('registers one Hermes Studio provider while keeping upstream settings and secrets in Web UI storage', async () => {
    const sttStore = await import('../../packages/server/src/db/hermes/stt-settings-store')
    const ttsStore = await import('../../packages/server/src/db/hermes/tts-settings-store')
    sttStore.saveSttProviderSetting('default', 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
        language: 'zh',
        prompt: 'Studio-only prompt remains in the database',
      },
      secrets: { apiKey: 'stt-secret' },
    })
    sttStore.saveActiveSttProvider('default', 'openai')
    ttsStore.saveTtsProviderSetting('default', 'custom', {
      settings: {
        baseUrl: 'https://voice.example/v1/audio/speech',
        model: 'custom-tts',
        voice: 'nova',
        rate: 1.25,
        pitch: 4,
      },
      secrets: { apiKey: 'tts-secret' },
    })
    ttsStore.saveActiveTtsProvider('default', 'custom')

    const { syncVoiceConfigToHermesProfile } = await import('../../packages/server/src/services/hermes/voice-config-sync')
    await expect(syncVoiceConfigToHermesProfile('default')).resolves.toEqual({
      stt: 'hermes-studio',
      tts: 'hermes-studio',
    })

    const config = await readConfig()
    expect(config.model).toEqual({ default: 'keep/model' })
    expect(config.stt.provider).toBe('hermes-studio')
    expect(config.tts.provider).toBe('hermes-studio')
    expect(config.stt.providers['hermes-studio']).toMatchObject({
      type: 'command',
      output_format: 'txt',
    })
    expect(config.tts.providers['hermes-studio']).toMatchObject({
      type: 'command',
      output_format: 'mp3',
      voice_compatible: true,
    })
    expect(config.stt.providers['hermes-studio'].command).toContain(
      '/api/hermes/voice/proxy/default/v1/audio/transcriptions',
    )
    expect(config.tts.providers['hermes-studio'].command).toContain(
      '/api/hermes/voice/proxy/default/v1/tts',
    )
    expect(JSON.stringify(config)).not.toContain('stt-secret')
    expect(JSON.stringify(config)).not.toContain('tts-secret')
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toBe('KEEP_SECRET=keep\n')

    const curlConfig = await readFile(join(webUiHome, 'runtime', 'hermes-studio-voice.curlrc'), 'utf-8')
    expect(curlConfig).toContain('Authorization: Bearer studio-server-token')
    expect(curlConfig).not.toContain('stt-secret')
    expect(curlConfig).not.toContain('tts-secret')
  })

  it('maps browser STT to Hermes local and preserves provider-specific config', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'stt:',
      '  provider: openai',
      '  local:',
      '    model: small',
      'tts:',
      '  provider: openai',
      '  edge:',
      '    voice: old-voice',
      '',
    ].join('\n'), 'utf-8')

    const sttStore = await import('../../packages/server/src/db/hermes/stt-settings-store')
    const ttsStore = await import('../../packages/server/src/db/hermes/tts-settings-store')
    sttStore.saveActiveSttProvider('default', 'browser')
    ttsStore.saveTtsProviderSetting('default', 'edge', {
      settings: { voice: 'zh-CN-XiaoxiaoNeural', rate: 1.1 },
    })
    ttsStore.saveActiveTtsProvider('default', 'edge')

    const { syncVoiceConfigToHermesProfile } = await import('../../packages/server/src/services/hermes/voice-config-sync')
    await syncVoiceConfigToHermesProfile('default')

    const config = await readConfig()
    expect(config.stt).toEqual({
      provider: 'local',
      local: { model: 'small' },
    })
    expect(config.tts.provider).toBe('hermes-studio')
    expect(config.tts.edge).toEqual({ voice: 'old-voice' })
    expect(config.tts.providers['hermes-studio'].output_format).toBe('mp3')
  })

  it('hides Groq and MiMo behind the same Hermes Studio provider', async () => {
    const sttStore = await import('../../packages/server/src/db/hermes/stt-settings-store')
    const ttsStore = await import('../../packages/server/src/db/hermes/tts-settings-store')
    sttStore.saveSttProviderSetting('default', 'custom', {
      settings: {
        baseUrl: 'https://api.groq.com/openai/v1/audio/transcriptions',
        model: 'whisper-large-v3-turbo',
      },
      secrets: { apiKey: 'groq-secret' },
    })
    sttStore.saveActiveSttProvider('default', 'custom')
    ttsStore.saveTtsProviderSetting('default', 'mimo', {
      settings: { model: 'mimo-v2.5-tts', voice: '冰糖' },
      secrets: { apiKey: 'mimo-secret' },
    })
    ttsStore.saveActiveTtsProvider('default', 'mimo')

    const { syncVoiceConfigToHermesProfile } = await import('../../packages/server/src/services/hermes/voice-config-sync')
    await expect(syncVoiceConfigToHermesProfile('default')).resolves.toEqual({
      stt: 'hermes-studio',
      tts: 'hermes-studio',
    })

    const config = await readConfig()
    expect(config.stt.provider).toBe('hermes-studio')
    expect(config.tts.provider).toBe('hermes-studio')
    expect(JSON.stringify(config)).not.toContain('groq-secret')
    expect(JSON.stringify(config)).not.toContain('mimo-secret')
    expect(await readFile(join(hermesHome, '.env'), 'utf-8')).toBe('KEEP_SECRET=keep\n')
  })

  it('uses a WAV command output for Gemini PCM audio', async () => {
    const ttsStore = await import('../../packages/server/src/db/hermes/tts-settings-store')
    ttsStore.saveTtsProviderSetting('default', 'gemini', {
      settings: {
        model: 'gemini-2.5-flash-preview-tts',
        voice: 'Kore',
      },
      secrets: { apiKey: 'gemini-secret' },
    })
    ttsStore.saveActiveTtsProvider('default', 'gemini')

    const { syncVoiceConfigToHermesProfile } = await import('../../packages/server/src/services/hermes/voice-config-sync')
    await syncVoiceConfigToHermesProfile('default')

    const config = await readConfig()
    expect(config.tts.provider).toBe('hermes-studio')
    expect(config.tts.providers['hermes-studio']).toMatchObject({
      output_format: 'wav',
      voice_compatible: true,
    })
  })
})
