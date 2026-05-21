import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadHelpers() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/services/config-helpers')
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-helpers-'))
  tempHomes.push(hermesHome)
  await mkdir(hermesHome, { recursive: true })
})

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  await Promise.all(tempHomes.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  hermesHome = ''
})

describe('config-helpers locked file updates', () => {
  it('merges concurrent config.yaml updates by re-reading under the file lock', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), 'model:\n  default: old\n', 'utf-8')
    const { updateConfigYaml } = await loadHelpers()

    await Promise.all([
      updateConfigYaml(async (cfg) => {
        await new Promise(resolve => setTimeout(resolve, 25))
        cfg.model.default = 'glm-5.1'
        return cfg
      }),
      updateConfigYaml((cfg) => {
        cfg.platforms = cfg.platforms || {}
        cfg.platforms.api_server = { extra: { port: 8648 } }
        return cfg
      }),
    ])

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model.default).toBe('glm-5.1')
    expect(config.platforms.api_server.extra.port).toBe(8648)
    await expect(readFile(join(hermesHome, 'config.yaml.bak'), 'utf-8')).resolves.toContain('model:')
  })

  it('serializes concurrent .env updates without losing keys', async () => {
    await writeFile(join(hermesHome, '.env'), 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { saveEnvValue } = await loadHelpers()

    await Promise.all([
      saveEnvValue('DEEPSEEK_API_KEY', 'deepseek'),
      saveEnvValue('MOONSHOT_API_KEY', 'moonshot'),
    ])

    const env = await readFile(join(hermesHome, '.env'), 'utf-8')
    expect(env).toContain('OPENROUTER_API_KEY=keep')
    expect(env).toContain('DEEPSEEK_API_KEY=deepseek')
    expect(env).toContain('MOONSHOT_API_KEY=moonshot')
  })

  it('rejects invalid .env keys instead of writing keyless lines', async () => {
    const envPath = join(hermesHome, '.env')
    await writeFile(envPath, 'OPENROUTER_API_KEY=keep\n', 'utf-8')
    const { saveEnvValue } = await loadHelpers()

    await expect(saveEnvValue('', 'leaked-value')).rejects.toThrow('Invalid .env key')
    await expect(saveEnvValue('=BROKEN', 'leaked-value')).rejects.toThrow('Invalid .env key')

    const env = await readFile(envPath, 'utf-8')
    expect(env).toBe('OPENROUTER_API_KEY=keep\n')
    expect(env).not.toContain('=leaked-value')
  })

  it('skips writing config.yaml when an updater returns write false', async () => {
    const configPath = join(hermesHome, 'config.yaml')
    await writeFile(configPath, 'model:\n  default: old\n', 'utf-8')
    const before = await readFile(configPath, 'utf-8')
    const { updateConfigYaml } = await loadHelpers()

    const result = await updateConfigYaml((cfg) => ({ data: cfg, result: 'unchanged', write: false }))

    expect(result).toBe('unchanged')
    await expect(readFile(configPath, 'utf-8')).resolves.toBe(before)
    await expect(readFile(`${configPath}.bak`, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('strips api_server config before gateway restart', async () => {
    const { stripLegacyApiServerGatewayConfig } = await loadHelpers()
    const result = stripLegacyApiServerGatewayConfig({
      model: { default: 'glm-5.1' },
      platforms: {
        api_server: {
          enabled: true,
          key: '',
          cors_origins: '*',
          extra: {
            port: 8642,
            host: '127.0.0.1',
          },
        },
        feishu: {
          enabled: true,
        },
      },
    })

    expect(result.changed).toBe(true)
    expect(result.config).toEqual({
      model: { default: 'glm-5.1' },
      platforms: {
        feishu: {
          enabled: true,
        },
      },
    })
  })

  it('removes custom api_server fields as well', async () => {
    const { stripLegacyApiServerGatewayConfig } = await loadHelpers()
    const result = stripLegacyApiServerGatewayConfig({
      platforms: {
        api_server: {
          key: 'custom-key',
          cors_origins: 'https://example.com',
          extra: {
            port: 8642,
            host: '127.0.0.1',
            mode: 'custom',
          },
        },
      },
    })

    expect(result.changed).toBe(true)
    expect(result.config).toEqual({})
  })

  it('extracts model groups from newer Hermes providers config entries', async () => {
    const { listConfiguredProviderModels, buildModelGroups } = await loadHelpers()
    const config = {
      model: { default: 'custom-model-pro', provider: 'customrelay' },
      providers: {
        customrelay: {
          name: 'Custom Relay',
          base_url: 'https://relay.example/v1',
          key_env: 'CUSTOM_RELAY_API_KEY',
          default_model: 'custom-model-pro',
          models: {
            'custom-model-pro': { reasoning_effort: 'xhigh' },
            'custom-model-lite': {},
          },
        },
      },
    }

    expect(listConfiguredProviderModels(config)).toEqual([
      {
        provider: 'customrelay',
        label: 'Custom Relay',
        base_url: 'https://relay.example/v1',
        key_env: 'CUSTOM_RELAY_API_KEY',
        models: ['custom-model-pro', 'custom-model-lite'],
      },
    ])
    expect(buildModelGroups(config)).toEqual({
      default: 'custom-model-pro',
      groups: [
        {
          provider: 'customrelay',
          models: [
            { id: 'custom-model-pro', label: 'Custom Relay: custom-model-pro' },
            { id: 'custom-model-lite', label: 'Custom Relay: custom-model-lite' },
          ],
        },
      ],
    })
  })

  it('normalizes configured providers without trusting invalid key_env names', async () => {
    const { listConfiguredProviderModels } = await loadHelpers()
    expect(listConfiguredProviderModels({
      model: { model: 'fallback-model', provider: 'relay' },
      providers: {
        relay: {
          key_env: 'CUSTOM_RELAY_API_KEY|MALICIOUS',
        },
      },
    })).toEqual([
      {
        provider: 'relay',
        label: 'relay',
        base_url: '',
        key_env: '',
        models: ['fallback-model'],
      },
    ])
  })
})
