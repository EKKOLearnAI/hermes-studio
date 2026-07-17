import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let appHome = ''
const originalAppHome = process.env.HERMES_WEB_UI_HOME

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), 'app-config-lock-'))
  process.env.HERMES_WEB_UI_HOME = appHome
  vi.resetModules()
})

afterEach(() => {
  vi.resetModules()
  rmSync(appHome, { recursive: true, force: true })
  if (originalAppHome === undefined) delete process.env.HERMES_WEB_UI_HOME
  else process.env.HERMES_WEB_UI_HOME = originalAppHome
})

describe('app config writes', () => {
  it('merges concurrent patches by reading under the shared file lock', async () => {
    const { writeAppConfig } = await import('../../packages/server/src/services/app-config')

    await Promise.all([
      writeAppConfig({ modelAliases: { deepseek: { model: 'Alias' } } }),
      writeAppConfig({ providerLabels: { research: { deepseek: 'Research DeepSeek' } } }),
    ])

    const stored = JSON.parse(readFileSync(join(appHome, 'config.json'), 'utf8'))
    expect(stored.modelAliases).toEqual({ deepseek: { model: 'Alias' } })
    expect(stored.providerLabels).toEqual({ research: { deepseek: 'Research DeepSeek' } })
  })
})
