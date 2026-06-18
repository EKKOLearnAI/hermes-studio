import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('STT provider settings schema', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  async function initStores(): Promise<void> {
    const { initAllStores } = await import('../../packages/server/src/db/hermes/init')
    initAllStores()
  }

  function tableNames(): string[] {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row: any) => row.name)
  }

  it('creates stt_provider_settings table during store init', async () => {
    await initStores()

    expect(tableNames()).toContain('stt_provider_settings')
    const columns = db.prepare('PRAGMA table_info(stt_provider_settings)').all().map((row: any) => row.name)
    expect(columns).toEqual(expect.arrayContaining([
      'id',
      'user_id',
      'provider',
      'settings_json',
      'secrets_json',
      'created_at',
      'updated_at',
    ]))
  })

  it('rejects duplicate provider settings for the same user', async () => {
    await initStores()

    const insert = db.prepare('INSERT INTO stt_provider_settings (user_id, provider) VALUES (?, ?)')
    insert.run(1, 'openai')

    expect(() => insert.run(1, 'openai')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows the same provider for different users', async () => {
    await initStores()

    const insert = db.prepare('INSERT INTO stt_provider_settings (user_id, provider) VALUES (?, ?)')
    insert.run(1, 'openai')

    expect(() => insert.run(2, 'openai')).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM stt_provider_settings WHERE provider = ?').get('openai').count).toBe(2)
  })

  it('migrates legacy stt_provider_settings tables that still default user_id to 0', async () => {
    db.exec(`
      CREATE TABLE stt_provider_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT 0,
        provider TEXT NOT NULL,
        settings_json TEXT NOT NULL DEFAULT '{}',
        secrets_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `)
    db.exec('CREATE INDEX idx_stt_provider_settings_user ON stt_provider_settings(user_id)')
    db.exec('CREATE UNIQUE INDEX idx_stt_provider_settings_user_provider ON stt_provider_settings(user_id, provider)')
    db.prepare(
      'INSERT INTO stt_provider_settings (user_id, provider, settings_json, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(7, 'deepgram', '{"language":"en"}', '{"apiKey":"secret"}', 1710000000, 1710000100)

    await initStores()

    const userIdColumn = db.prepare('PRAGMA table_info(stt_provider_settings)').all().find((row: any) => row.name === 'user_id')
    expect(userIdColumn?.dflt_value).toBeNull()

    const insertWithoutUserId = db.prepare('INSERT INTO stt_provider_settings (provider) VALUES (?)')
    expect(() => insertWithoutUserId.run('openai')).toThrow(/NOT NULL constraint failed: stt_provider_settings\.user_id/)

    const preservedRow = db.prepare('SELECT * FROM stt_provider_settings WHERE user_id = ? AND provider = ?').get(7, 'deepgram')
    expect(preservedRow).toMatchObject({
      user_id: 7,
      provider: 'deepgram',
      settings_json: '{"language":"en"}',
      secrets_json: '{"apiKey":"secret"}',
      created_at: 1710000000,
      updated_at: 1710000100,
    })
  })

  it('rejects inserts that omit user_id', async () => {
    await initStores()

    const insertWithoutUserId = db.prepare('INSERT INTO stt_provider_settings (provider) VALUES (?)')

    expect(() => insertWithoutUserId.run('openai')).toThrow(/NOT NULL constraint failed: stt_provider_settings\.user_id/)
  })
})

