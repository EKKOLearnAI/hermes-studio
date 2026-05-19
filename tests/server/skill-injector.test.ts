import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []
const originalHermesHome = process.env.HERMES_HOME
const originalSkillsDir = process.env.HERMES_WEB_UI_SKILLS_DIR

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.resetModules()
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = originalHermesHome
  if (originalSkillsDir === undefined) delete process.env.HERMES_WEB_UI_SKILLS_DIR
  else process.env.HERMES_WEB_UI_SKILLS_DIR = originalSkillsDir
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('HermesSkillInjector', () => {
  it('resolves source directories for override, production bundle, and development layouts', async () => {
    const root = await tempDir('hermes-skill-injector-paths-')
    const override = join(root, 'override-skills')
    const distSkills = join(root, 'dist', 'skills')
    const devSkills = join(root, 'packages', 'skills')
    await mkdir(override, { recursive: true })
    await mkdir(distSkills, { recursive: true })
    await mkdir(devSkills, { recursive: true })

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')

    expect(HermesSkillInjector.resolveSourceDir({ HERMES_WEB_UI_SKILLS_DIR: override } as any, join(root, 'dist', 'server'))).toBe(override)
    expect(HermesSkillInjector.resolveSourceDir({} as any, join(root, 'dist', 'server'))).toBe(distSkills)
    expect(HermesSkillInjector.resolveSourceDir({} as any, join(root, 'packages', 'server', 'src', 'services', 'hermes'))).toBe(devSkills)
  })

  it('syncs bundled skills and replaces existing bundled copies', async () => {
    const source = await tempDir('hermes-skill-source-')
    const hermesHome = await tempDir('hermes-skill-home-')
    process.env.HERMES_HOME = hermesHome

    await mkdir(join(source, 'new-skill'), { recursive: true })
    await writeFile(join(source, 'new-skill', 'SKILL.md'), '# New Skill\n', 'utf-8')
    await mkdir(join(source, 'existing-skill'), { recursive: true })
    await writeFile(join(source, 'existing-skill', 'SKILL.md'), '# Bundled Existing\n', 'utf-8')

    await mkdir(join(hermesHome, 'skills', 'existing-skill'), { recursive: true })
    await writeFile(join(hermesHome, 'skills', 'existing-skill', 'SKILL.md'), '# User Existing\n', 'utf-8')

    const { HermesSkillInjector } = await import('../../packages/server/src/services/hermes/skill-injector')
    const result = await new HermesSkillInjector(source).injectMissingSkills()

    expect(result.injected).toEqual(['new-skill'])
    expect(result.updated).toEqual(['existing-skill'])
    expect(result.skipped).toEqual([])
    await expect(readFile(join(hermesHome, 'skills', 'new-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# New Skill\n')
    await expect(readFile(join(hermesHome, 'skills', 'existing-skill', 'SKILL.md'), 'utf-8')).resolves.toBe('# Bundled Existing\n')
  })
})
