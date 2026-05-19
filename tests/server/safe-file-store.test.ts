import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'js-yaml'
import { SafeFileStore } from '../../packages/server/src/services/safe-file-store'

const tempDirs: string[] = []

async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-safe-file-store-'))
  tempDirs.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SafeFileStore', () => {
  it('serializes concurrent YAML read-modify-write updates for the same file', async () => {
    const store = new SafeFileStore()
    const file = await tempFile('config.yaml')
    await writeFile(file, 'model:\n  default: old\n', 'utf-8')

    await Promise.all([
      store.updateYaml(file, async (cfg) => {
        await new Promise(resolve => setTimeout(resolve, 25))
        cfg.model.default = 'glm-5.1'
        return cfg
      }),
      store.updateYaml(file, (cfg) => {
        cfg.platforms = cfg.platforms || {}
        cfg.platforms.api_server = { extra: { port: 8648 } }
        return cfg
      }),
    ])

    const result = YAML.load(await readFile(file, 'utf-8')) as any
    expect(result.model.default).toBe('glm-5.1')
    expect(result.platforms.api_server.extra.port).toBe(8648)
  })

  it('backs up the previous content and writes through a temporary file', async () => {
    const store = new SafeFileStore()
    const file = await tempFile('config.yaml')
    await writeFile(file, 'model:\n  default: old\n', 'utf-8')

    await store.writeText(file, 'model:\n  default: new\n', { backup: true })

    await expect(readFile(`${file}.bak`, 'utf-8')).resolves.toContain('default: old')
    await expect(readFile(file, 'utf-8')).resolves.toContain('default: new')
  })
})