describe('stt settings store', () => {
  let db: any = null

  beforeEach(async () => {
    vi.resetModules()
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(':memory:')
    vi.doMock('../../packages/server/src/db/index', () => ({
      getDb: () => db,
      getStoragePath: () => ':memory:',
    }))
  })

  afterEach(() => {
    db?.close()
    db = null
    vi.doUnmock('../../packages/server/src/db/index')
    vi.resetModules()
  })

  async function initStore() {
    const schemas = await import('../../packages/server/src/db/hermes/schemas')
    schemas.initAllHermesTables()
    return {
      schemas,
      store: await import('../../packages/server/src/db/hermes/stt-settings-store'),
    }
  }

  it('stores settings and masks secrets on read', async () => {
    const { store } = await initStore()

    const saved = store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })

    expect(saved).toMatchObject({
      userId: 7,
      provider: 'openai',
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: '[stored]',
      },
    })
    expect(JSON.stringify(saved)).not.toContain('secret-value')

    const fetched = store.getSttProviderSetting(7, 'openai')
    expect(fetched).toEqual(saved)
    expect(JSON.stringify(fetched)).not.toContain('secret-value')
  })

  it('returns raw secrets only for backend callers that opt in', async () => {
    const { store } = await initStore()

    store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })

    expect(store.getSttProviderSetting(7, 'openai', { includeSecrets: true })).toMatchObject({
      userId: 7,
      provider: 'openai',
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })
  })

  it('preserves existing raw secrets when the stored marker is submitted again', async () => {
    const { store } = await initStore()

    store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })

    const updated = store.saveSttProviderSetting(7, 'openai', {
      settings: {
        language: 'en',
        prompt: 'Transcribe carefully',
      },
      secrets: {
        apiKey: '[stored]',
      },
    })

    expect(updated).toMatchObject({
      userId: 7,
      provider: 'openai',
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
        language: 'en',
        prompt: 'Transcribe carefully',
      },
      secrets: {
        apiKey: '[stored]',
      },
    })

    expect(store.getSttProviderSetting(7, 'openai', { includeSecrets: true })?.secrets).toEqual({
      apiKey: 'secret-value',
    })
  })

  it('trims and bounds prompt length to 1000 characters', async () => {
    const { store } = await initStore()
    const trimmedPrompt = 'x'.repeat(1000)

    const saved = store.saveSttProviderSetting(7, 'openai', {
      settings: {
        prompt: `  ${trimmedPrompt}extra  `,
      },
    })

    expect(saved.settings.prompt).toBe(trimmedPrompt)
    expect(saved.settings.prompt).toHaveLength(1000)

    const storedRow = db.prepare(
      'SELECT settings_json FROM stt_provider_settings WHERE user_id = ? AND provider = ?'
    ).get(7, 'openai') as { settings_json: string }

    expect(JSON.parse(storedRow.settings_json)).toMatchObject({
      prompt: trimmedPrompt,
    })
  })

  it('clears one stored secret without deleting settings', async () => {
    const { store } = await initStore()

    store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })

    const cleared = store.clearStoredSttSecret(7, 'openai', 'apiKey')
    expect(cleared).toMatchObject({
      userId: 7,
      provider: 'openai',
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
        language: 'en',
      },
      secrets: {},
    })

    expect(store.getSttProviderSetting(7, 'openai')).toEqual(cleared)
    expect(store.getSttProviderSetting(7, 'openai', { includeSecrets: true })?.secrets).toEqual({})
  })

  it('lists only settings for the requested user', async () => {
    const { store } = await initStore()

    const expected = store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })

    store.saveSttProviderSetting(8, 'custom', {
      settings: {
        baseUrl: 'https://transcribe.example.com/v1',
        model: 'custom-whisper',
      },
      secrets: {
        apiKey: 'other-secret',
      },
    })

    expect(store.listSttProviderSettings(7)).toEqual([expected])
  })

  it('ignores unsupported legacy provider rows when listing settings', async () => {
    const { store } = await initStore()

    const expected = store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
        model: 'gpt-4o-transcribe',
      },
      secrets: {
        apiKey: 'secret-value',
      },
    })

    db.prepare(
      'INSERT INTO stt_provider_settings (user_id, provider, settings_json, secrets_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(7, 'deepgram', '{"language":"en"}', '{"apiKey":"legacy-secret"}', 1710000000, 1710000100)

    expect(() => store.listSttProviderSettings(7)).not.toThrow()
    expect(store.listSttProviderSettings(7)).toEqual([expected])
    expect(() => store.getSttProviderSetting(7, 'deepgram' as any)).toThrow(/unknown STT provider/i)
  })

  it('rejects unsupported providers and secret names', async () => {
    const { store } = await initStore()

    expect(() => {
      store.saveSttProviderSetting(7, 'deepgram', {
        settings: {
          model: 'nova-2',
        },
      })
    }).toThrow(/unknown STT provider/i)

    expect(() => {
      store.saveSttProviderSetting(7, 'openai', {
        secrets: {
          token: 'secret-value',
        },
      })
    }).toThrow(/unknown STT provider secret/i)
  })

  it.each([
    'http://10.0.0.1:8000/v1/audio/transcriptions',
    'http://172.16.0.1:8000/v1/audio/transcriptions',
    'http://192.168.1.1:8000/v1/audio/transcriptions',
    'http://127.0.0.1:8000/v1/audio/transcriptions',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8000/v1/audio/transcriptions',
    'http://[fd00::1]:8000/v1/audio/transcriptions',
    'http://[fe90::1]:8000/v1/audio/transcriptions',
  ])('allows local or private base urls using the shared url rules: %s', async (baseUrl) => {
    const { store } = await initStore()

    const saved = store.saveSttProviderSetting(7, 'openai', {
      settings: {
        baseUrl,
      },
    })

    expect(saved.settings.baseUrl).toContain(new URL(baseUrl).origin)
  })

  it('stores only supported audio transcode modes', async () => {
    const { store } = await initStore()

    const saved = store.saveSttProviderSetting(7, 'custom', {
      settings: {
        baseUrl: 'http://127.0.0.1:8000/v1',
        model: 'whisper-1',
        audioTranscode: 'ffmpeg',
      },
    })
    expect(saved.settings.audioTranscode).toBe('ffmpeg')

    const ignored = store.saveSttProviderSetting(7, 'custom', {
      settings: {
        audioTranscode: 'auto',
      },
    })
    expect(ignored.settings.audioTranscode).toBe('ffmpeg')
  })
})
