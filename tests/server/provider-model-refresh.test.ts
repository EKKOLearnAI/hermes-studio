import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let hermesHome = ''
let webUiHome = ''
const originalHermesHome = process.env.HERMES_HOME
const originalWebUiHome = process.env.HERMES_WEB_UI_HOME

function profileDir(profile: string): string {
  return profile === 'default' ? hermesHome : join(hermesHome, 'profiles', profile)
}

function writeProfile(profile: string, config: string, env = '') {
  const dir = profileDir(profile)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.yaml'), config, 'utf8')
  writeFileSync(join(dir, '.env'), env, 'utf8')
  writeFileSync(join(dir, 'auth.json'), '{}\n', 'utf8')
}

async function loadRefresh() {
  return import('../../packages/server/src/services/hermes/provider-model-refresh')
}

beforeEach(() => {
  hermesHome = mkdtempSync(join(tmpdir(), 'provider-refresh-hermes-'))
  webUiHome = mkdtempSync(join(tmpdir(), 'provider-refresh-webui-'))
  process.env.HERMES_HOME = hermesHome
  process.env.HERMES_WEB_UI_HOME = webUiHome
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  rmSync(hermesHome, { recursive: true, force: true })
  rmSync(webUiHome, { recursive: true, force: true })
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalWebUiHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalWebUiHome
})

describe('provider model refresh', () => {
  it('requires confirmation when remote list would delete models, then applies authoritatively', async () => {
    const credential = ['refresh', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:refreshable',
      '  default: keep-model',
      'custom_providers:',
      '  - name: refreshable',
      '    base_url: https://refresh.example/v1',
      `    api_key: ${credential}`,
      '    model: keep-model',
      '',
    ].join('\n'))

    // Seed an older list by first applying a list with extra model.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'keep-model' }, { id: 'old-model' }, { id: 'new-model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'keep-model' }, { id: 'new-model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'keep-model' }, { id: 'new-model' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const { refreshProviderModels, restoreProviderModels } = await loadRefresh()
    const seeded = await refreshProviderModels('research', 'custom:refreshable', { confirm: true })
    expect(seeded.applied).toBe(true)
    expect(seeded.models).toEqual(expect.arrayContaining(['keep-model', 'old-model', 'new-model']))

    const preview = await refreshProviderModels('research', 'custom:refreshable')
    expect(preview.applied).toBe(false)
    expect(preview.requires_confirmation).toBe(true)
    expect(preview.diff.removed).toContain('old-model')

    const applied = await refreshProviderModels('research', 'custom:refreshable', { confirm: true })
    expect(applied.applied).toBe(true)
    expect(applied.models).toEqual(expect.arrayContaining(['keep-model', 'new-model']))
    expect(applied.models).not.toContain('old-model')
    expect(applied.restore_available).toBe(true)

    const restored = await restoreProviderModels('research', 'custom:refreshable')
    expect(restored.applied).toBe(true)
    expect(restored.models).toEqual(expect.arrayContaining(['keep-model', 'old-model', 'new-model']))
  })

  it('treats empty remote catalogs as failure and preserves the old list', async () => {
    const credential = ['empty', 'credential'].join('-')
    writeProfile('research', [
      'model:',
      '  provider: custom:empty-refresh',
      '  default: model-a',
      'custom_providers:',
      '  - name: empty-refresh',
      '    base_url: https://empty.example/v1',
      `    api_key: ${credential}`,
      '    model: model-a',
      '',
    ].join('\n'))

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: 'model-a' }, { id: 'model-b' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const { refreshProviderModels } = await loadRefresh()
    const seeded = await refreshProviderModels('research', 'custom:empty-refresh', { confirm: true })
    expect(seeded.models).toEqual(expect.arrayContaining(['model-a', 'model-b']))

    await expect(refreshProviderModels('research', 'custom:empty-refresh', { confirm: true }))
      .rejects.toMatchObject({ code: 'PROVIDER_EMPTY_CATALOG' })

    const cachePath = join(webUiHome, 'cache', 'provider-model-catalog.json')
    const cache = JSON.parse(readFileSync(cachePath, 'utf8'))
    const entry = Object.values(cache.providers as Record<string, any>).find((item: any) => item.provider === 'custom:empty-refresh')
    expect(entry.models).toEqual(expect.arrayContaining(['model-a', 'model-b']))
  })
})
