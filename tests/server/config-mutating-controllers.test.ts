import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import YAML from 'js-yaml'

vi.mock('../../packages/server/src/services/hermes/hermes-cli', () => ({
  pinSkill: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/sessions-db', () => ({
  getSkillUsageStatsFromDb: vi.fn(),
}))

vi.mock('../../packages/server/src/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('../../packages/server/src/db/hermes/schemas', () => ({
  MODEL_CONTEXT_TABLE: 'model_context',
}))

const originalHermesHome = process.env.HERMES_HOME
const tempHomes: string[] = []
let hermesHome = ''

async function loadModelsController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/models')
}

async function loadSkillsController() {
  vi.resetModules()
  process.env.HERMES_HOME = hermesHome
  return import('../../packages/server/src/controllers/hermes/skills')
}

function makeCtx(body: unknown): any {
  return { request: { body }, status: 200, body: undefined, query: {}, params: {} }
}

beforeEach(async () => {
  hermesHome = await mkdtemp(join(tmpdir(), 'hermes-config-controller-'))
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

describe('config mutating controllers', () => {
  it('setConfigModel updates only the model section and preserves existing config', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'terminal:',
      '  backend: local',
      'model:',
      '  default: old',
      '  provider: old-provider',
      '',
    ].join('\n'), 'utf-8')
    const { setConfigModel } = await loadModelsController()
    const ctx = makeCtx({ default: 'glm-5.1', provider: 'custom:glm' })

    await setConfigModel(ctx)

    expect(ctx.body).toEqual({ success: true })
    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model).toEqual({ default: 'glm-5.1', provider: 'custom:glm' })
    expect(config.terminal.backend).toBe('local')
  })

  it('skill toggle preserves unrelated config while adding and removing disabled skills', async () => {
    await writeFile(join(hermesHome, 'config.yaml'), [
      'model:',
      '  default: glm-5.1',
      'skills:',
      '  disabled:',
      '    - old-skill',
      '',
    ].join('\n'), 'utf-8')
    const { toggle } = await loadSkillsController()

    await toggle(makeCtx({ name: 'new-skill', enabled: false }))
    await toggle(makeCtx({ name: 'old-skill', enabled: true }))

    const config = YAML.load(await readFile(join(hermesHome, 'config.yaml'), 'utf-8')) as any
    expect(config.model.default).toBe('glm-5.1')
    expect(config.skills.disabled).toEqual(['new-skill'])
  })
})
