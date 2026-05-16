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
})
